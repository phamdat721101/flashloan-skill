import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutionLock, recoverDeadExecutionLock } from '../execution-lock.js';
import { hash, insist, raw, validate, type ExecutionGrant, type FillRecord, type Hash, type LedgerEvent, type Limits, type Mode, type OrderObservation, type OrderRecord, type PositionSnapshot, type TradePlan } from './contracts.js';

export interface ChainOperation {
  operationId: Hash; action: 'approve' | 'redeem'; planHash: Hash | null; marketSlug: string; nonce: string;
  txHash: `0x${string}`; gasUpperRaw: string; day: string; status: 'pending' | 'confirmed' | 'failed'; grant: ExecutionGrant; mode: 'assisted' | 'autonomous';
}
export interface LedgerState {
  events: LedgerEvent[]; plans: Map<Hash, TradePlan>; orders: Map<string, OrderRecord>; chain: Map<Hash, ChainOperation>;
  halted: boolean; reason: string; redeemed: Set<string>; gasByDay: Map<string, bigint>;
}
const ZERO = `sha256:${'0'.repeat(64)}` as Hash;
const terminal = (o: OrderRecord) => ['filled', 'cancelled', 'rejected'].includes(o.state) && !['matched', 'mined', 'delayed', 'retrying', 'unknown'].includes(o.settlement);
export const publicOrder = (o: OrderRecord) => ({ planHash: o.plan.planHash, clientOrderId: o.plan.clientOrderId, orderId: o.orderId, submission: o.submission, state: o.state, settlement: o.settlement, fills: o.fills, mode: o.plan.mode, cancelRequested: o.cancelRequested });

/** One owner process per account; full checksummed replay is authoritative. No secrets or signed bytes. */
export class PredictionLedger {
  readonly path: string;
  constructor(readonly directory: string, readonly accountId: string, readonly mode: Mode, readonly now: () => number = Date.now) {
    this.path = join(directory, accountId, mode === 'paper' ? 'paper' : 'live', 'events.jsonl');
  }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> { return new ExecutionLock(this.path + '.lock').runExclusive(operation); }
  async recoverDeadLock(): Promise<boolean> { return recoverDeadExecutionLock(this.path + '.lock'); }
  async checkContinuation(plan: TradePlan, limits: Limits, cash: string, shares: string): Promise<void> {
    const s = await this.state(), active = [...s.orders.values()].filter(o => !terminal(o));
    const pending = active.filter(o => o.plan.intent.side === 'BUY').reduce((n, o) => {
      const spent = o.fills.reduce((a, f) => a + raw(f.usdGrossRaw) + raw(f.usdFeeRaw), 0n);
      return n + (raw(o.plan.reserveRaw) > spent ? raw(o.plan.reserveRaw) - spent : 0n);
    }, 0n);
    insist(pending <= raw(cash), 'INSUFFICIENT_AVAILABLE_BALANCE');
    if (plan.intent.side === 'SELL') {
      const reserved = active.filter(o => o.plan.order.tokenId === plan.order.tokenId && o.plan.intent.side === 'SELL').reduce((n, o) => n + BigInt(o.plan.order.makerAmount) - o.fills.reduce((a, f) => a + raw(f.sharesGrossRaw), 0n), 0n);
      insist(reserved <= raw(shares), 'INSUFFICIENT_AVAILABLE_SHARES');
    }
    const pnl = realizedForDay(s, new Date(this.now()).toISOString().slice(0, 10));
    insist(pnl >= 0n || -pnl < raw(limits.maxDailyLossRaw), 'DAILY_LOSS_LIMIT');
  }
  async state(): Promise<LedgerState> {
    let text: string; try { text = await readFile(this.path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') text = ''; else throw e; }
    insist(!text || text.endsWith('\n'), 'LEDGER_TORN_WRITE');
    const s: LedgerState = { events: [], plans: new Map(), orders: new Map(), chain: new Map(), halted: false, reason: 'none', redeemed: new Set(), gasByDay: new Map() };
    let previousHash = ZERO;
    for (const line of text.trim() ? text.trim().split('\n') : []) {
      let e: LedgerEvent; try { e = validate<LedgerEvent>('LedgerEvent', JSON.parse(line)); } catch { throw new Error('LEDGER_CORRUPT'); }
      const { eventHash, ...body } = e;
      insist(e.sequence === s.events.length + 1 && e.previousHash === previousHash && hash('event', body) === eventHash, 'LEDGER_HASH_MISMATCH');
      const d = e.data as Record<string, unknown>;
      switch (e.kind) {
        case 'plan': { const p = e.data as TradePlan; insist(p.accountId === this.accountId && (p.mode === 'paper') === (this.mode === 'paper'), 'LEDGER_ACCOUNT_MISMATCH'); insist(!s.plans.has(p.planHash), 'LEDGER_DUPLICATE_PLAN'); s.plans.set(p.planHash, p); break; }
        case 'reserve': { const r = e.data as OrderRecord; insist(s.plans.has(r.plan.planHash) && !s.orders.has(r.plan.clientOrderId), 'LEDGER_DUPLICATE_ORDER'); s.orders.set(r.plan.clientOrderId, r); break; }
        case 'dispatch': case 'unknown': { const r = s.orders.get(d.clientOrderId as string); insist(r, 'LEDGER_ORDER_MISSING'); r.submission = e.kind === 'dispatch' ? 'dispatching' : 'acceptance-unknown'; break; }
        case 'cancel-request': { const r = s.orders.get(d.clientOrderId as string); insist(r, 'LEDGER_ORDER_MISSING'); r.cancelRequested = true; break; }
        case 'observation': applyObservation(s, e.data as OrderObservation); break;
        case 'halt': s.halted = true; s.reason = d.reason as string; break;
        case 'resume': s.halted = false; s.reason = 'none'; break;
        case 'chain-pending': { const op = e.data as ChainOperation; insist(!s.chain.has(op.operationId) && ![...s.chain.values()].some(x => x.status === 'pending'), 'CHAIN_OPERATION_UNRESOLVED'); s.chain.set(op.operationId, op); break; }
        case 'chain-confirmed': { const op = s.chain.get(d.operationId as Hash); insist(op && op.status === 'pending', 'CHAIN_OPERATION_MISSING'); op.status = d.success ? 'confirmed' : 'failed'; s.gasByDay.set(op.day, (s.gasByDay.get(op.day) ?? 0n) + raw(d.gasUsedRaw as string)); break; }
        case 'redeemed': insist(s.chain.get(d.operationId as Hash)?.status === 'confirmed', 'REDEMPTION_UNCONFIRMED'); s.redeemed.add(d.marketSlug as string); break;
        case 'paper-redeemed': insist(this.mode === 'paper', 'PAPER_LEDGER_REQUIRED'); s.redeemed.add(d.marketSlug as string); break;
      }
      s.events.push(e); previousHash = e.eventHash;
    }
    return s;
  }
  /** Caller holds exclusive(); fsync completes before any external effect. */
  async append(kind: LedgerEvent['kind'], data: unknown): Promise<void> {
    const s = await this.state();
    const body = { schemaVersion: 'prediction-event/1' as const, sequence: s.events.length + 1, previousHash: s.events.at(-1)?.eventHash ?? ZERO, occurredAt: new Date(this.now()).toISOString(), kind, data };
    const event = validate<LedgerEvent>('LedgerEvent', { ...body, eventHash: hash('event', body) });
    if (kind === 'observation') { const projected = structuredClone(s); applyObservation(projected, data as OrderObservation); positionsFrom(projected); }
    await mkdir(join(this.path, '..'), { recursive: true });
    const f = await open(this.path, 'a', 0o600); try { await f.writeFile(JSON.stringify(event) + '\n'); await f.sync(); } finally { await f.close(); }
    const directory = await open(join(this.path, '..'), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  async reserve(plan: TradePlan, grant: ExecutionGrant | null, limits: Limits, availableUsdcRaw: string, availableSharesRaw: string): Promise<void> {
    const s = await this.state(); insist(!s.halted, 'ACCOUNT_HALTED');
    insist(![...s.orders.values()].some(o => ['dispatching', 'acceptance-unknown'].includes(o.submission) || o.settlement === 'unknown') && ![...s.chain.values()].some(x => x.status === 'pending'), 'RECOVERY_REQUIRED');
    insist(!s.orders.has(plan.clientOrderId) && ![...s.orders.values()].some(o => o.plan.intent.intentId === plan.intent.intentId), 'DUPLICATE_INTENT');
    const active = [...s.orders.values()].filter(o => !terminal(o)), day = new Date(this.now()).toISOString().slice(0, 10);
    const placedToday = s.events.filter(e => e.kind === 'reserve' && e.occurredAt.startsWith(day)).length;
    const sessionOrders = grant ? [...s.orders.values()].filter(o => o.grant?.grantId === grant.grantId) : [];
    insist(placedToday < limits.maxOrdersPerDay && sessionOrders.length < limits.maxOrdersPerDay && active.length < limits.maxOpenOrders, 'ORDER_LIMIT_EXHAUSTED');
    const positions = positionsFrom(s), heldCost = positions.reduce((n, p) => n + raw(p.costBasisRaw), 0n);
    const pendingCost = active.filter(o => o.plan.intent.side === 'BUY').reduce((n, o) => {
      const spent = o.fills.reduce((a, f) => a + raw(f.usdGrossRaw) + raw(f.usdFeeRaw), 0n); return n + (raw(o.plan.reserveRaw) > spent ? raw(o.plan.reserveRaw) - spent : 0n);
    }, 0n);
    const realized = realizedForDay(s, day), losses = realized < 0n ? -realized : 0n;
    insist(raw(plan.reserveRaw) <= raw(limits.maxOrderSpendRaw) && heldCost + pendingCost + raw(plan.reserveRaw) <= raw(limits.maxOpenExposureRaw), 'RISK_BUDGET_EXHAUSTED');
    insist(losses < raw(limits.maxDailyLossRaw), 'DAILY_LOSS_LIMIT');
    insist(pendingCost + raw(plan.reserveRaw) <= raw(availableUsdcRaw), 'INSUFFICIENT_AVAILABLE_BALANCE');
    if (plan.intent.side === 'SELL') {
      const token = plan.order.tokenId, reserved = active.filter(o => o.plan.intent.side === 'SELL' && o.plan.order.tokenId === token).reduce((n, o) => n + BigInt(o.plan.order.makerAmount) - o.fills.reduce((a, f) => a + raw(f.sharesGrossRaw), 0n), 0n);
      const balance = raw(availableSharesRaw);
      insist(balance >= reserved + BigInt(plan.order.makerAmount), 'INSUFFICIENT_AVAILABLE_SHARES');
    }
    await this.append('reserve', { plan, grant, submission: 'reserved', orderId: null, state: 'unknown', settlement: 'none', fills: [], cancelRequested: false } satisfies OrderRecord);
  }
}
function applyObservation(s: LedgerState, o: OrderObservation): void {
  const r = s.orders.get(o.clientOrderId); insist(r, 'LEDGER_ORDER_MISSING');
  insist(!r.orderId || r.orderId === o.orderId, 'ORDER_ID_CHANGED');
  const existing = new Map(r.fills.map(f => [f.fillId, f]));
  for (const f of o.fills) {
    insist(f.clientOrderId === o.clientOrderId && f.tokenId === r.plan.order.tokenId && f.marketSlug === r.plan.market.slug && f.side === r.plan.intent.side, 'FILL_BINDING_MISMATCH');
    const prior = existing.get(f.fillId); insist(!prior || hash('fill', prior) === hash('fill', f), 'FILL_ID_CHANGED'); existing.set(f.fillId, f);
  }
  const fills = [...existing.values()];
  const offered = fills.reduce((n, f) => n + raw(r.plan.intent.side === 'BUY' ? f.usdGrossRaw : f.sharesGrossRaw), 0n);
  insist(offered <= BigInt(r.plan.order.makerAmount), 'FILL_EXCEEDS_ORDER');
  const cost = fills.reduce((n, f) => n + raw(f.usdGrossRaw) + raw(f.usdFeeRaw), 0n);
  if (r.plan.intent.side === 'BUY') insist(cost <= raw(r.plan.reserveRaw), 'FEE_BOUND_EXCEEDED');
  for (const f of fills) {
    insist(raw(f.usdFeeRaw) <= raw(f.usdGrossRaw), 'FEE_BOUND_EXCEEDED');
    const rate = BigInt(r.plan.market.feeCapBps);
    const maximum = r.plan.intent.postOnly || !r.plan.market.feeEnabled ? 0n : (raw(f.usdGrossRaw) * rate + 9999n) / 10000n + 10n;
    insist(raw(f.usdFeeRaw) <= maximum, 'FEE_BOUND_EXCEEDED');
  }
  if (terminal(r)) insist(['filled', 'cancelled', 'rejected'].includes(o.state), 'TERMINAL_ORDER_REGRESSED');
  r.orderId = o.orderId; r.state = o.state; r.settlement = o.settlement; r.fills = fills;
  if (o.orderId || o.state === 'rejected') r.submission = 'acknowledged';
}
export function positionsFrom(state: LedgerState): PositionSnapshot[] {
  const lots = new Map<string, Array<{ shares: bigint; cost: bigint; market: string; fidelity: FillRecord['fidelity'] }>>(), realized = new Map<string, bigint>();
  const fills = [...state.orders.values()].flatMap(o => o.fills).sort((a, b) => a.fidelity === 'paper' ? a.occurredAt.localeCompare(b.occurredAt) : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
  for (const f of fills) {
    const list = lots.get(f.tokenId) ?? []; lots.set(f.tokenId, list);
    if (f.side === 'BUY') list.push({ shares: raw(f.sharesNetRaw), cost: raw(f.usdGrossRaw) + raw(f.usdFeeRaw), market: f.marketSlug, fidelity: f.fidelity });
    else {
      let remaining = raw(f.sharesGrossRaw), basis = 0n;
      for (const lot of list) { const take = lot.shares < remaining ? lot.shares : remaining; const part = lot.shares ? lot.cost * take / lot.shares : 0n; lot.shares -= take; lot.cost -= part; remaining -= take; basis += part; if (!remaining) break; }
      insist(remaining === 0n, 'POSITION_COST_BASIS_UNKNOWN'); realized.set(f.tokenId, (realized.get(f.tokenId) ?? 0n) + raw(f.usdGrossRaw) - raw(f.usdFeeRaw) - basis);
    }
  }
  for (const e of state.events.filter(e => e.kind === 'redeemed' || e.kind === 'paper-redeemed')) {
    const redemption = e.data as { marketSlug: string; payouts: Array<{ tokenId: string; payoutRaw: string }> };
    for (const p of redemption.payouts) { const list = lots.get(p.tokenId) ?? []; realized.set(p.tokenId, (realized.get(p.tokenId) ?? 0n) + raw(p.payoutRaw) - list.reduce((n, l) => n + l.cost, 0n)); for (const l of list) { l.cost = 0n; l.shares = 0n; } }
  }
  return [...lots].map(([tokenId, list]) => {
    const reserved = [...state.orders.values()].filter(o => !terminal(o) && o.plan.order.tokenId === tokenId && o.plan.intent.side === 'SELL').reduce((n, o) => n + BigInt(o.plan.order.makerAmount) - o.fills.reduce((a, f) => a + raw(f.sharesGrossRaw), 0n), 0n);
    const market = list[0]?.market ?? fills.find(f => f.tokenId === tokenId)!.marketSlug;
    return { schemaVersion: 'prediction-position/1', tokenId, marketSlug: market, sharesRaw: state.redeemed.has(market) ? '0' : list.reduce((n, l) => n + l.shares, 0n).toString(), reservedSharesRaw: reserved.toString(), costBasisRaw: state.redeemed.has(market) ? '0' : list.reduce((n, l) => n + l.cost, 0n).toString(), realizedPnlRaw: (realized.get(tokenId) ?? 0n).toString(), fidelity: list[0]?.fidelity ?? 'chain' };
  });
}
function realizedForDay(state: LedgerState, day: string): bigint {
  const before = structuredClone(state), today = structuredClone(state);
  for (const o of before.orders.values()) o.fills = o.fills.filter(f => f.occurredAt.slice(0, 10) < day);
  for (const o of today.orders.values()) o.fills = o.fills.filter(f => f.occurredAt.slice(0, 10) <= day);
  before.events = before.events.filter(e => e.occurredAt.slice(0, 10) < day);
  today.events = today.events.filter(e => e.occurredAt.slice(0, 10) <= day);
  before.redeemed = new Set(before.events.filter(e => e.kind === 'redeemed' || e.kind === 'paper-redeemed').map(e => (e.data as { marketSlug: string }).marketSlug));
  today.redeemed = new Set(today.events.filter(e => e.kind === 'redeemed' || e.kind === 'paper-redeemed').map(e => (e.data as { marketSlug: string }).marketSlug));
  return positionsFrom(today).reduce((n, p) => n + BigInt(p.realizedPnlRaw), 0n) - positionsFrom(before).reduce((n, p) => n + BigInt(p.realizedPnlRaw), 0n);
}
