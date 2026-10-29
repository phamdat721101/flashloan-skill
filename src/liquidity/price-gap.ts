import {integerSqrt, validateV2} from './v2.js';
import {uint} from './state.js';
import type {PoolStateEnvelope} from './projection.js';

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
export function serialCpmmCurve(pools:readonly PoolStateEnvelope[],route:readonly {poolId:string;tokenIn:string}[]):SerialCurve|null {
  const byId=new Map(pools.map(p=>[p.poolId,p]));
  const hops:SerialCurve[]=[];
  for(const leg of route){const p=byId.get(leg.poolId);if(!p||p.state.protocol!=='uniswap-v2')return null;
    validateV2(p.state);const zero=leg.tokenIn===p.token0;if(!zero&&leg.tokenIn!==p.token1)throw new Error('INVALID_INPUT_ASSET');
    hops.push({a:uint(p.state.feeNumerator)*uint(zero?p.state.reserve1:p.state.reserve0),b:uint(p.state.feeDenominator)*uint(zero?p.state.reserve0:p.state.reserve1),c:uint(p.state.feeNumerator)});
  }
  return composeCurves(hops);
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
export interface AllocationSearch { amounts: bigint[]; order: number[]; net: bigint | null; explored: number; ordersTried: number }
/**
 * Bounded unequal-split search for one route subset (v6 §5.2). Seeds singles, the equal split and an
 * optional CPMM seed, walks a 2500 bps simplex grid (k ≤ 3), then refines by pairwise quantum transfers
 * with halving steps. Overlapping routes also try every branch order for the incumbent. `evaluate`
 * owns attempt counting; this function only reads `remaining`. Never claims optimality.
 */
export function searchAllocation(input: { k: number; total: bigint; quantum: bigint; overlap: boolean; deadline: number; cpmmSeed?: bigint[];
  remaining: () => number; evaluate: (order: number[], amounts: bigint[]) => bigint | null }): AllocationSearch {
  const { k, total, quantum } = input;
  if (k < 2 || k > 8 || quantum <= 0n || total < 0n || total % quantum) throw new Error('INVALID_ALLOCATION');
  const identity = [...Array(k).keys()], seen = new Set<string>();
  let best: { amounts: bigint[]; order: number[]; net: bigint } | null = null, explored = 0, ordersTried = 0, stopped = false;
  const attempt = (amounts: bigint[], order = identity): boolean => {
    const key = `${order.join(',')}|${amounts.join(',')}`;
    if (stopped || seen.has(key) || amounts.some(a => a < 0n)) return false;
    if (input.remaining() <= 0 || performance.now() >= input.deadline) { stopped = true; return false; }
    seen.add(key); explored++;
    const net = input.evaluate(order, amounts);
    if (net === null || best && net <= best.net) return false;
    best = { amounts, order, net }; return true;
  };
  const fromWeights = (w: number[]) => {
    const a = w.map(x => total * BigInt(x) / 10000n / quantum * quantum);
    let top = 0; for (let i = 1; i < k; i++) if (w[i] > w[top]) top = i;
    a[top] += total - a.reduce((s, x) => s + x, 0n); return a;
  };
  for (let i = 0; i < k; i++) attempt(identity.map(j => j === i ? total : 0n));
  const equal = identity.map(() => total / BigInt(k) / quantum * quantum); equal[0] += total - equal.reduce((s, x) => s + x, 0n); attempt(equal);
  if (input.cpmmSeed?.length === k && input.cpmmSeed.reduce((s, x) => s + x, 0n) === total) attempt([...input.cpmmSeed]);
  if (k <= 3) {
    const points: number[][] = [];
    const walk = (prefix: number[], left: number) => { if (prefix.length === k - 1) { points.push([...prefix, left]); return; } for (let w = 0; w <= left; w += 2500) walk([...prefix, w], left - w); };
    walk([], 10000); for (const w of points) attempt(fromWeights(w));
  }
  let step = total / 4n / quantum * quantum;
  while (best && step >= quantum && !stopped) {
    let improved = false; const incumbent: { amounts: bigint[]; order: number[] } = best;
    for (let i = 0; i < k && !improved; i++) for (let j = 0; j < k && !improved; j++) {
      if (i === j || incumbent.amounts[i] < step) continue;
      const next = [...incumbent.amounts]; next[i] -= step; next[j] += step;
      improved = attempt(next, incumbent.order);
    }
    if (!improved) step = step / 2n / quantum * quantum;
  }
  if (best && input.overlap) {
    const incumbent: { amounts: bigint[]; order: number[] } = best;
    const active = identity.filter(i => incumbent.amounts[i] > 0n), inactive = identity.filter(i => incumbent.amounts[i] === 0n);
    const permute = (rest: number[], prefix: number[]): number[][] => rest.length ? rest.flatMap((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...prefix, x])) : [prefix];
    for (const order of permute(active, [])) { ordersTried++; attempt(incumbent.amounts, [...order, ...inactive]); }
  }
  const result = best as { amounts: bigint[]; order: number[]; net: bigint } | null;
  return { amounts: result?.amounts ?? equal, order: result?.order ?? identity, net: result?.net ?? null, explored, ordersTried };
}
