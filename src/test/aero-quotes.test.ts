import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteAeroExactInput } from '../aero/math.js';
import { sqrtRatioAtTick } from '../liquidity/clmm.js';
import { aeroFixture } from './aero-fixture.js';
import type { ClassicState, ConcentratedState } from '../aero/types.js';
test('AERO_IMPL_EDGE_02 exact native fee floors and external reserve accounting',()=>{
 const r=aeroFixture(),p=r.pools[0],s=p.state as ClassicState;s.reserve1=s.balance1='1000000';
 const q=quoteAeroExactInput(p,{...r.branches[0].legs[0],minOutBps:10000},'1');
 assert.equal(q.quote.amountOut,'999');assert.equal(q.quote.feeAmount,'0');assert.equal((q.projectedState.state as ClassicState).reserve0,'1001');
 const large=quoteAeroExactInput(p,r.branches[0].legs[0],'1000');assert.equal(large.quote.feeAmount,'3');assert.equal((large.projectedState.state as ClassicState).reserve0,'1997');assert.equal(s.reserve0,'1000');
 console.log('AERO_IMPL_EDGE_02');
});
test('stable normalizes mixed decimals and symmetric equal-unit prices without floating arithmetic',()=>{
 const r=aeroFixture(),p=r.pools[0];p.decimals0=6;p.decimals1=18;p.state={protocol:'aero-stable',stable:true,reserve0:'1000000000000',reserve1:'1000000000000000000000000',balance0:'1000000000000',balance1:'1000000000000000000000000',feeBps:1};
 const forward=quoteAeroExactInput(p,r.branches[0].legs[0],'1000000');assert.ok(BigInt(forward.quote.amountOut)>999000000000000000n);assert.ok(BigInt(forward.quote.amountOut)<=999900000000000000n);
 const back=quoteAeroExactInput(p,{...r.branches[0].legs[0],tokenIn:p.token1},'1000000000000000000');assert.ok(BigInt(back.quote.amountOut)>=999899n);assert.ok(BigInt(back.quote.amountOut)<=999900n);
});
test('CL traverses signed liquidity in both directions and rejects missing coverage/dynamic profiles',()=>{
 const r=aeroFixture(),p=r.pools[0];p.generation='cl-gauges-v3';
 for(const direction of [-1,1]){
 const tick=direction*60,position=Math.floor(tick/256),bit=tick-position*256;
 p.state={protocol:'aero-slipstream',sqrtPriceX96:sqrtRatioAtTick(0).toString(),tick:0,liquidity:'1000000000000',tickSpacing:1,feePips:3000,unlocked:true,lowerTick:-200,upperTick:200,bitmapWords:[-1,0].map(wordPosition=>({wordPosition,bitmap:(wordPosition===position?1n<<BigInt(bit):0n).toString()})),initializedTicks:[{tick,liquidityGross:'500000000000',liquidityNet:'500000000000'}],feeProfile:'fixed-proven',feeEvidenceDigest:'2'.repeat(64)};
 const leg={...r.branches[0].legs[0],tokenIn:direction<0?p.token0:p.token1,sqrtPriceLimitX96:sqrtRatioAtTick(direction*200).toString()};
 const quote=quoteAeroExactInput(p,leg,'4000000000');assert.equal((quote.projectedState.state as ConcentratedState).liquidity,direction<0?'500000000000':'1500000000000');
 (p.state as ConcentratedState).feeProfile='dynamic-evm';assert.throws(()=>quoteAeroExactInput(p,leg,'4000000000'),/UNSUPPORTED_FEE_PROFILE/);
 }
});
