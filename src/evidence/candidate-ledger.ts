import { validateRecord } from './contracts.js';
import type { RouteStat } from './solver.js';

export type CandidateOutcome = 'EVALUATED' | 'REJECTED' | 'DEFERRED_BUDGET' | 'INCOMPLETE_DATA' | 'UNSUPPORTED';
export type CandidateStage = 'discovery' | 'identity' | 'inventory' | 'snapshot' | 'route_build' | 'quote' | 'solve';
export interface EvidenceRefV6 { kind: string; content_hash: string; captured_at: string; trace_id: string }
export interface CandidateItem {
  asset_id: string; role: 'target' | 'funding' | 'settlement'; sources: Array<'movers' | 'explicit' | 'anchor'>; first_seen: string;
  reported_metrics: { change_24h_pct?: string; liquidity_usd?: string }; outcome: CandidateOutcome; stage: CandidateStage;
  reason_code: string | null; next_dependency: string | null; route_ids: string[]; evidence_refs: EvidenceRefV6[];
}
export interface CandidateLedger {
  schema: 'candidate-ledger/1'; round_id: string; chain_id: string;
  source_state: { as_of: string; coverage: 'FULL' | 'BOUNDED' | 'EMPTY_PROVIDER'; providers: string[]; source_refs: EvidenceRefV6[] };
  items: CandidateItem[];
  counts: { requested: number; evaluated: number; rejected: number; deferred: number; incomplete: number; unsupported: number };
}
/** Route facts a ledger may cite: hypermove `routes[]` or local `RouteStat` mapped by `fromRouteStats`. */
export interface EvaluatedRoute { id: string; token_ids: string[]; evaluations: number }

const address = (assetOrToken: string) => (assetOrToken.split(':').at(-1) ?? '').toLowerCase();
const countKey: Record<CandidateOutcome, keyof CandidateLedger['counts']> = { EVALUATED: 'evaluated', REJECTED: 'rejected', DEFERRED_BUDGET: 'deferred', INCOMPLETE_DATA: 'incomplete', UNSUPPORTED: 'unsupported' };

export const fromRouteStats = (stats: RouteStat[]): EvaluatedRoute[] => stats.map(s => ({ id: s.routeId, token_ids: s.tokenIds, evaluations: s.evaluated }));

function fail(invariant: number, detail: string): never { throw new Error(`LEDGER_INVARIANT_${invariant}:${detail}`); }

/**
 * Strict candidate-ledger/1 check (v6 §3.2 invariants 1–7). Invariant 8 (a pair gap alone never yields
 * EVALUATED) holds structurally: EVALUATED must cite an evaluated route, which only the solver produces.
 */
export function validateCandidateLedger(raw: unknown, routes: EvaluatedRoute[], explicitAssets: string[] = []): CandidateLedger {
  const ledger = validateRecord<CandidateLedger>('CandidateLedger', raw, 'v6');
  const seen = new Set<string>(), byId = new Map(routes.map(r => [r.id, r])), explicit = new Set(explicitAssets.map(address));
  const counts = { requested: 0, evaluated: 0, rejected: 0, deferred: 0, incomplete: 0, unsupported: 0 };
  for (const item of ledger.items) {
    const key = address(item.asset_id);
    if (seen.has(key)) fail(1, item.asset_id); seen.add(key);
    counts.requested++; counts[countKey[item.outcome]]++;
    if (item.outcome === 'EVALUATED') {
      if (item.stage !== 'solve' || item.reason_code !== null || !item.route_ids.length) fail(3, item.asset_id);
      for (const id of item.route_ids) { const r = byId.get(id); if (!r || r.evaluations <= 0 || !r.token_ids.some(t => address(t) === key)) fail(3, `${item.asset_id}:${id}`); }
    } else if (item.reason_code === null) fail(4, item.asset_id);
    if (item.outcome === 'DEFERRED_BUDGET' && item.next_dependency === null) fail(5, item.asset_id);
    if (item.sources.includes('anchor') && item.role === 'target' && !explicit.has(key)) fail(7, item.asset_id);
  }
  for (const k of Object.keys(counts) as Array<keyof typeof counts>) if (ledger.counts[k] !== counts[k]) fail(2, k);
  // An empty mover response is never a full market scan.
  if (ledger.source_state.coverage === 'FULL' && !ledger.items.some(i => i.sources.includes('movers'))) fail(6, 'empty provider reported FULL');
  return ledger;
}

export interface LocalCandidate { asset_id: string; role: CandidateItem['role']; sources: CandidateItem['sources']; first_seen: string; reported_metrics?: CandidateItem['reported_metrics'] }
export interface LocalOutcome { outcome: Exclude<CandidateOutcome, 'EVALUATED'>; stage: CandidateStage; reason_code: string; next_dependency?: string | null }

/**
 * Builds a ledger for the local runtime: dedupes by address, defers beyond the cap, applies inventory
 * outcomes (e.g. `buildPoolUniverse` rejections), and marks EVALUATED only from routes with evaluated > 0.
 */
export function mergeLocalOutcomes(input: {
  roundId: string; chainId: string; asOf: string; coverage: CandidateLedger['source_state']['coverage']; providers: string[]; sourceRefs: EvidenceRefV6[];
  candidates: LocalCandidate[]; maxCandidates: number; inventoryOutcomes: Record<string, LocalOutcome>; routes: EvaluatedRoute[]; evidence: EvidenceRefV6[];
  /** Tokens present in captured pool state; when given, an uncaptured token is INCOMPLETE_DATA, not a missing route. */
  capturedTokens?: string[];
}): CandidateLedger {
  const merged = new Map<string, LocalCandidate>();
  for (const c of input.candidates) {
    const key = address(c.asset_id), prior = merged.get(key);
    merged.set(key, prior ? { ...prior, sources: [...new Set([...prior.sources, ...c.sources])], reported_metrics: prior.reported_metrics ?? c.reported_metrics } : c);
  }
  const inventory = new Map(Object.entries(input.inventoryOutcomes).map(([k, v]) => [address(k), v])), captured = input.capturedTokens ? new Set(input.capturedTokens.map(address)) : null;
  const items: CandidateItem[] = [...merged.entries()].map(([key, c], index) => {
    const base = { asset_id: c.asset_id.toLowerCase(), role: c.role, sources: c.sources, first_seen: c.first_seen, reported_metrics: c.reported_metrics ?? {}, evidence_refs: input.evidence };
    if (index >= input.maxCandidates) return { ...base, outcome: 'DEFERRED_BUDGET', stage: 'discovery', reason_code: 'CANDIDATE_CAP', next_dependency: 'candidate-budget', route_ids: [] };
    const blocked = inventory.get(key);
    if (blocked) return { ...base, outcome: blocked.outcome, stage: blocked.stage, reason_code: blocked.reason_code, next_dependency: blocked.next_dependency ?? (blocked.outcome === 'DEFERRED_BUDGET' ? 'evaluation-budget' : null), route_ids: [] };
    if (captured && !captured.has(key)) return { ...base, outcome: 'INCOMPLETE_DATA', stage: 'snapshot', reason_code: 'NOT_IN_CAPTURED_STATE', next_dependency: 'pool-snapshot', route_ids: [] };
    const routes = input.routes.filter(r => r.token_ids.some(t => address(t) === key)), evaluated = routes.filter(r => r.evaluations > 0);
    if (evaluated.length) return { ...base, outcome: 'EVALUATED', stage: 'solve', reason_code: null, next_dependency: null, route_ids: [...new Set(evaluated.map(r => r.id))] };
    if (routes.length) return { ...base, outcome: 'DEFERRED_BUDGET', stage: 'solve', reason_code: 'EVALUATION_BUDGET', next_dependency: 'evaluation-budget', route_ids: [] };
    return { ...base, outcome: 'REJECTED', stage: 'route_build', reason_code: 'NO_CLOSED_ROUTE', next_dependency: null, route_ids: [] };
  });
  const counts = { requested: items.length, evaluated: 0, rejected: 0, deferred: 0, incomplete: 0, unsupported: 0 };
  for (const i of items) counts[countKey[i.outcome]]++;
  return { schema: 'candidate-ledger/1', round_id: input.roundId, chain_id: input.chainId,
    source_state: { as_of: input.asOf, coverage: input.coverage, providers: input.providers, source_refs: input.sourceRefs }, items, counts };
}

const decimalText = (value: number | string, places: number) => {
  const n = Number(value); if (!Number.isFinite(n)) throw new Error('INVALID_MOVERS_FILE');
  return n.toFixed(places).replace(/\.?0+$/, '') || '0';
};
/**
 * Reads hypermove `flashloan.movers.v1` output (bare or inside a `flashloan.public.v3` response) for one EVM
 * chain. Provider metrics are leads only; an empty or unavailable chain reports EMPTY_PROVIDER coverage.
 */
export function readMovers(raw: unknown, chainId: number): { schema: string; coverage: CandidateLedger['source_state']['coverage']; asOf: string; candidates: LocalCandidate[] } {
  const body = raw as { schema_version?: string; data?: unknown };
  const result = (body?.schema_version === 'flashloan.public.v3' ? body.data : raw) as { schema_version?: string; completed_at?: string; chains?: Array<{ chain_id: number | null; outcome: string; tokens: Array<{ token_id: string; price_change_24h_pct: number; liquidity_usd: string }> }> };
  if (result?.schema_version !== 'flashloan.movers.v1' || !Array.isArray(result.chains) || typeof result.completed_at !== 'string') throw new Error('INVALID_MOVERS_FILE');
  const asOf = new Date(result.completed_at).toISOString().replace(/\.\d{3}Z$/, 'Z'), chain = result.chains.find(c => c.chain_id === chainId);
  const tokens = chain && ['SUCCESS', 'PARTIAL'].includes(chain.outcome) ? chain.tokens : [];
  const candidates = tokens.map(t => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(t.token_id)) throw new Error('INVALID_MOVERS_FILE');
    return { asset_id: `eip155:${chainId}/erc20:${t.token_id.toLowerCase()}`, role: 'target' as const, sources: ['movers' as const], first_seen: asOf,
      reported_metrics: { change_24h_pct: decimalText(t.price_change_24h_pct, 4), liquidity_usd: decimalText(t.liquidity_usd, 2) } };
  });
  return { schema: result.schema_version, coverage: candidates.length ? 'BOUNDED' : 'EMPTY_PROVIDER', asOf, candidates };
}
