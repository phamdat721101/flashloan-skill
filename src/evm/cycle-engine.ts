import { integerSqrt } from '../liquidity/v2.js';
/**
 * Read-only multi-token cycle engine. Pure: every quote is injected, so the same code runs against exact
 * on-chain quotes (cycle-watch.ts) and deterministic test curves. Exact math decides size and split; the
 * token bandit only decides where to look next and never authorizes a trade.
 */
export interface Edge { pool: string; tokenIn: string; tokenOut: string; logRate: number }
export interface Cycle { edges: Edge[]; edgeBps: number }
export type Quote = (pool: string, tokenIn: string, amountIn: bigint) => Promise<bigint>;

/* ---- Exact-integer allocation (PRD §6, §17 A1). Moved from src/liquidity/price-gap.ts (R9, D1 Original arrangement). ---- */
/** Continuous rational curves are seeds only. Rounded protocol quotes authorize candidates. */
export interface SerialCurve { a: bigint; b: bigint; c: bigint }
export function composeCurves(hops: readonly SerialCurve[]): SerialCurve {
  if(hops.length<1||hops.length>6)throw new Error('INVALID_CURVE_HOPS');
  let result:SerialCurve|undefined;
  for(const next of hops){
    if(next.a<=0n||next.b<=0n||next.c<=0n)throw new Error('INVALID_CURVE');
    const r=result;
    result=r?{a:next.a*r.a,b:next.b*r.b,c:next.b*r.c+next.c*r.a}:{...next};
    let gcd=result.a;for(const value of [result.b,result.c]){let b=value;while(b)[gcd,b]=[b,gcd%b];}
    result={a:result.a/gcd,b:result.b/gcd,c:result.c/gcd};
  }
  return result!;
}
export function stationaryInput(curve:SerialCurve,feeNumerator:bigint,feeDenominator:bigint):bigint {
  if(feeNumerator<0n||feeDenominator<=0n)throw new Error('INVALID_LENDER_FEE');
  const root=integerSqrt(curve.a*curve.b*feeDenominator/(feeDenominator+feeNumerator));
  return root>curve.b?(root-curve.b)/curve.c:0n;
}
/** Exact integer water filling for continuous disjoint CPMM curves. Quote rounding is replayed later. */
export function allocateCpmm(curves:readonly SerialCurve[],total:bigint,quantum:bigint,deadline=Infinity):bigint[] {
  if(!curves.length||curves.length>8||total<0n||quantum<=0n||total%quantum)throw new Error('INVALID_ALLOCATION');
  for(const c of curves)if(c.a<=0n||c.b<=0n||c.c<=0n)throw new Error('INVALID_CURVE');
  // Scale the marginal multiplier from coefficient bit widths, not token decimals.
  // This bounds work by integer precision even when total/quantum is enormous.
  const bits=Math.max(...curves.flatMap(c=>[c.a,c.b,c.c]).concat(total).map(n=>n.toString(2).length));
  const scale=1n<<BigInt(bits*4+64);
  const at=(lambda:bigint)=>curves.map(c=>{const root=integerSqrt(c.a*c.b*scale/lambda);return root>c.b?(root-c.b)/c.c/quantum*quantum:0n;});
  let lo=1n,hi=curves.reduce((m,c)=>{const v=(c.a*scale+c.b-1n)/c.b;return v>m?v:m;},1n)+1n;
  while(lo<hi){if(performance.now()>=deadline)throw new Error('SOLVE_DEADLINE');const mid=(lo+hi)/2n;const sum=at(mid).reduce((a,b)=>a+b,0n);if(sum>total)lo=mid+1n;else hi=mid;}
  const amounts=at(lo);let remaining=total-amounts.reduce((a,b)=>a+b,0n);
  // Quantization leaves fewer than one quantum per active curve at this precision.
  // Allocate residual by greatest exact next-quantum gain, with stable ties.
  for(let step=0;remaining&&step<curves.length*2;step++){
    let best=0;
    const gain=(i:number)=>{const c=curves[i],x=amounts[i];return {n:c.a*c.b*quantum,d:(c.b+c.c*x)*(c.b+c.c*(x+quantum))};};
    for(let i=1;i<curves.length;i++){const a=gain(i),b=gain(best);if(a.n*b.d>b.n*a.d)best=i;}
    amounts[best]+=quantum;remaining-=quantum;
  }
  if(remaining)throw new Error('ALLOCATION_PRECISION_EXHAUSTED');
  // Rounded continuous allocations may need an exchange, not merely residual assignment.
  const gain=(i:number,x:bigint)=>{const c=curves[i];return {n:c.a*c.b*quantum,d:(c.b+c.c*x)*(c.b+c.c*(x+quantum))};};
  for(let step=0;step<curves.length*curves.length;step++){
    let changed=false;
    for(let from=0;from<curves.length&&!changed;from++)if(amounts[from]>=quantum){
      const loss=gain(from,amounts[from]-quantum);
      for(let to=0;to<curves.length;to++)if(to!==from){const extra=gain(to,amounts[to]);if(extra.n*loss.d>loss.n*extra.d){amounts[from]-=quantum;amounts[to]+=quantum;changed=true;break;}}
    }
    if(!changed)break;
  }
  return amounts;
}
/** §6.4 λ water-filling under its PRD name; one implementation. */
export const solveSplitLambda = allocateCpmm;

/* ---- §6 allocation API (R4). Seeds only: an exact quote always decides (A3). ---- */
const Q96 = 1n << 96n, PIPS = 1_000_000n;
export interface HopCurve { curve: SerialCurve; cpmm: boolean }
/** One constant-product hop `f(x)=γ·x·R_out/(R_in+γ·x)` with γ = 1 − feePips/1e6, as a Möbius curve. */
export function hopCurve(reserveIn: bigint, reserveOut: bigint, feePips: number, cpmm = true): HopCurve {
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('INVALID_RESERVES');
  if (!Number.isInteger(feePips) || feePips < 0 || feePips >= 1_000_000) throw new Error('INVALID_FEE');
  const g = PIPS - BigInt(feePips);
  return { curve: { a: g * reserveOut, b: PIPS * reserveIn, c: g }, cpmm };
}
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** In-tick virtual reserves of a concentrated-liquidity pool (raw units, Q96). The input side rounds up and the
 * output side rounds down, so a seed never overstates output (A8). Valid only until the next initialized tick. */
export function clVirtualReserves(liquidity: bigint, sqrtPriceX96: bigint, zeroForOne: boolean): { reserveIn: bigint; reserveOut: bigint } {
  if (liquidity <= 0n) throw new Error('ZERO_ACTIVE_LIQUIDITY');
  if (sqrtPriceX96 <= 0n) throw new Error('INVALID_SQRT_PRICE');
  const n0 = liquidity * Q96, n1 = liquidity * sqrtPriceX96;
  return zeroForOne ? { reserveIn: ceilDiv(n0, sqrtPriceX96), reserveOut: n1 / Q96 } : { reserveIn: ceilDiv(n1, Q96), reserveOut: n0 / sqrtPriceX96 };
}
/** §6.1: folds every hop into one curve; null when any hop is not constant-product (use `probeBracket`). */
export function foldCycle(hops: readonly HopCurve[]): SerialCurve | null {
  return hops.length && hops.every(h => h.cpmm) ? composeCurves(hops.map(h => h.curve)) : null;
}
/** §6.2 closed-form principal with lender fee φ = feeNumerator/feeDenominator (default: bps). Edge exists iff > 0. */
export function seedPrincipal(curve: SerialCurve, feeNumerator: bigint, feeDenominator = 10_000n): bigint {
  return stationaryInput(curve, feeNumerator, feeDenominator);
}
export type SeedMethod = 'fold_closed_form' | 'probe_bracket';
/** The exact-refine bracket (A3): always refined; narrower when every hop is CPMM. A non-CPMM cycle has no
 * closed form, so it searches from the probe size up to half the shallowest pool's virtual depth (finding 6). */
export function refineBracket(seed: { method: 'fold_closed_form'; dStar: bigint; allCpmm: boolean } | { method: 'probe_bracket'; probe: bigint; shallowDepth: bigint }): { min: bigint; max: bigint } | null {
  if (seed.method === 'probe_bracket') { const max = seed.shallowDepth / 2n; return seed.probe > 0n && max >= seed.probe ? { min: seed.probe, max } : null; }
  if (seed.dStar <= 0n) return null;
  const [lo, hi] = seed.allCpmm ? [seed.dStar / 2n, seed.dStar * 2n] : [seed.dStar / 4n, seed.dStar * 4n];
  return { min: lo > 0n ? lo : 1n, max: hi };
}
/** §6.6: net is priced from what the executor itself requests, never from the larger quote. */
export const pricedOut = (quoted: bigint, executorRequested: bigint) => quoted < executorRequested ? quoted : executorRequested;
export interface LenderOption { id: string; feeBps: number; available: bigint; gasRaw: bigint; rooted: boolean }
/** §6.5: among config-rooted lenders (B3), minimize φ·d + gas; when none covers d, cap at the deepest. */
export function chooseLender(lenders: readonly LenderOption[], amount: bigint): { lender: LenderOption; principal: bigint } | null {
  if (amount <= 0n) return null;
  const rooted = lenders.filter(l => l.rooted && l.available > 0n);
  const cost = (l: LenderOption) => amount * BigInt(l.feeBps) / 10_000n + l.gasRaw;
  const covering = rooted.filter(l => l.available >= amount).sort((x, y) => cost(x) < cost(y) ? -1 : cost(x) > cost(y) ? 1 : x.id.localeCompare(y.id));
  if (covering.length) return { lender: covering[0], principal: amount };
  const deepest = [...rooted].sort((x, y) => y.available > x.available ? 1 : y.available < x.available ? -1 : x.id.localeCompare(y.id))[0];
  return deepest ? { lender: deepest, principal: deepest.available } : null;
}

/** The best `keep` simple cycles of 2..maxHops edges that start and end at a flash asset, best marginal edge first.
 * Enumeration is exhaustive (a cap on found cycles would keep the first ones, not the best); `stats.found` counts all.
 * A pool is used at most once per cycle and intermediate tokens never repeat. */
export function findCycles(edges: readonly Edge[], starts: readonly string[], maxHops = 4, keep = 2_000, stats: { found: number } = { found: 0 }): Cycle[] {
  if (maxHops < 2 || maxHops > 6) throw new Error('INVALID_MAX_HOPS');
  const adj = new Map<string, Edge[]>();
  for (const e of edges) if (Number.isFinite(e.logRate)) adj.set(e.tokenIn, [...(adj.get(e.tokenIn) ?? []), e]);
  let out: Cycle[] = [];
  const path: Edge[] = [], pools = new Set<string>(), tokens = new Set<string>();
  const record = (cycle: Cycle) => { stats.found++; out.push(cycle); if (out.length > keep * 2) out = out.sort((a, b) => b.edgeBps - a.edgeBps).slice(0, keep); };
  const walk = (start: string, node: string, sum: number) => {
    for (const e of adj.get(node) ?? []) {
      if (pools.has(e.pool)) continue;
      if (e.tokenOut === start) { if (path.length >= 1) record({ edges: [...path, e], edgeBps: (Math.exp(sum + e.logRate) - 1) * 1e4 }); continue; }
      if (path.length + 1 >= maxHops || tokens.has(e.tokenOut)) continue;
      pools.add(e.pool); tokens.add(e.tokenOut); path.push(e);
      walk(start, e.tokenOut, sum + e.logRate);
      path.pop(); tokens.delete(e.tokenOut); pools.delete(e.pool);
    }
  };
  for (const s of new Set(starts)) { tokens.add(s); walk(s, s, 0); tokens.delete(s); }
  return out.sort((a, b) => b.edgeBps - a.edgeBps).slice(0, keep);
}

/** Maximizes a unimodal (concave) bigint objective on [min, max]: doubling bracket, then golden-section.
 * `f` returns null where the route cannot fill; that point is treated as beyond the optimum. */
export async function maximizeConcave(f: (x: bigint) => Promise<bigint | null>, min: bigint, max: bigint, iterations = 20):
  Promise<{ x: bigint; value: bigint; evaluations: number } | null> {
  if (min <= 0n || max < min) throw new Error('INVALID_SIZE_DOMAIN');
  const seen = new Map<bigint, bigint | null>(); let evaluations = 0;
  const at = async (x: bigint) => { if (!seen.has(x)) { seen.set(x, await f(x)); evaluations++; } return seen.get(x)!; };
  let best = min, bestValue = await at(min);
  if (bestValue === null) return null;
  // Integer rounding makes tiny sizes flat or noisy: scan the whole geometric grid, and stop early only once a
  // positive peak has been passed twice (concavity guarantees nothing better lies beyond it).
  for (let x = min * 2n, misses = 0; x <= max && misses < 2; x *= 2n) {
    const v = await at(x);
    if (v === null) break;
    if (v > bestValue) { best = x; bestValue = v; misses = 0; } else if (bestValue > 0n) misses++;
  }
  let lo = best / 2n > min ? best / 2n : min, hi = max < best * 2n ? max : best * 2n;
  for (let i = 0; i < iterations && hi - lo > 2n; i++) {
    const third = (hi - lo) / 3n, a = lo + third, b = hi - third, va = await at(a), vb = await at(b);
    if (va !== null && (vb === null || va >= vb)) hi = b; else lo = a;
  }
  for (const [x, v] of seen) if (v !== null && v > bestValue) { best = x; bestValue = v; }
  return { x: best, value: bestValue, evaluations };
}

/** Greedy marginal split of `total` over parallel pools in equal chunks. For concave outputs this equals the
 * optimum at chunk granularity: each chunk goes where the next unit buys the most. `openCost` (output units) is
 * charged when a chunk opens an unused pool, because every extra leg costs gas. */
export async function splitAmount(quotes: readonly ((x: bigint) => Promise<bigint>)[], total: bigint, chunks = 8, openCost = 0n): Promise<{ amounts: bigint[]; out: bigint }> {
  if (!quotes.length || total <= 0n || chunks < 1) throw new Error('INVALID_SPLIT');
  const amounts = quotes.map(() => 0n), outs = quotes.map(() => 0n), chunk = total / BigInt(chunks);
  for (let i = 0; i < chunks; i++) {
    const step = i === chunks - 1 ? total - chunk * BigInt(chunks - 1) : chunk;
    let pick = -1, gain = -1n, pickOut = 0n;
    const nexts = await Promise.all(quotes.map((q, j) => q(amounts[j] + step)));
    for (let j = 0; j < quotes.length; j++) {
      const marginal = nexts[j] - outs[j] - (amounts[j] === 0n && i > 0 ? openCost : 0n);
      if (marginal > gain) { pick = j; gain = marginal; pickOut = nexts[j]; }
    }
    if (pick < 0 || gain <= 0n) break;
    amounts[pick] += step; outs[pick] = pickOut;
  }
  return { amounts, out: outs.reduce((s, x) => s + x, 0n) };
}

/** Thompson-sampling token bandit (Beta posterior). Reward = the token sat on a near-break-even cycle.
 * Ranks which tokens to expand in the next MCP discovery round; it never sizes or admits a trade. */
export interface BanditState { schemaVersion: 'token-bandit/1'; arms: Record<string, { alpha: number; beta: number }> }
export class TokenBandit {
  readonly state: BanditState;
  constructor(state?: BanditState, private readonly random: () => number = Math.random) {
    this.state = state?.schemaVersion === 'token-bandit/1' ? state : { schemaVersion: 'token-bandit/1', arms: {} };
  }
  update(token: string, reward: boolean) {
    const arm = this.state.arms[token] ??= { alpha: 1, beta: 1 };
    if (reward) arm.alpha++; else arm.beta++;
  }
  rank(tokens: readonly string[]): { token: string; sample: number; mean: number }[] {
    return tokens.map(token => { const a = this.state.arms[token] ?? { alpha: 1, beta: 1 }; return { token, sample: this.beta(a.alpha, a.beta), mean: a.alpha / (a.alpha + a.beta) }; })
      .sort((x, y) => y.sample - x.sample);
  }
  private beta(a: number, b: number) { const x = this.gamma(a), y = this.gamma(b); return x / (x + y); }
  /** Marsaglia–Tsang; shape ≥ 1 always holds because arms start at Beta(1,1). */
  private gamma(k: number): number {
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number, v: number;
      do { x = this.normal(); v = 1 + c * x; } while (v <= 0);
      v = v ** 3; const u = this.random() || 1e-12;
      if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
    }
  }
  private normal() { const u = this.random() || 1e-12, v = this.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
}
