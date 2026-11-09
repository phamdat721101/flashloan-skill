import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutionLock } from '../execution-lock.js';
import {
  FinanceError, assetKey, canonicalDigest, financeHash, insist, strictParse,
  type Account, type ActionState, type Amount, type ApprovalGrant, type Digest, type LocalPlan, type Plan, type Receipt, type Simulation,
} from './contracts.js';

/** Internal journal records; never part of the wire contract. */
export interface ActionRecord {
  actionId: Digest; planHash: Digest; localPlanHash: Digest; grantId: Digest; account: Account; network: LocalPlan['network']; sender: string;
  state: ActionState; transactionId: string | null; nativeSequence: string; reservation: Amount[]; day: string;
  reconciliation: Receipt['reconciliation']; effects: Amount[];
}
export type EventKind = 'plan' | 'local-plan' | 'grant' | 'action' | 'transition' | 'halt';
interface JournalEvent { sequence: number; previousHash: Digest; occurredAt: string; kind: EventKind; data: unknown; eventHash: Digest }
export interface JournalState {
  plans: Map<Digest, Plan>; localPlans: Map<Digest, { plan: LocalPlan; simulation: Simulation }>; grants: Map<Digest, ApprovalGrant>;
  usedNonces: Set<Digest>; consumedGrants: Set<Digest>; actions: Map<Digest, ActionRecord>; halted: Map<string, string>; events: number; lastHash: Digest;
}
const ZERO = '0'.repeat(64);
const OPEN_STATES = new Set<ActionState>(['SUBMITTING', 'SUBMITTED', 'INCLUDED', 'UNKNOWN']);
const TRANSITIONS: Record<ActionState, ActionState[]> = {
  PREPARED: [], SIMULATED: [], AWAITING_APPROVAL: ['SUBMITTING', 'FAILED', 'EXPIRED'],
  SUBMITTING: ['SUBMITTED', 'FAILED', 'UNKNOWN'], SUBMITTED: ['INCLUDED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'UNKNOWN', 'HALTED'],
  INCLUDED: ['CONFIRMED', 'FINALIZED', 'FAILED', 'UNKNOWN', 'HALTED'], CONFIRMED: ['FINALIZED', 'HALTED', 'UNKNOWN'],
  UNKNOWN: ['SUBMITTED', 'INCLUDED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'HALTED'], FINALIZED: ['HALTED'], FAILED: [], EXPIRED: [], HALTED: [],
};
export const accountKey = (a: Account, network: string) => canonicalDigest({ network, family: a.family, address: a.address.toLowerCase() });

/**
 * Append-only, hash-chained, fsynced owner journal. Every external effect is preceded by a durable
 * event; recovery rebuilds state only from this file. Deleting it never rolls back a chain action.
 */
export class FinanceJournal {
  readonly path: string;
  constructor(readonly directory: string, readonly now: () => number = Date.now) { this.path = join(directory, 'journal.jsonl'); }

  /** Short exclusive section for appends; waits briefly because appends are small. */
  private async appendLock<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await new ExecutionLock(this.path + '.lock').runExclusive(fn); }
      catch (e) { if (!(e instanceof Error) || !e.message.includes('already in progress') || attempt >= 100) throw e; await new Promise(r => setTimeout(r, 20)); }
    }
  }
  /** Account+network write lease. A second process is blocked immediately, never queued behind an unknown send. */
  async lease<T>(account: Account, network: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(join(this.directory, 'leases'), { recursive: true, mode: 0o700 });
    try { return await new ExecutionLock(join(this.directory, 'leases', accountKey(account, network) + '.lock')).runExclusive(fn); }
    catch (e) { if (e instanceof Error && e.message.includes('already in progress')) throw new FinanceError('IDEMPOTENCY_CONFLICT', 'account-lease-held'); throw e; }
  }

  async state(): Promise<JournalState> {
    let text = '';
    try { text = await readFile(this.path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    insist(!text || text.endsWith('\n'), 'RECONCILIATION_MISMATCH', 'journal-torn-write');
    const s: JournalState = { plans: new Map(), localPlans: new Map(), grants: new Map(), usedNonces: new Set(), consumedGrants: new Set(), actions: new Map(), halted: new Map(), events: 0, lastHash: ZERO };
    let previous = ZERO;
    for (const line of text ? text.trimEnd().split('\n') : []) {
      const e = strictParse(Buffer.from(line)) as JournalEvent;
      const { eventHash, ...body } = e;
      insist(e.sequence === s.events + 1 && e.previousHash === previous && financeHash('event', body) === eventHash, 'RECONCILIATION_MISMATCH', 'journal-hash');
      apply(s, e.kind, e.data);
      s.events++; previous = eventHash;
    }
    s.lastHash = previous;
    return s;
  }
  async append(kind: EventKind, data: unknown): Promise<JournalState> {
    return this.appendLock(async () => {
      const s = await this.state();
      apply(structuredClone(s), kind, data); // reject an invalid transition before it becomes durable
      const body = { sequence: s.events + 1, previousHash: s.lastHash, occurredAt: new Date(this.now()).toISOString(), kind, data };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const f = await open(this.path, 'a', 0o600);
      try { await f.writeFile(JSON.stringify({ ...body, eventHash: financeHash('event', body) }) + '\n'); await f.sync(); } finally { await f.close(); }
      const d = await open(this.directory, 'r'); try { await d.sync(); } finally { await d.close(); }
      const eventHash = financeHash('event', body);
      apply(s, kind, data); s.events++; s.lastHash = eventHash;
      return s;
    });
  }
  /** Pre-broadcast signed material lives only in the owner store (0600), never in MCP payloads or logs. */
  async storeSigned(actionId: Digest, signed: string): Promise<void> {
    const dir = join(this.directory, 'signed'); await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `${actionId}.tmp`), f = await open(tmp, 'w', 0o600);
    try { await f.writeFile(signed); await f.sync(); } finally { await f.close(); }
    await rename(tmp, join(dir, actionId));
  }
  async readSigned(actionId: Digest): Promise<string | null> { return readFile(join(this.directory, 'signed', actionId), 'utf8').catch(() => null); }
}

function apply(s: JournalState, kind: EventKind, data: unknown): void {
  const d = data as Record<string, unknown>;
  switch (kind) {
    case 'plan': { const p = d as unknown as Plan; if (!s.plans.has(p.planHash)) s.plans.set(p.planHash, p); break; }
    case 'local-plan': { const x = d as unknown as { plan: LocalPlan; simulation: Simulation }; insist(s.plans.has(x.plan.researchPlanHash), 'INVALID_INPUT', 'unknown-research-plan'); s.localPlans.set(x.plan.localPlanHash, x); break; }
    case 'grant': { const g = d as unknown as ApprovalGrant; insist(!s.grants.has(g.grantId) && !s.usedNonces.has(g.nonce), 'APPROVAL_REPLAY'); s.grants.set(g.grantId, g); s.usedNonces.add(g.nonce); break; }
    case 'action': {
      const a = d as unknown as ActionRecord;
      insist(s.grants.has(a.grantId) && !s.consumedGrants.has(a.grantId), 'APPROVAL_REPLAY');
      insist(!s.actions.has(a.actionId) && a.state === 'SUBMITTING', 'APPROVAL_REPLAY', 'action-exists');
      admitNewAction(s, a);
      s.consumedGrants.add(a.grantId); s.actions.set(a.actionId, structuredClone(a)); break;
    }
    case 'transition': {
      const a = s.actions.get(d.actionId as Digest); insist(a, 'INVALID_INPUT', 'unknown-action');
      const to = d.state as ActionState; insist(to === a.state || TRANSITIONS[a.state].includes(to), 'RECONCILIATION_MISMATCH', `transition:${a.state}->${to}`);
      a.state = to;
      if (d.transactionId !== undefined) { insist(a.transactionId === null || a.transactionId === d.transactionId, 'RECONCILIATION_MISMATCH', 'tx-id-changed'); a.transactionId = d.transactionId as string; }
      if (d.reconciliation) a.reconciliation = d.reconciliation as Receipt['reconciliation'];
      if (d.effects) a.effects = d.effects as Amount[];
      if (to === 'HALTED' || d.reconciliation === 'MISMATCH') s.halted.set(accountKey(a.account, a.network), a.actionId);
      break;
    }
    case 'halt': s.halted.set(d.accountKey as string, d.reason as string); break;
  }
}

/**
 * One write at a time per account and per native sender (nonce/sequence space). Halted accounts, unresolved
 * sends and nonce reuse are rejected; runtime calls this before signer access as well as on append.
 */
export function admitNewAction(s: JournalState, a: Pick<ActionRecord, 'account' | 'network' | 'sender' | 'nativeSequence'>): void {
  const k = accountKey(a.account, a.network), sender = a.sender.toLowerCase();
  insist(!s.halted.has(k), 'RECONCILIATION_MISMATCH', 'account-halted');
  const related = [...s.actions.values()].filter(x => x.network === a.network && (accountKey(x.account, x.network) === k || x.sender.toLowerCase() === sender));
  insist(!related.some(x => OPEN_STATES.has(x.state)), 'SUBMISSION_UNKNOWN', 'unresolved-action');
  insist(!related.some(x => x.sender.toLowerCase() === sender && x.nativeSequence === a.nativeSequence && !(x.state === 'FAILED' && x.transactionId === null)), 'APPROVAL_REPLAY', 'nonce-reuse');
}

/** Reserved native cost for a UTC day; failed-before-send actions release, sent/unknown ones never do. */
export function reservedOnDay(s: JournalState, day: string, asset: Amount['asset']): bigint {
  let total = 0n;
  for (const a of s.actions.values()) {
    if (a.day !== day || (a.state === 'FAILED' && a.transactionId === null)) continue;
    for (const r of a.reservation) if (assetKey(r.asset) === assetKey(asset) && r.quantity.kind === 'atomic') total += BigInt(r.quantity.value);
  }
  return total;
}
