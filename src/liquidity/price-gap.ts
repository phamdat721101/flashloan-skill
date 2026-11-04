import {validateV2} from './v2.js';
import {composeCurves, type SerialCurve} from '../evm/cycle-engine.js';
import {uint} from './state.js';
import type {PoolStateEnvelope} from './projection.js';

export function serialCpmmCurve(pools:readonly PoolStateEnvelope[],route:readonly {poolId:string;tokenIn:string}[]):SerialCurve|null {
  const byId=new Map(pools.map(p=>[p.poolId,p]));
  const hops:SerialCurve[]=[];
  for(const leg of route){const p=byId.get(leg.poolId);if(!p||p.state.protocol!=='uniswap-v2')return null;
    validateV2(p.state);const zero=leg.tokenIn===p.token0;if(!zero&&leg.tokenIn!==p.token1)throw new Error('INVALID_INPUT_ASSET');
    hops.push({a:uint(p.state.feeNumerator)*uint(zero?p.state.reserve1:p.state.reserve0),b:uint(p.state.feeDenominator)*uint(zero?p.state.reserve0:p.state.reserve1),c:uint(p.state.feeNumerator)});
  }
  return composeCurves(hops);
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
