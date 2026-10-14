import { createHash } from 'node:crypto';
import { isValidTransactionDigest } from '@mysten/sui/utils';

export type Chain = 'arbitrum' | 'sui';
export type StateIdentity =
  | { chain: 'arbitrum'; network: '42161' | '421614'; height: string; blockHash: string }
  | { chain: 'sui'; network: 'mainnet' | 'testnet' | 'localnet'; height: string; checkpointDigest: string };
export interface LiquiditySnapshot {
  schemaVersion: '3.0';
  identity: StateIdentity;
  sourceId: string;
  cursor: string;
  observedAtMs: number;
  complete: boolean;
  poolIds: string[];
  stateDigest: string;
}

/** Sui object, checkpoint and transaction digests all encode exactly 32 bytes. */
export function isSuiDigest(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value.length <= 44 && isValidTransactionDigest(value);
}

export function uint(value: unknown, bits = 256): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('INVALID_DECIMAL_INTEGER');
  const n = BigInt(value);
  if (n >= 1n << BigInt(bits)) throw new Error('INTEGER_OUT_OF_RANGE');
  return n;
}
export function digest(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]));
    if (typeof v === 'bigint' || v === undefined || typeof v === 'function' || typeof v === 'symbol' || (typeof v === 'number' && !Number.isFinite(v))) throw new Error('INVALID_DIGEST_INPUT');
    return v;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('INVALID_OBJECT');
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(v).length !== expected.length || expected.some(k => !Object.hasOwn(v, k))) throw new Error('INVALID_FIELDS');
}
export function parseStateIdentity(input: unknown): StateIdentity {
  const i = object(input);
  if (i.chain === 'arbitrum') {
    keys(i, ['chain', 'network', 'height', 'blockHash']);
    if (typeof i.network !== 'string' || !['42161', '421614'].includes(i.network) || typeof i.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(i.blockHash)) throw new Error('INVALID_ARBITRUM_IDENTITY');
  } else if (i.chain === 'sui') {
    keys(i, ['chain', 'network', 'height', 'checkpointDigest']);
    if (typeof i.network !== 'string' || !['mainnet', 'testnet', 'localnet'].includes(i.network) || !isSuiDigest(i.checkpointDigest)) throw new Error('INVALID_SUI_IDENTITY');
  } else throw new Error('UNSUPPORTED_CHAIN');
  uint(i.height, 64);
  return structuredClone(i) as unknown as StateIdentity;
}
export function parseSnapshot(input: unknown): LiquiditySnapshot {
  const s = object(input);
  keys(s, ['schemaVersion', 'identity', 'sourceId', 'cursor', 'observedAtMs', 'complete', 'poolIds', 'stateDigest']);
  if (s.schemaVersion !== '3.0') throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  const i = parseStateIdentity(s.identity);
  uint(s.cursor, 64);
  if (typeof s.sourceId !== 'string' || !s.sourceId.length || s.sourceId.length > 128 || typeof s.complete !== 'boolean') throw new Error('INVALID_SOURCE');
  if (!Number.isSafeInteger(s.observedAtMs) || (s.observedAtMs as number) < 0) throw new Error('INVALID_TIMESTAMP');
  if (!Array.isArray(s.poolIds) || !s.poolIds.length || s.poolIds.length > 10000 || s.poolIds.some(p => typeof p !== 'string' || !p.startsWith(`${i.chain}:${i.network}:`) || p.length > 256) || new Set(s.poolIds).size !== s.poolIds.length) throw new Error('INVALID_POOL_IDS');
  if (typeof s.stateDigest !== 'string' || !/^[a-f0-9]{64}$/.test(s.stateDigest)) throw new Error('INVALID_STATE_DIGEST');
  return structuredClone(s) as unknown as LiquiditySnapshot;
}

/** One ordered source owns a lane; a gap needs an explicit complete replacement snapshot. */
export class SnapshotStore {
  private readonly states = new Map<string, LiquiditySnapshot>();
  private readonly recovering = new Set<string>();
  constructor(private readonly maxStateAgeMs: number) {
    if (!Number.isSafeInteger(maxStateAgeMs) || maxStateAgeMs <= 0) throw new Error('INVALID_STATE_AGE');
  }
  private lane(i: StateIdentity): string { return `${i.chain}:${i.network}`; }
  apply(input: unknown, recovery = false): 'accepted' | 'duplicate' {
    const next = parseSnapshot(input), lane = this.lane(next.identity), prior = this.states.get(lane);
    if (!next.complete) { this.recovering.add(lane); throw new Error('STATE_COVERAGE_INCOMPLETE'); }
    if (prior) {
      const before = uint(prior.cursor, 64), after = uint(next.cursor, 64);
      if (after === before && digest(prior) === digest(next) && !this.recovering.has(lane)) return 'duplicate';
      if (uint(next.identity.height, 64) < uint(prior.identity.height, 64) || after <= before || (!recovery && (after !== before + 1n || prior.sourceId !== next.sourceId)) || (next.identity.height === prior.identity.height && digest(next.identity) !== digest(prior.identity))) {
        this.recovering.add(lane); throw new Error('SOURCE_GAP_OR_DIVERGENCE');
      }
    }
    if (this.recovering.has(lane) && !recovery) throw new Error('RESYNC_REQUIRED');
    this.states.set(lane, next); this.recovering.delete(lane);
    return 'accepted';
  }
  current(i: StateIdentity, nowMs: number): LiquiditySnapshot {
    const lane = this.lane(i), state = this.states.get(lane);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !state || this.recovering.has(lane)) throw new Error('RESYNC_REQUIRED');
    if (nowMs < state.observedAtMs || nowMs - state.observedAtMs > this.maxStateAgeMs) throw new Error('STALE_STATE');
    if (digest(i) !== digest(state.identity)) throw new Error('STATE_CHANGED');
    return structuredClone(state);
  }
}
