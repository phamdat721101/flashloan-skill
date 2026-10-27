import { digest, parseSnapshot, uint, type LiquiditySnapshot } from './state.js';
import type { RouteCandidate } from './runtime.js';
import { parsePoolState, projectPool, type PoolStateEnvelope, type ProjectionResult } from './projection.js';
import { ceilDiv, v2StationarySeed, rational } from './v2.js';
import { quoteAlgebraExactInput, type AlgebraLinkedState, type AlgebraFeeResolution } from './algebra.js';
import { quoteDeepBookExactInput, type DeepBookBookState } from '../sui/deepbook.js';
import { executableDepth } from './l2-metrics.js';
import { poolPrice } from './projection.js';
import { parseStateIdentity, type StateIdentity } from './state.js';

export interface SizingRequest {
  schemaVersion: '4.0'; snapshotDigest: string; borrowAsset: string;
  route: Array<{ poolId: string; tokenIn: string }>;
  minimum: string; maximum: string; quantum: string; lenderAvailable: string;
  flashFeeNumerator: string; flashFeeDenominator: string;
  costInBorrowAsset: string; costEvidenceDigest: string; minProfit: string; maxEvaluations?: number;
  boundaryInputs?: string[];
}
export interface SizingResult {
  schemaVersion: '4.0'; status: 'selected' | 'no-profitable-size'; optimality: 'best-found' | 'certified';
  snapshotDigest: string; requestDigest: string; stateClass: 'canonical' | 'projected'; borrowAsset: string;
  feasibleMinimum: string; feasibleMaximum: string; quantum: string; evaluations: number;
  amountIn: string; amountOut: string; flashFee: string; repayment: string; costInBorrowAsset: string; netProfit: string;
  legs: ProjectionResult[]; rejectedQuotes: Record<string, number>;
}
export interface RouteComparison {
  schemaVersion: '4.0'; selectedDirection: 'forward' | 'reverse' | null;
  selectedRequest: SizingRequest | null; selected: SizingResult | null;
  forward: SizingResult | null; reverse: SizingResult | null;
  rejectedDirections: Partial<Record<'forward' | 'reverse','NO_FEASIBLE_SIZING_DOMAIN'>>;
}
/** Compare both traversals of one circular route; each has its own bounded search. */
export function compareRouteDirections(inputs: unknown, rawRequest: unknown): RouteComparison {
  if (!Array.isArray(inputs)) throw new Error('INVALID_SIZING_POOLS');
  const pools = inputs.map(parsePoolState), request = parseSizingRequest(rawRequest);
  // Validate forward continuity and provenance before deriving the opposite traversal.
  const rejectedDirections: RouteComparison['rejectedDirections'] = {};
  const evaluate = (direction: 'forward' | 'reverse',r: SizingRequest): SizingResult | null => {
    try { return sizeRoute(pools,r); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'NO_FEASIBLE_SIZING_DOMAIN') throw error;
      rejectedDirections[direction] = 'NO_FEASIBLE_SIZING_DOMAIN'; return null;
    }
  };
  const forward = evaluate('forward',request), byId = new Map(pools.map(pool => [pool.poolId,pool]));
  const reverseRequest: SizingRequest = { ...request,route: [...request.route].reverse().map(leg => {
    const pool = byId.get(leg.poolId)!;
    const matches = pool.identity.chain !== 'sui' ? leg.tokenIn.toLowerCase() === pool.token0.toLowerCase() : leg.tokenIn === pool.token0;
    const tokenIn = matches ? pool.token1 : pool.token0;
    return { poolId: leg.poolId,tokenIn };
  }),boundaryInputs: [] };
  // Forward boundary hints refer to that traversal's first asset flow only.
  const reverse = evaluate('reverse',reverseRequest);
  const direction = forward?.status === 'selected' && (reverse?.status !== 'selected' || uint(forward.netProfit) >= uint(reverse.netProfit)) ? 'forward' : reverse?.status === 'selected' ? 'reverse' : null;
  return { schemaVersion: '4.0',selectedDirection: direction,selectedRequest: direction === 'forward' ? request : direction === 'reverse' ? reverseRequest : null,selected: direction === 'forward' ? forward : direction === 'reverse' ? reverse : null,forward,reverse,rejectedDirections };
}
export function parseSizingRequest(input: unknown): SizingRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_SIZING_REQUEST');
  const r = input as Record<string, unknown>;
  const required = ['schemaVersion','snapshotDigest','borrowAsset','route','minimum','maximum','quantum','lenderAvailable','flashFeeNumerator','flashFeeDenominator','costInBorrowAsset','costEvidenceDigest','minProfit'];
  if (required.some(key => !Object.hasOwn(r,key)) || Object.keys(r).some(key => ![...required,'maxEvaluations','boundaryInputs'].includes(key)) || r.schemaVersion !== '4.0' || typeof r.borrowAsset !== 'string' || !r.borrowAsset.length || r.borrowAsset.length > 1024 || ![r.snapshotDigest,r.costEvidenceDigest].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) || !Array.isArray(r.route) || r.route.length < 2 || r.route.length > 6) throw new Error('INVALID_SIZING_REQUEST');
  for (const key of ['minimum','maximum','quantum','lenderAvailable','flashFeeNumerator','flashFeeDenominator','costInBorrowAsset','minProfit']) uint(r[key]);
  if (!uint(r.minimum) || !uint(r.quantum) || !uint(r.flashFeeDenominator) || uint(r.minimum) > uint(r.maximum) || (r.maxEvaluations !== undefined && (!Number.isSafeInteger(r.maxEvaluations) || (r.maxEvaluations as number) < 1 || (r.maxEvaluations as number) > 512))) throw new Error('INVALID_SIZING_BOUNDS');
  for (const leg of r.route) if (!leg || typeof leg !== 'object' || Array.isArray(leg) || Object.keys(leg).sort().join(',') !== 'poolId,tokenIn' || typeof leg.poolId !== 'string' || typeof leg.tokenIn !== 'string') throw new Error('INVALID_SIZING_ROUTE');
  if (r.boundaryInputs !== undefined && (!Array.isArray(r.boundaryInputs) || r.boundaryInputs.length > 64)) throw new Error('INVALID_BOUNDARY_INPUTS');
  for (const amount of (r.boundaryInputs ?? []) as unknown[]) uint(amount);
  return structuredClone(r) as unknown as SizingRequest;
}
/** Deterministic sampled search. A certificate is issued only after evaluating every feasible quantum. */
export function sizeRoute(inputs: unknown, rawRequest: unknown): SizingResult {
  if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 6) throw new Error('INVALID_SIZING_POOLS');
  const pools = inputs.map(parsePoolState), request = parseSizingRequest(rawRequest);
  const snapshotDigest = digest(pools);
  if (snapshotDigest !== request.snapshotDigest) throw new Error('SNAPSHOT_DIGEST_MISMATCH');
  const identityDigest = digest(pools[0].identity), byId = new Map(pools.map(pool => [pool.poolId,pool]));
  if (byId.size !== pools.length || request.route.length !== pools.length || new Set(request.route.map(leg => leg.poolId)).size !== request.route.length || pools.some(pool => digest(pool.identity) !== identityDigest)) throw new Error('INCOHERENT_ROUTE_STATE');
  const same = (a: string,b: string) => pools[0].identity.chain !== 'sui' ? a.toLowerCase() === b.toLowerCase() : a === b;
  let token = request.borrowAsset;
  const route: Array<{ pool: PoolStateEnvelope; tokenIn: string; zeroForOne: boolean }> = [];
  for (const leg of request.route) {
    const pool = byId.get(leg.poolId);
    if (!pool || !same(token,leg.tokenIn)) throw new Error('INVALID_SIZING_ROUTE');
    const zeroForOne = same(token,pool.token0);
    if (!zeroForOne && !same(token,pool.token1)) throw new Error('INVALID_INPUT_ASSET');
    route.push({ pool, tokenIn: token, zeroForOne }); token = zeroForOne ? pool.token1 : pool.token0;
  }
  if (!same(token,request.borrowAsset)) throw new Error('NON_CIRCULAR_ROUTE');
  const quantum = uint(request.quantum), minimum = ceilDiv(uint(request.minimum),quantum) * quantum;
  let maximum = (uint(request.maximum) < uint(request.lenderAvailable) ? uint(request.maximum) : uint(request.lenderAvailable));
  // Never quote a V2 input whose full balance update exceeds uint112, or a Sui input exceeding u64.
  const first = route[0];
  if (first.pool.state.protocol === 'uniswap-v2') {
    const reserve = uint(first.zeroForOne ? first.pool.state.reserve0 : first.pool.state.reserve1);
    const capacity = (1n << 112n) - 1n - reserve; if (maximum > capacity) maximum = capacity;
  }
  if (pools[0].identity.chain === 'sui' && maximum >= 1n << 64n) maximum = (1n << 64n) - 1n;
  maximum = maximum / quantum * quantum;
  if (maximum < minimum) throw new Error('NO_FEASIBLE_SIZING_DOMAIN');
  const numerator = uint(request.flashFeeNumerator), denominator = uint(request.flashFeeDenominator), cost = uint(request.costInBorrowAsset);
  const budget = request.maxEvaluations ?? 512;
  const samples = new Map<bigint,{ profit: bigint; output: bigint; fee: bigint } | null>();
  const rejectedQuotes: Record<string,number> = {};
  let best: { amount: bigint; profit: bigint; output: bigint; fee: bigint; legs: ProjectionResult[] } | undefined;
  const evaluate = (raw: bigint) => {
    const amount = raw / quantum * quantum;
    if (amount < minimum || amount > maximum || samples.has(amount) || samples.size >= budget) return;
    try {
      let output = amount; const legs: ProjectionResult[] = [];
      for (const leg of route) {
        if (!output) throw new Error('ZERO_ROUTE_OUTPUT');
        const quote = projectPool(leg.pool, { schemaVersion: '4.0', snapshotDigest: digest(leg.pool), operationId: `sizing:${amount}:${leg.pool.poolId}`, operationClass: 'hypothetical', tokenIn: leg.tokenIn, amountIn: output.toString() });
        legs.push(quote); output = uint(quote.amountOut);
      }
      const fee = ceilDiv(amount * numerator,denominator), profit = output - amount - fee - cost;
      uint((amount + fee).toString());
      samples.set(amount,{ profit,output,fee });
      if (!best || profit > best.profit || (profit === best.profit && amount < best.amount)) best = { amount,profit,output,fee,legs };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!['CLMM_COVERAGE_EXHAUSTED','CLMM_INVALID_LIMIT','CLMM_STEP_LIMIT','CETUS_COVERAGE_EXHAUSTED','CETUS_STEP_LIMIT','ZERO_ROUTE_OUTPUT','V2_RESERVE_OVERFLOW','CETUS_OUTPUT_OVERFLOW','INTEGER_OUT_OF_RANGE'].includes(code)) throw error;
      samples.set(amount,null); rejectedQuotes[code] = (rejectedQuotes[code] ?? 0) + 1;
    }
  };
  const count = (maximum - minimum) / quantum + 1n;
  if (count <= BigInt(budget)) {
    for (let amount = minimum; amount <= maximum; amount += quantum) evaluate(amount);
  } else {
    evaluate(minimum); evaluate(maximum);
    if (route.length === 2 && route[0].pool.state.protocol === 'uniswap-v2' && route[1].pool.state.protocol === 'uniswap-v2') {
      const seed = v2StationarySeed(route[0].pool.state,route[1].pool.state,route[0].zeroForOne,route[1].zeroForOne,numerator,denominator);
      for (let offset = -8n; offset <= 8n; offset++) evaluate(seed / quantum * quantum + offset * quantum);
    }
    for (const boundary of request.boundaryInputs ?? []) { const amount = uint(boundary); evaluate(amount); evaluate(amount - quantum); evaluate(amount + quantum); }
    for (let i = 0n; i < 64n; i++) evaluate(minimum + (maximum - minimum) * i / 63n);
    while (samples.size < budget) {
      const points = [...samples.keys()].sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
      const intervals = points.slice(1).map((right,index) => {
        const left = points[index], profits = [samples.get(left)?.profit,samples.get(right)?.profit].filter((v): v is bigint => v !== undefined);
        return { left,right,score: profits.length ? profits.reduce((a,b) => a > b ? a : b) : undefined };
      }).filter(interval => interval.right - interval.left > quantum).sort((a,b) => {
        if (a.score === undefined || b.score === undefined) return a.score === b.score ? (a.left < b.left ? -1 : 1) : a.score === undefined ? 1 : -1;
        return a.score > b.score ? -1 : a.score < b.score ? 1 : a.left < b.left ? -1 : 1;
      });
      if (!intervals.length) break;
      const before = samples.size;
      for (const interval of intervals.slice(0,8)) evaluate((interval.left + interval.right) / 2n);
      if (before === samples.size) break;
    }
  }
  const selected = best && best.profit > 0n && best.profit >= uint(request.minProfit) ? best : undefined;
  return { schemaVersion: '4.0', status: selected ? 'selected' : 'no-profitable-size', optimality: BigInt(samples.size) === count && Object.keys(rejectedQuotes).every(code => ['ZERO_ROUTE_OUTPUT','NON_BASE_ROUTE_REMAINDER'].includes(code)) ? 'certified' : 'best-found', snapshotDigest, requestDigest: digest(request), stateClass: pools.every(pool => pool.stateClass === 'canonical') ? 'canonical' : 'projected', borrowAsset: request.borrowAsset, feasibleMinimum: minimum.toString(), feasibleMaximum: maximum.toString(), quantum: quantum.toString(), evaluations: samples.size, amountIn: selected?.amount.toString() ?? '0', amountOut: selected?.output.toString() ?? '0', flashFee: selected?.fee.toString() ?? '0', repayment: selected ? (selected.amount + selected.fee).toString() : '0', costInBorrowAsset: request.costInBorrowAsset, netProfit: selected?.profit.toString() ?? '0', legs: selected?.legs ?? [], rejectedQuotes };
}

/** Bridge to the existing simulation/signing runtime. A projected or altered quote cannot become a candidate.
 * The execution adapter still validates actual calldata/PTB semantics, pins and fresh chain effects.
 */
export function sizingToCandidate(inputs: unknown, rawRequest: unknown, result: SizingResult, rawSnapshot: LiquiditySnapshot,
  binding: { unsignedPayload: string; adapterId: string; adapterRevision: string; expiresAtMs: number; maxGasCost: string }): RouteCandidate {
  if (!Array.isArray(inputs)) throw new Error('INVALID_SIZING_POOLS');
  const pools = inputs.map(parsePoolState), request = parseSizingRequest(rawRequest), snapshot = parseSnapshot(rawSnapshot);
  if (result.schemaVersion !== '4.0' || result.status !== 'selected' || result.stateClass !== 'canonical' || pools.some(pool => pool.stateClass !== 'canonical') || result.snapshotDigest !== digest(pools) || result.requestDigest !== digest(request) || snapshot.stateDigest !== digest(pools) || !snapshot.complete || pools.some(pool => digest(pool.identity) !== digest(snapshot.identity) || !snapshot.poolIds.includes(pool.poolId))) throw new Error('ANALYTICS_CANDIDATE_STATE_MISMATCH');
  const amount = uint(result.amountIn), quantum = uint(request.quantum);
  if (!amount || amount % quantum || amount < uint(request.minimum) || amount > uint(request.maximum) || amount > uint(request.lenderAvailable)) throw new Error('ANALYTICS_CANDIDATE_AMOUNT_MISMATCH');
  const exact = sizeRoute(pools,{ ...request,minimum: result.amountIn,maximum: result.amountIn,maxEvaluations: 1 });
  if (exact.status !== 'selected' || ['amountIn','amountOut','flashFee','repayment','costInBorrowAsset','netProfit','borrowAsset'].some(key => exact[key as keyof SizingResult] !== result[key as keyof SizingResult]) || digest(exact.legs) !== digest(result.legs)) throw new Error('ANALYTICS_CANDIDATE_QUOTE_MISMATCH');
  if (typeof binding.adapterId !== 'string' || !binding.adapterId || binding.adapterId.length > 128 || typeof binding.adapterRevision !== 'string' || !binding.adapterRevision || binding.adapterRevision.length > 128 || typeof binding.unsignedPayload !== 'string' || !binding.unsignedPayload || binding.unsignedPayload.length > 2 * 1024 * 1024 || !Number.isSafeInteger(binding.expiresAtMs) || binding.expiresAtMs <= snapshot.observedAtMs || !uint(binding.maxGasCost) || uint(binding.maxGasCost) > uint(request.costInBorrowAsset)) throw new Error('INVALID_ANALYTICS_EXECUTION_BINDING');
  return { identity: snapshot.identity,stateDigest: snapshot.stateDigest,poolIds: pools.map(pool => pool.poolId),adapterId: binding.adapterId,adapterRevision: binding.adapterRevision,payloadDigest: digest(binding.unsignedPayload),borrowAmount: result.amountIn,profitAsset: `${snapshot.identity.chain}:${snapshot.identity.network}:${request.borrowAsset}`,minProfit: request.minProfit,maxGasCost: binding.maxGasCost,expiresAtMs: binding.expiresAtMs };
}

export interface ConditionalVenue {
  poolId: string; identity: StateIdentity; token0: string; token1: string;
  kind: 'pool' | 'algebra' | 'deepbook'; state: PoolStateEnvelope | AlgebraLinkedState | DeepBookBookState;
  feeResolutions: AlgebraFeeResolution[];
}
export interface ConditionalSizingResult {
  schemaVersion: '4.0'; eligibility: 'simulation-required'; status: 'selected' | 'no-profitable-size' | 'incomplete-evidence'; evidenceComplete: boolean;
  snapshotDigest: string; requestDigest: string; direction: 'forward' | 'reverse' | null;
  amountIn: string; amountOut: string; repayment: string; netProfit: string; evaluations: number;
  optimality: 'best-found' | 'certified'; quotes: unknown[]; rejectedQuotes: Record<string,number>;
}
/** Bounded native sizing across revision-specific CLMM/order-book calculators.
 * Results deliberately require venue compilation and fresh simulation before execution.
 */
export function sizeConditionalCycle(raw: ConditionalVenue[],rawRequest: unknown): ConditionalSizingResult {
  const request = parseSizingRequest(rawRequest);
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 6 || digest(raw) !== request.snapshotDigest) throw new Error('INVALID_CONDITIONAL_ROUTE');
  const venues = structuredClone(raw), byId = new Map(venues.map(v => [v.poolId,v]));
  const identity = parseStateIdentity(venues[0].identity), equal = (a: string,b: string) => identity.chain !== 'sui' ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (const venue of venues) {
    if (!venue || Object.keys(venue).sort().join(',') !== 'feeResolutions,identity,kind,poolId,state,token0,token1' || !['pool','algebra','deepbook'].includes(venue.kind) || digest(parseStateIdentity(venue.identity)) !== digest(identity) || typeof venue.poolId !== 'string' || !venue.poolId.startsWith(`${identity.chain}:${identity.network}:`) || typeof venue.token0 !== 'string' || typeof venue.token1 !== 'string' || equal(venue.token0,venue.token1) || !Array.isArray(venue.feeResolutions) || venue.feeResolutions.length > 512) throw new Error('INVALID_CONDITIONAL_ROUTE');
    if ((venue.kind === 'algebra' && identity.chain === 'sui') || (venue.kind === 'deepbook' && identity.chain !== 'sui')) throw new Error('PROTOCOL_CHAIN_MISMATCH');
    if (venue.kind === 'deepbook' && identity.chain === 'sui' && (venue.state as DeepBookBookState).checkpointDigest !== identity.checkpointDigest) throw new Error('CONDITIONAL_CHECKPOINT_MISMATCH');
    if (venue.kind === 'pool') {
      const pool = parsePoolState(venue.state);
      if (pool.poolId !== venue.poolId || digest(pool.identity) !== digest(identity) || pool.token0 !== venue.token0 || pool.token1 !== venue.token1 || venue.feeResolutions.length) throw new Error('INVALID_CONDITIONAL_ROUTE');
    }
  }
  if (byId.size !== venues.length || request.route.length !== venues.length || new Set(request.route.map(l => l.poolId)).size !== venues.length) throw new Error('INVALID_CONDITIONAL_ROUTE');
  let asset = request.borrowAsset;
  for (const leg of request.route) {
    const venue = byId.get(leg.poolId);
    if (!venue || !equal(asset,leg.tokenIn) || ![venue.token0,venue.token1].some(t => equal(t,asset))) throw new Error('INVALID_CONDITIONAL_ROUTE');
    asset = equal(asset,venue.token0) ? venue.token1 : venue.token0;
  }
  if (!equal(asset,request.borrowAsset)) throw new Error('NON_CIRCULAR_ROUTE');
  const quantum = uint(request.quantum), minimum = ceilDiv(uint(request.minimum),quantum) * quantum;
  let maximum = uint(request.maximum) < uint(request.lenderAvailable) ? uint(request.maximum) : uint(request.lenderAvailable);
  if (identity.chain === 'sui' && maximum >= 1n << 64n) maximum = (1n << 64n) - 1n;
  maximum = maximum / quantum * quantum;
  const count = maximum >= minimum ? (maximum - minimum) / quantum + 1n : 0n, budget = request.maxEvaluations ?? 512;
  if (!count) throw new Error('NO_FEASIBLE_SIZING_DOMAIN');
  const amounts = new Set<bigint>();
  if (count <= BigInt(budget)) for (let q = minimum; q <= maximum; q += quantum) amounts.add(q);
  else for (let i = 0; i < budget; i++) amounts.add((minimum + (maximum - minimum) * BigInt(i) / BigInt(Math.max(1,budget - 1))) / quantum * quantum);
  const reversed = [...request.route].reverse().map(leg => { const venue = byId.get(leg.poolId)!; return { poolId: leg.poolId,tokenIn: equal(leg.tokenIn,venue.token0) ? venue.token1 : venue.token0 }; });
  let best: { amount: bigint; output: bigint; debt: bigint; profit: bigint; direction: 'forward' | 'reverse'; quotes: unknown[] } | undefined, evaluations = 0;
  const rejectedQuotes: Record<string,number> = {};
  for (const [direction,route] of [['forward',request.route],['reverse',reversed]] as const) for (const amount of amounts) {
    evaluations++;
    try {
      let output = amount, refunds = 0n; const quotes: unknown[] = [];
      for (const leg of route) {
        const venue = byId.get(leg.poolId)!, zeroForOne = equal(leg.tokenIn,venue.token0);
        if (!output) throw new Error('ZERO_ROUTE_OUTPUT');
        let received: string, unspent = '0';
        if (venue.kind === 'pool') {
          const quote = projectPool(venue.state,{ schemaVersion: '4.0',snapshotDigest: digest(venue.state),operationId: `conditional:${direction}:${amount}:${venue.poolId}`,operationClass: 'hypothetical',tokenIn: leg.tokenIn,amountIn: output.toString() });
          received = quote.amountOut; unspent = quote.unspentInput; quotes.push(quote);
        } else if (venue.kind === 'algebra') {
          const quote = quoteAlgebraExactInput(venue.state as AlgebraLinkedState,zeroForOne,output.toString(),venue.feeResolutions.find(r => r.amountIn === output.toString() && r.zeroForOne === zeroForOne));
          received = quote.amountOut; quotes.push(quote);
        } else {
          const quote = quoteDeepBookExactInput(venue.state as DeepBookBookState,zeroForOne,output.toString());
          received = quote.amountOut; unspent = quote.unspentInput; quotes.push(quote);
        }
        if (uint(unspent)) { if (!equal(leg.tokenIn,request.borrowAsset)) throw new Error('NON_BASE_ROUTE_REMAINDER'); refunds += uint(unspent); }
        output = uint(received);
      }
      output += refunds;
      const debt = amount + ceilDiv(amount * uint(request.flashFeeNumerator),uint(request.flashFeeDenominator)); uint(debt.toString());
      const profit = output - debt - uint(request.costInBorrowAsset);
      if (profit > 0n && profit >= uint(request.minProfit) && (!best || profit > best.profit || (profit === best.profit && amount < best.amount))) best = { amount,output,debt,profit,direction,quotes };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!['CLMM_COVERAGE_EXHAUSTED','CLMM_INVALID_LIMIT','CLMM_STEP_LIMIT','CETUS_COVERAGE_EXHAUSTED','CETUS_STEP_LIMIT','ALGEBRA_COVERAGE_EXHAUSTED','ALGEBRA_STEP_LIMIT','UNRESOLVED_ALGEBRA_PLUGIN','ZERO_ROUTE_OUTPUT','V2_RESERVE_OVERFLOW','CETUS_OUTPUT_OVERFLOW','INTEGER_OUT_OF_RANGE','NON_BASE_ROUTE_REMAINDER'].includes(code)) throw error;
      rejectedQuotes[code] = (rejectedQuotes[code] ?? 0) + 1;
    }
  }
  const evidenceComplete = Object.keys(rejectedQuotes).every(code => ['ZERO_ROUTE_OUTPUT','NON_BASE_ROUTE_REMAINDER'].includes(code));
  return { schemaVersion: '4.0',eligibility: 'simulation-required',status: best ? 'selected' : evidenceComplete ? 'no-profitable-size' : 'incomplete-evidence',evidenceComplete,snapshotDigest: request.snapshotDigest,requestDigest: digest(request),direction: best?.direction ?? null,amountIn: best?.amount.toString() ?? '0',amountOut: best?.output.toString() ?? '0',repayment: best?.debt.toString() ?? '0',netProfit: best?.profit.toString() ?? '0',evaluations,optimality: evidenceComplete && BigInt(amounts.size) === count ? 'certified' : 'best-found',quotes: best?.quotes ?? [],rejectedQuotes };
}

export interface AttributionPlan {
  runId: string; planHash: string; stateDigest: string; requestedRaw: string; solvedRaw: string; netRaw: string;
  legs: Array<{ branchId: string; quote: ProjectionResult }>;
}
export interface AttributionAlternative { action:'SPLIT_EXIT_LEG'|'ADD_HUB_HOP';stateDigest:string;principalRaw:string;netRaw:string;addedCostRaw:string;replayed:boolean }
/** Attribute impact against the state immediately before each ordered leg, including decimal scaling. */
export function attributeLegs(plan:AttributionPlan,bundle:PoolStateEnvelope[],triggerPoolId?:string,alternatives:AttributionAlternative[]=[]){
  if(plan.stateDigest!==digest(bundle)||!plan.legs.length)throw new Error('ATTRIBUTION_STATE_MISMATCH');
  const states=new Map(bundle.map(p=>[p.poolId,parsePoolState(p)])),indices=new Map<string,number>();
  let dislocated=triggerPoolId;
  if(triggerPoolId&&!states.has(triggerPoolId))throw new Error('TRIGGER_POOL_MISMATCH');
  if(!dislocated){
    let greatest:{poolId:string;n:bigint;d:bigint}|undefined;
    const groups=new Map<string,PoolStateEnvelope[]>();
    for(const pool of bundle){const key=[pool.token0,pool.token1].sort().join(':');groups.set(key,[...(groups.get(key)??[]),pool]);}
    for(const venues of groups.values()){
      if(venues.length<2)continue;const base=[venues[0].token0,venues[0].token1].sort()[0];
      const points=venues.map(pool=>{const p=poolPrice(pool),normal=pool.token0===base,depth=executableDepth(pool,100,normal?'ask':'bid').inputAtoms.value;return {poolId:pool.poolId,price:normal?p:{numerator:p.denominator,denominator:p.numerator},weight:depth===null?0n:BigInt(depth)};}).filter(p=>p.weight>0n);
      const weight=points.reduce((n,p)=>n+p.weight,0n);if(!weight)continue;let mean=rational(0n,1n);
      for(const p of points)mean=rational(BigInt(mean.numerator)*BigInt(p.price.denominator)+BigInt(p.price.numerator)*p.weight*BigInt(mean.denominator),BigInt(mean.denominator)*BigInt(p.price.denominator));
      mean=rational(BigInt(mean.numerator),BigInt(mean.denominator)*weight);
      for(const p of points){const difference=BigInt(p.price.numerator)*BigInt(mean.denominator)-BigInt(mean.numerator)*BigInt(p.price.denominator),n=difference<0n?-difference:difference,d=BigInt(p.price.denominator)*BigInt(mean.numerator);if(d>0n&&(!greatest||n*greatest.d>greatest.n*d||n*greatest.d===greatest.n*d&&p.poolId<greatest.poolId))greatest={poolId:p.poolId,n,d};}
    }
    dislocated=greatest?.poolId;
  }
  const legs=plan.legs.map(({branchId,quote})=>{
    const pool=states.get(quote.projectedState.poolId);if(!pool||quote.snapshotDigest!==digest(pool))throw new Error('ATTRIBUTION_REPLAY_REQUIRED');
    const zero=quote.tokenIn===pool.token0,price=quote.priceBefore;
    const numerator=zero?BigInt(price.numerator):BigInt(price.denominator),denominator=zero?BigInt(price.denominator):BigInt(price.numerator);
    const inputDecimals=zero?pool.decimals0:pool.decimals1,outputDecimals=zero?pool.decimals1:pool.decimals0;
    const effective=uint(quote.consumedInput)-uint(quote.feeAmount),spot=effective*numerator*10n**BigInt(outputDecimals)/(denominator*10n**BigInt(inputDecimals));
    if(!spot)throw new Error('ATTRIBUTION_ZERO_SPOT');
    const index=indices.get(branchId)??0;indices.set(branchId,index+1);states.set(pool.poolId,quote.projectedState);
    return {branchId,legIndex:index,poolId:pool.poolId,inputRaw:quote.amountIn,outputRaw:quote.amountOut,spotOutputRaw:spot.toString(),feeRaw:quote.feeAmount,impactBps:{numerator:((spot-uint(quote.amountOut))*10000n).toString(),denominator:spot.toString()},isDislocatedLeg:pool.poolId===dislocated};
  });
  const dominant=legs.reduce((a,b)=>BigInt(a.impactBps.numerator)*BigInt(b.impactBps.denominator)>=BigInt(b.impactBps.numerator)*BigInt(a.impactBps.denominator)?a:b);
  const evaluated=alternatives.filter(a=>a.stateDigest===plan.stateDigest&&a.principalRaw===plan.solvedRaw&&a.replayed&&uint(a.addedCostRaw)>=0n);
  const best=evaluated.sort((a,b)=>BigInt(a.netRaw)>BigInt(b.netRaw)?-1:1)[0];
  const action=dominant.isDislocatedLeg?(uint(plan.solvedRaw)<uint(plan.requestedRaw)?'REDUCE_SIZE':'KEEP'):best&&BigInt(best.netRaw)>BigInt(plan.netRaw)?best.action:'KEEP';
  return {schemaVersion:'5.1' as const,recordType:'leg-attribution' as const,runId:plan.runId,planHash:plan.planHash,stateDigest:plan.stateDigest,legs,dominantImpactLeg:{branchId:dominant.branchId,legIndex:dominant.legIndex},hopDecision:{action,alternativesEvaluated:evaluated.length,netGainRaw:best?(BigInt(best.netRaw)-BigInt(plan.netRaw)).toString():null,addedCostRaw:best?.addedCostRaw??null,reason:!dislocated?'DISLOCATION_UNRESOLVED':dominant.isDislocatedLeg?'DISLOCATED_LEG_DOMINATES':best?'MATCHED_STATE_NET_COMPARISON':'ALTERNATIVE_NOT_SNAPSHOTTED'}};
}
