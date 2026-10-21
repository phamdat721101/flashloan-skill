import { parseStateIdentity, digest, uint, isSuiDigest, type StateIdentity } from './state.js';
import { parsePoolState, type PoolStateEnvelope } from './projection.js';
import type { Rational } from './v2.js';
import { quoteDeepBookExactInput, type DeepBookBookState } from '../sui/deepbook.js';

export const L2_VERSION = '1.0' as const;
export const FEATURE_REVISION = 'depth-flow-v1';
export type Availability<T> = { value: T; reason: null } | { value: null; reason: string };
export const available = <T>(value: T): Availability<T> => ({ value, reason: null });
export const unavailable = <T>(reason: string): Availability<T> => ({ value: null, reason });
export type EvidenceStatus = 'provisional' | 'node-confirmed' | 'checkpoint-certified' | 'external';
export interface MarketLevel { price: string; quantity: string }
export type ObservationPayload =
  | { kind: 'pool'; pool: PoolStateEnvelope; flowComplete: boolean }
  | { kind: 'trade'; side: 'buy' | 'sell'; baseAtoms: string; quoteAtoms: string }
  | { kind: 'allowance'; owner: string; router: string; balanceAtoms: string; allowanceAtoms: string }
  | { kind: 'market-book'; venue: 'binance' | 'hyperliquid'; baseAsset: string; quoteAsset: string; bids: MarketLevel[]; asks: MarketLevel[]; complete: boolean }
  | { kind: 'market-trade'; venue: 'binance' | 'hyperliquid'; baseAsset: string; quoteAsset: string; side: 'buy' | 'sell'; price: string; quantity: string }
  | { kind: 'deepbook'; book: DeepBookBookState; baseAsset: string; quoteAsset: string; decimalsBase: number; decimalsQuote: number; flowComplete: boolean }
  | { kind: 'invalidate'; generation: string; reason: string };
export interface MarketObservation {
  schemaVersion: '1.0'; eventId: string; sourceId: string; cursor: string; generation: string;
  poolId: string; identity: StateIdentity | null; status: EvidenceStatus;
  parentDigest: string | null;
  eventTimeNs: string; receivedTimeNs: string; evidence: string; payload: ObservationPayload;
}
export interface DepthPoint {
  bps: number; side: 'bid' | 'ask'; inputAsset: string; outputAsset: string;
  inputAtoms: Availability<string>; outputAtoms: Availability<string>; quoteAtoms: Availability<string>;
}
export interface MicrostructureFrame {
  schemaVersion: '1.0'; frameId: string; featureRevision: string; generation: string;
  poolId: string; identity: StateIdentity; stateDigest: string; receivedTimeNs: string;
  baseAsset: string; quoteAsset: string; decimalsBase: number; decimalsQuote: number;
  evidence: string[]; watermarks: Record<string, string>; labels: string[];
  metrics: {
    spot: Rational; depth: DepthPoint[]; skew2pct: Availability<Rational>;
    volume1hQuoteAtoms: string; cvd5mQuoteAtoms: string; tradeCount: number;
    vwap1h: Availability<Rational>; printDecay: Availability<Rational>;
    printCounts: { recent: number; baseline: number };
    turnover1h: Availability<Rational>; allowanceCapacityQuoteAtoms: Availability<string>;
    allowanceOverhang: Availability<Rational>; bidWithdrawal: Availability<Rational>;
    marketBasis: Availability<Rational>; marketSource: string | null;
  };
  quality: { complete: boolean; reasons: string[]; windowStartNs: string; windowEndNs: string };
}
export const HORIZONS = ['next', '1m', '5m', '15m'] as const;
export type Horizon = typeof HORIZONS[number];
export interface PredictionRecord {
  schemaVersion: '1.0'; predictionId: string; frameId: string; modelId: string;
  chain: StateIdentity['chain']; poolId: string; cutoffNs: string; horizon: Horizon;
  probabilities: [number, number, number]; expectedMarkoutBps: number;
  admission: 'research' | 'validated'; reason: string | null;
}
export interface ForwardOutcome {
  schemaVersion: '1.0'; predictionId: string; frameId: string; cutoffNs: string; observedTimeNs: string;
  horizon: Horizon; identity: StateIdentity; price: Rational; markoutBps: number;
  netValueAtoms: string | null; baselineNetValueAtoms: string | null; evidence: string;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('L2_INVALID_OBJECT');
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, names: string[], optional: string[] = []): void {
  if (names.some(n => !Object.hasOwn(value,n)) || Object.keys(value).some(n => !names.includes(n) && !optional.includes(n))) throw new Error('L2_INVALID_FIELDS');
}
export function text(value: unknown, max = 1024): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error('L2_INVALID_TEXT');
}
export function ns(value: unknown): bigint { return uint(value, 96); }
export function signedRatio(n: bigint, d: bigint): Rational {
  if (d <= 0n) throw new Error('L2_INVALID_DENOMINATOR');
  return { numerator: n.toString(), denominator: d.toString() };
}
export function ratioNumber(value: Rational): number {
  const result = Number(value.numerator) / Number(value.denominator);
  if (!Number.isFinite(result)) throw new Error('L2_RATIO_RANGE');
  return result;
}
export function parseObservation(input: unknown): MarketObservation {
  const o = record(input);
  fields(o,['schemaVersion','eventId','sourceId','cursor','generation','poolId','identity','parentDigest','status','eventTimeNs','receivedTimeNs','evidence','payload']);
  if (o.schemaVersion !== L2_VERSION || !['provisional','node-confirmed','checkpoint-certified','external'].includes(String(o.status))) throw new Error('L2_INVALID_VERSION_OR_STATUS');
  for (const k of ['eventId','sourceId','generation','poolId','evidence']) text(o[k], k === 'evidence' ? 2048 : 256);
  uint(o.cursor,64);
  if (ns(o.eventTimeNs) > ns(o.receivedTimeNs)) throw new Error('L2_EVENT_FROM_FUTURE');
  const identity = o.identity === null ? null : parseStateIdentity(o.identity);
  if (identity) {
    if (identity.height === '0' ? o.parentDigest !== null : identity.chain !== 'sui' ? !/^0x[0-9a-f]{64}$/.test(String(o.parentDigest)) : !isSuiDigest(o.parentDigest)) throw new Error('L2_INVALID_PARENT');
  } else if (o.parentDigest !== null) throw new Error('L2_INVALID_PARENT');
  if (identity && !String(o.poolId).startsWith(`${identity.chain}:${identity.network}:`)) throw new Error('L2_CHAIN_MISMATCH');
  if ((o.status === 'node-confirmed' && (!identity || identity.chain === 'sui')) || (o.status === 'checkpoint-certified' && identity?.chain !== 'sui') || (o.status === 'external' && identity !== null)) throw new Error('L2_FINALITY_MISMATCH');
  const p = record(o.payload);
  if (p.kind === 'pool') {
    fields(p,['kind','pool','flowComplete']); const pool = parsePoolState(p.pool);
    if (typeof p.flowComplete !== 'boolean') throw new Error('L2_INVALID_FLOW_COVERAGE');
    if (!identity || digest(identity) !== digest(pool.identity) || pool.poolId !== o.poolId || pool.stateClass !== 'canonical' || pool.appliedOperations.length || !['node-confirmed','checkpoint-certified'].includes(String(o.status))) throw new Error('L2_INCOHERENT_POOL');
  } else if (p.kind === 'trade') {
    fields(p,['kind','side','baseAtoms','quoteAtoms']);
    if ((!identity && o.status !== 'provisional') || !['buy','sell'].includes(String(p.side)) || !uint(p.baseAtoms) || !uint(p.quoteAtoms) || o.status === 'external') throw new Error('L2_INVALID_TRADE');
  } else if (p.kind === 'allowance') {
    fields(p,['kind','owner','router','balanceAtoms','allowanceAtoms']);
    if ((!identity || identity.chain === 'sui') || o.status !== 'node-confirmed' || !/^0x[0-9a-f]{40}$/.test(String(p.owner)) || !/^0x[0-9a-f]{40}$/.test(String(p.router))) throw new Error('L2_INVALID_ALLOWANCE');
    uint(p.balanceAtoms); uint(p.allowanceAtoms);
  } else if (p.kind === 'market-book') {
    fields(p,['kind','venue','baseAsset','quoteAsset','bids','asks','complete']);
    text(p.baseAsset); text(p.quoteAsset); if (p.baseAsset === p.quoteAsset) throw new Error('L2_INVALID_ASSETS');
    if (o.status !== 'external' || !['binance','hyperliquid'].includes(String(p.venue)) || typeof p.complete !== 'boolean') throw new Error('L2_INVALID_MARKET');
    for (const key of ['bids','asks']) {
      if (!Array.isArray(p[key]) || p[key].length > 5000) throw new Error('L2_BOOK_LIMIT');
      let previous: bigint | null = null;
      for (const raw of p[key]) {
        const l = record(raw); fields(l,['price','quantity']); const price = uint(l.price); uint(l.quantity);
        if (!price || (previous !== null && (key === 'bids' ? price >= previous : price <= previous))) throw new Error('L2_BOOK_ORDER'); previous = price;
      }
    }
  } else if (p.kind === 'market-trade') {
    fields(p,['kind','venue','baseAsset','quoteAsset','side','price','quantity']); text(p.baseAsset); text(p.quoteAsset);
    if (o.status !== 'external' || p.baseAsset === p.quoteAsset || !['binance','hyperliquid'].includes(String(p.venue)) || !['buy','sell'].includes(String(p.side)) || !uint(p.price) || !uint(p.quantity)) throw new Error('L2_INVALID_MARKET_TRADE');
  } else if (p.kind === 'deepbook') {
    fields(p,['kind','book','baseAsset','quoteAsset','decimalsBase','decimalsQuote','flowComplete']);
    if (typeof p.flowComplete !== 'boolean') throw new Error('L2_INVALID_FLOW_COVERAGE');
    if (identity?.chain !== 'sui' || o.status !== 'checkpoint-certified') throw new Error('L2_INVALID_DEEPBOOK_IDENTITY');
    text(p.baseAsset); text(p.quoteAsset);
    if (p.baseAsset === p.quoteAsset || ![p.decimalsBase,p.decimalsQuote].every(v => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 255)) throw new Error('L2_INVALID_ASSETS');
    const book = p.book as DeepBookBookState;
    quoteDeepBookExactInput(book,true,'1');
    if (book.checkpointDigest !== identity.checkpointDigest || ns(o.eventTimeNs) !== uint(book.timestampMs,64) * 1000000n) throw new Error('L2_INCOHERENT_BOOK');
  } else if (p.kind === 'invalidate') {
    fields(p,['kind','generation','reason']); text(p.generation,256); text(p.reason,256);
    if (!identity || !['node-confirmed','checkpoint-certified'].includes(String(o.status))) throw new Error('L2_INVALID_INVALIDATION');
  } else throw new Error('L2_UNSUPPORTED_OBSERVATION');
  return structuredClone(o) as unknown as MarketObservation;
}
export function parseFrame(input: unknown): MicrostructureFrame {
  const f = record(input);
  fields(f,['schemaVersion','frameId','featureRevision','generation','poolId','identity','stateDigest','receivedTimeNs','baseAsset','quoteAsset','decimalsBase','decimalsQuote','evidence','watermarks','labels','metrics','quality']);
  const { frameId,...body } = f, identity = parseStateIdentity(f.identity);
  if (f.schemaVersion !== '1.0' || f.featureRevision !== FEATURE_REVISION || frameId !== digest(body) || !/^[a-f0-9]{64}$/.test(String(f.stateDigest)) || !String(f.poolId).startsWith(`${identity.chain}:${identity.network}:`)) throw new Error('L2_INVALID_FRAME');
  ns(f.receivedTimeNs);
  for (const k of ['poolId','generation','baseAsset','quoteAsset']) text(f[k]);
  if (f.baseAsset === f.quoteAsset || ![f.decimalsBase,f.decimalsQuote].every(v => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 255)) throw new Error('L2_INVALID_ASSETS');
  for (const k of ['evidence','labels']) {
    if (!Array.isArray(f[k]) || f[k].length > 100000) throw new Error('L2_FRAME_LIMIT');
    for (const v of f[k]) text(v,2048);
  }
  if (!(f.evidence as unknown[]).length) throw new Error('L2_MISSING_EVIDENCE');
  const marks = record(f.watermarks); if (Object.keys(marks).length > 100) throw new Error('L2_FRAME_LIMIT');
  for (const [source,cursor] of Object.entries(marks)) { text(source,256); uint(cursor,64); }
  const metrics = record(f.metrics);
  fields(metrics,['spot','depth','skew2pct','volume1hQuoteAtoms','cvd5mQuoteAtoms','tradeCount','vwap1h','printDecay','printCounts','turnover1h','allowanceCapacityQuoteAtoms','allowanceOverhang','bidWithdrawal','marketBasis','marketSource']);
  const printCounts = record(metrics.printCounts); fields(printCounts,['recent','baseline']);
  if (![printCounts.recent,printCounts.baseline].every(v => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 100000)) throw new Error('L2_INVALID_PRINT_COUNTS');
  const ratio = (raw: unknown,signed = false) => {
    const r = record(raw); fields(r,['numerator','denominator']);
    if (signed) { if (typeof r.numerator !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(r.numerator) || r.numerator.length > 160) throw new Error('L2_INVALID_RATIO'); }
    else uint(r.numerator,2048);
    if (!uint(r.denominator,2048)) throw new Error('L2_INVALID_RATIO');
  };
  const availability = (raw: unknown,check: (value: unknown) => void) => {
    const a = record(raw); fields(a,['value','reason']);
    if (a.value === null) text(a.reason,256); else { if (a.reason !== null) throw new Error('L2_INVALID_AVAILABILITY'); check(a.value); }
  };
  ratio(metrics.spot);
  for (const key of ['skew2pct','vwap1h','printDecay','turnover1h','allowanceOverhang','bidWithdrawal','marketBasis']) availability(metrics[key],v => ratio(v,['skew2pct','bidWithdrawal','marketBasis'].includes(key)));
  if (metrics.marketSource !== null) text(metrics.marketSource,256);
  availability(metrics.allowanceCapacityQuoteAtoms,v => { uint(v); }); uint(metrics.volume1hQuoteAtoms);
  if (typeof metrics.cvd5mQuoteAtoms !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(metrics.cvd5mQuoteAtoms) || metrics.cvd5mQuoteAtoms.length > 80 || !Number.isInteger(metrics.tradeCount) || Number(metrics.tradeCount) < 0 || Number(metrics.tradeCount) > 100000) throw new Error('L2_INVALID_FLOW');
  if (!Array.isArray(metrics.depth) || metrics.depth.length !== 6) throw new Error('L2_INVALID_DEPTH');
  const bands = new Set<string>();
  for (const value of metrics.depth) {
    const d = record(value); fields(d,['bps','side','inputAsset','outputAsset','inputAtoms','outputAtoms','quoteAtoms']);
    if (![100,200,500].includes(Number(d.bps)) || !['bid','ask'].includes(String(d.side)) || bands.has(`${d.bps}:${d.side}`) || d.inputAsset !== (d.side === 'bid' ? f.baseAsset : f.quoteAsset) || d.outputAsset !== (d.side === 'bid' ? f.quoteAsset : f.baseAsset)) throw new Error('L2_INVALID_DEPTH');
    bands.add(`${d.bps}:${d.side}`);
    for (const key of ['inputAtoms','outputAtoms','quoteAtoms']) availability(d[key],v => { uint(v); });
  }
  const q = record(f.quality); fields(q,['complete','reasons','windowStartNs','windowEndNs']);
  if (typeof q.complete !== 'boolean' || !Array.isArray(q.reasons) || q.reasons.length > 100 || q.complete !== (q.reasons.length === 0) || ns(q.windowStartNs) > ns(q.windowEndNs) || ns(q.windowEndNs) > ns(f.receivedTimeNs)) throw new Error('L2_INVALID_QUALITY');
  for (const reason of q.reasons) text(reason,256);
  if (Number(printCounts.recent)+Number(printCounts.baseline) > Number(metrics.tradeCount) || (record(metrics.printDecay).value !== null && (Number(printCounts.recent) < 3 || Number(printCounts.baseline) < 3)) || (q.complete && metrics.depth.some(d => record(record(d).quoteAtoms).value === null))) throw new Error('L2_INCONSISTENT_FRAME');
  return structuredClone(f) as unknown as MicrostructureFrame;
}
