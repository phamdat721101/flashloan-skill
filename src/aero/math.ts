import { quoteV3ExactInput, sqrtRatioAtTick } from '../liquidity/clmm.js';
import { projectV2 } from '../liquidity/v2.js';
import { digest, uint } from '../liquidity/state.js';
import type { AeroLeg, AeroPool, AeroQuote, ClassicState, ConcentratedState } from './types.js';

const E=10n**18n, MAX=(1n<<256n)-1n;
const checked=(n:bigint)=>{if(n<0n||n>MAX)throw new Error('QUOTE_FAILED');return n;};
const add=(a:bigint,b:bigint)=>checked(a+b), mul=(a:bigint,b:bigint)=>checked(a*b), sub=(a:bigint,b:bigint)=>checked(a-b);
function invariant(x:bigint,y:bigint,d0:bigint,d1:bigint) {
  x=mul(x,E)/d0;y=mul(y,E)/d1;
  return mul(mul(x,y)/E,add(mul(x,x)/E,mul(y,y)/E))/E;
}
function f(x:bigint,y:bigint){return mul(mul(x,y)/E,add(mul(x,x)/E,mul(y,y)/E))/E;}
function derivative(x:bigint,y:bigint){return add(mul(mul(3n,x),mul(y,y)/E)/E,mul(mul(x,x)/E,x)/E);}
function stableY(x:bigint,k:bigint,y:bigint,d0:bigint,d1:bigint) {
  for(let i=0;i<255;i++) {
    const value=f(x,y), d=derivative(x,y);if(d===0n)throw new Error('QUOTE_FAILED');
    if(value<k){let delta=mul(k-value,E)/d;if(delta===0n){if(invariant(x,add(y,1n),d0,d1)>k)return add(y,1n);delta=1n;}y=add(y,delta);}
    else {let delta=mul(value-k,E)/d;if(delta===0n){if(value===k||f(x,sub(y,1n))<k)return y;delta=1n;}y=sub(y,delta);}
  }
  throw new Error('QUOTE_FAILED');
}
export function quoteClassic(pool: AeroPool, zeroForOne: boolean, amount: bigint) {
  const s=pool.state as ClassicState,x=uint(zeroForOne?s.reserve0:s.reserve1),y=uint(zeroForOne?s.reserve1:s.reserve0);
  const fee=mul(amount,BigInt(s.feeBps))/10000n, net=sub(amount,fee);
  let output:bigint;
  if(!s.stable)output=mul(y,net)/add(x,net);
  else {
    const d0=checked(10n**BigInt(pool.decimals0)),d1=checked(10n**BigInt(pool.decimals1));
    const dx=zeroForOne?d0:d1,dy=zeroForOne?d1:d0;
    const normalizedX=mul(x,E)/dx,normalizedY=mul(y,E)/dy;
    const next=stableY(add(normalizedX,mul(net,E)/dx),invariant(uint(s.reserve0),uint(s.reserve1),d0,d1),normalizedY,d0,d1);
    output=mul(sub(normalizedY,next),dy)/E;
  }
  const state={...s,reserve0:(zeroForOne?add(x,net):sub(y,output)).toString(),reserve1:(zeroForOne?sub(y,output):add(x,net)).toString()};
  state.balance0=state.reserve0;state.balance1=state.reserve1;
  return {amountOut:output,fee,state};
}
/** Exact integer projection; dynamic modules require an explicit ordered EVM host. */
export function quoteAeroExactInput(pool: AeroPool, leg: AeroLeg, amount: string, maxSteps=4096): {quote:AeroQuote;projectedState:AeroPool} {
  const input=uint(amount);if(!input||input>=1n<<255n||![pool.token0,pool.token1].includes(leg.tokenIn))throw new Error('QUOTE_FAILED');
  const zero=leg.tokenIn===pool.token0,s=pool.state;
  let state=structuredClone(s),out:string,fee:string;
  if(s.protocol==='aero-volatile'||s.protocol==='aero-stable') {
    const q=quoteClassic(pool,zero,input);state=q.state;out=q.amountOut.toString();fee=q.fee.toString();
    if(leg.sqrtPriceLimitX96!=='0')throw new Error('INVALID_INPUT');
  } else if(s.protocol==='uniswap-v2') {
    const q=projectV2(s,zero,amount);state={...q.state,protocol:'uniswap-v2'};out=q.amountOut;fee=q.feeAmount;
    if(leg.sqrtPriceLimitX96!=='0')throw new Error('INVALID_INPUT');
  } else {
    const cl=s as ConcentratedState;
    // dynamic-snapshot quotes at the capture-block module fee; only an EVM quoter can admit it.
    if(cl.feeProfile!=='fixed-proven'&&cl.feeProfile!=='dynamic-snapshot')throw new Error('UNSUPPORTED_FEE_PROFILE');
    const limit=uint(leg.sqrtPriceLimitX96,160),lower=sqrtRatioAtTick(cl.lowerTick),upper=sqrtRatioAtTick(cl.upperTick);
    // The shared traversal uses its proven horizon as the limit; accepting a
    // different limit would silently quote different calldata.
    const expected=zero?lower+(cl.lowerTick===-887272?1n:0n):upper-(cl.upperTick===887272?1n:0n);
    if(limit!==expected)throw new Error('INVALID_INPUT');
    const q=quoteV3ExactInput({...cl,protocol:'uniswap-v3',block:{chainId:8453,number:0n,hash:('0x'+'1'.repeat(64)) as `0x${string}`,timestamp:0n},pool:pool.address,runtimeCodeHash:pool.implementationCodeHash,token0:pool.token0,token1:pool.token1},leg.tokenIn,amount,cl.lowerTick,cl.upperTick,maxSteps);
    out=q.amountOut;fee=q.feeAmount;state={...cl,sqrtPriceX96:q.sqrtPriceAfterX96,tick:q.tickAfter,liquidity:q.liquidityAfter};
  }
  const minimum=uint(out)*BigInt(leg.minOutBps)/10000n;if(!minimum)throw new Error('QUOTE_FAILED');
  return {quote:{poolId:pool.poolId,tokenIn:leg.tokenIn,tokenOut:zero?pool.token1:pool.token0,amountIn:amount,consumedInput:amount,amountOut:out,feeAmount:fee,minAmountOut:minimum.toString(),sqrtPriceLimitX96:leg.sqrtPriceLimitX96,stateBeforeDigest:digest(s),stateAfterDigest:digest(state)},projectedState:{...pool,state}};
}
