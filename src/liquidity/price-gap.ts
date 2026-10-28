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
