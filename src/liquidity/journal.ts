import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ExecutionLock } from '../execution-lock.js';

export type AttemptState = 'prepared' | 'signed' | 'submitted' | 'acceptance-unknown' | 'reconciled' | 'halted';
export interface AttemptRecord {
  id: string;
  lane: string;
  budgetAsset: string;
  candidateDigest: string;
  resource: string;
  state: AttemptState;
  transactionId: string | null;
  loss: string;
  day: string;
}
const nextStates: Record<AttemptState, AttemptState[]> = {
  prepared: ['signed', 'halted'], signed: ['submitted', 'acceptance-unknown', 'halted'],
  submitted: ['reconciled', 'halted', 'acceptance-unknown'], 'acceptance-unknown': ['submitted', 'reconciled', 'halted'], reconciled: [], halted: ['reconciled']
};
function validateRecord(r: AttemptRecord): void {
  if (!r || Object.keys(r).sort().join(',') !== 'budgetAsset,candidateDigest,day,id,lane,loss,resource,state,transactionId' || typeof r.id !== 'string' || !r.id || typeof r.lane !== 'string' || !/^(arbitrum:(42161|421614)|sui:(mainnet|testnet|localnet))$/.test(r.lane) || typeof r.budgetAsset !== 'string' || !r.budgetAsset.startsWith(`${r.lane}:`) || typeof r.resource !== 'string' || !r.resource || r.resource.length > 256 || !/^[a-f0-9]{64}$/.test(r.candidateDigest) || !Object.hasOwn(nextStates, r.state) || !/^(0|[1-9][0-9]*)$/.test(r.loss) || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !(r.transactionId === null || typeof r.transactionId === 'string')) throw new Error('JOURNAL_CORRUPT');
}

/** Never stores secrets, calldata or signed transaction bytes. Unresolved leases survive restart. */
export class AttemptJournal {
  private mutationTail: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  private lock(): ExecutionLock { return new ExecutionLock(`${this.path}.lock`); }
  /** Queue this process's writers; the file lock still rejects other processes. */
  private async mutate(operation: () => Promise<void>): Promise<void> {
    const pending = this.mutationTail.then(() => this.lock().runExclusive(operation));
    this.mutationTail = pending.catch(() => {});
    return pending;
  }
  async records(): Promise<AttemptRecord[]> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    if (raw && !raw.endsWith('\n')) throw new Error('JOURNAL_TORN_WRITE');
    return raw.trim() ? raw.trim().split('\n').map(line => {
      const r = JSON.parse(line) as AttemptRecord;
      validateRecord(r);
      return r;
    }) : [];
  }
  async latest(): Promise<AttemptRecord[]> {
    return [...new Map((await this.records()).map(r => [r.id, r])).values()];
  }
  private async append(r: AttemptRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const f = await open(this.path, 'a', 0o600);
    try { await f.writeFile(JSON.stringify(r) + '\n'); await f.sync(); } finally { await f.close(); }
  }
  async prepare(record: AttemptRecord, maxLoss: bigint, reserve: bigint): Promise<void> {
    validateRecord(record);
    await this.mutate(async () => {
      const prior = await this.latest();
      if (prior.some(r => r.lane === record.lane && r.state !== 'reconciled')) throw new Error('UNRESOLVED_ATTEMPT');
      if (prior.some(r => r.id === record.id || r.candidateDigest === record.candidateDigest)) throw new Error('DUPLICATE_ATTEMPT');
      if (prior.some(r => r.lane === record.lane && r.day === record.day && r.budgetAsset !== record.budgetAsset)) throw new Error('BUDGET_ASSET_CHANGED');
      const used = prior.filter(r => r.lane === record.lane && r.day === record.day).reduce((n, r) => n + BigInt(r.loss), 0n);
      if (reserve < 0n || maxLoss <= 0n || used + reserve > maxLoss) throw new Error('RISK_BUDGET_EXHAUSTED');
      if (record.state !== 'prepared' || record.transactionId !== null || BigInt(record.loss) !== reserve) throw new Error('INVALID_ATTEMPT');
      await this.append(record);
    });
  }
  async transition(id: string, state: AttemptState, transactionId: string | null, loss?: bigint): Promise<void> {
    await this.mutate(async () => {
      const prior = (await this.latest()).find(r => r.id === id);
      if (!prior || !nextStates[prior.state].includes(state)) throw new Error('INVALID_ATTEMPT_TRANSITION');
      if (prior.transactionId && transactionId !== prior.transactionId) throw new Error('TRANSACTION_ID_CHANGED');
      if (state !== 'halted' && !transactionId) throw new Error('MISSING_TRANSACTION_ID');
      if (loss !== undefined && (loss < 0n || (state !== 'reconciled' && state !== 'halted'))) throw new Error('INVALID_LOSS');
      await this.append({ ...prior, state, transactionId, loss: (loss ?? BigInt(prior.loss)).toString() });
    });
  }
}
