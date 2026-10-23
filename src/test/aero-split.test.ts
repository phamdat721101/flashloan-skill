import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeAeroSplit, evaluateAeroSchedule } from '../aero/solver.js';
import { aeroFixture } from './aero-fixture.js';
import { AERO_SELECTOR, buildAeroSplitCalldata } from '../aero/execution.js';
import { digest } from '../liquidity/state.js';
import type { AeroPool } from '../aero/types.js';
const artifact={address:'0x0000000000000000000000000000000000000099' as const,runtimeCodeHash:`0x${'1'.repeat(64)}` as `0x${string}`,artifactHash:'1'.repeat(64),selector:AERO_SELECTOR,chainId:8453 as const};
test('AERO_IMPL_EDGE_03 exhaustive sizing agrees with an independent integer cyclic oracle',async()=>{
 const r=aeroFixture();r.bounds.maximum='20';
 const result=await optimizeAeroSplit(r);assert.equal(result.status,'selected');if(result.status!=='selected')return;
 let best=-1n,size=0n;for(let a=1n;a<=20n;a++){const u=a-a*30n/10000n,y=2000n*u/(1000n+u),x=y*997n*1000n/(1000000n+y*997n),net=x-a-1n;if(net>best){best=net;size=a;}}
 assert.equal(result.netProfit,best.toString());assert.equal(result.principal,size.toString());assert.equal(result.optimality,'best-found');
 const payload=buildAeroSplitCalldata(r,result,artifact);assert.equal(payload.data.slice(0,10),AERO_SELECTOR);assert.equal(payload.route.branches[0].legs[1].quotedAmountOut,BigInt(result.terminalReturn));
 const forged=structuredClone(result);forged.allocations[0].legs[0].amountOut='999';assert.throws(()=>buildAeroSplitCalldata(r,forged,artifact),/INVALID_INPUT/);
 assert.equal(result.requestDigest,digest(r));console.log('AERO_IMPL_EDGE_03');
});
test('shared counter-pool is replayed sequentially; allocation ratios conserve all principal',async()=>{
 const r=aeroFixture();r.bounds.minimum=r.bounds.maximum='100';r.branches.push({...structuredClone(r.branches[0]),branchId:'cycle-b'});
 const shared=evaluateAeroSchedule(r,[{branchId:'cycle-a',amountIn:'50'},{branchId:'cycle-b',amountIn:'50'}]);
 const independently=evaluateAeroSchedule(r,[{branchId:'cycle-a',amountIn:'50'}]);assert.ok(BigInt(shared.terminalReturn)<BigInt(independently.terminalReturn)*2n);
 const result=await optimizeAeroSplit(r);assert.equal(result.status,'selected');if(result.status==='selected'){assert.equal(result.allocations.reduce((s,a)=>s+BigInt(a.amountIn),0n),100n);assert.equal(result.allocations.reduce((s,a)=>s+a.ratioBps,0),10000);}
});
test('bounded search reports exhausted budgets honestly and cancellation never becomes a quote rejection',async()=>{
 const r=aeroFixture();r.limits.maxEvaluations=1;
 const result=await optimizeAeroSplit(r);assert.equal(result.budgetExhausted,true);assert.equal(result.evaluations,1);
 const signal=AbortSignal.abort();await assert.rejects(optimizeAeroSplit(aeroFixture(),{signal}));
});
test('no feasible lender and no profitable cycles never produce calldata',async()=>{
 const r=aeroFixture();r.lenders[0].available='0';const result=await optimizeAeroSplit(r);assert.notEqual(result.status,'selected');
 (r.pools[0].state as Extract<AeroPool['state'],{reserve0:string}>).reserve1='1000';(r.pools[0].state as any).balance1='1000';r.lenders[0].available='1000';assert.notEqual((await optimizeAeroSplit(r)).status,'selected');
});

test('failed candidate evaluation cannot certify an optimum and helper errors respect the result schema',async()=>{
 const r=aeroFixture();r.bounds.minimum='5';r.bounds.maximum='20';
 const complete=await optimizeAeroSplit(r,{exactCosts:true,evaluateSchedule:async(r,_l,a)=>evaluateAeroSchedule(r,a)});
 assert.equal(complete.status,'selected');if(complete.status!=='selected')return;assert.equal(complete.optimality,'certified');
 const partial=await optimizeAeroSplit(r,{exactCosts:true,evaluateSchedule:async(r,_l,a)=>{if(a.reduce((s,x)=>s+BigInt(x.amountIn),0n)===BigInt(complete.principal))throw new Error('RPC_TIMEOUT');return evaluateAeroSchedule(r,a);}});
 assert.equal(partial.status,'selected');if(partial.status==='selected')assert.equal(partial.optimality,'best-found');
 r.identity.blockNumber=(1n<<64n).toString();const invalid=await optimizeAeroSplit(r);assert.equal(invalid.status,'rejected');if(invalid.status==='rejected')assert.equal(invalid.reason,'INVALID_INPUT');
});
test('all two-branch integer allocations match an independent sequential reserve oracle',async()=>{
 const r=aeroFixture();r.bounds.minimum='5';r.bounds.maximum='12';r.branches.push({...structuredClone(r.branches[0]),branchId:'cycle-b'});
 let best=-1n;
 for(let total=5n;total<=12n;total++)for(let first=0n;first<=total;first++){
   let x=1000n,y=2000n,u=1000n,v=1000n,terminal=0n,feasible=true;
   for(const amount of[first,total-first]){if(!amount)continue;const net=amount-amount*30n/10000n,out=y*net/(x+net);x+=net;y-=out;const back=out*997n*u/(v*1000n+out*997n);u-=back;v+=out;if(!out||!back){feasible=false;break;}terminal+=back;}
   if(feasible&&terminal-total-1n>best)best=terminal-total-1n;
 }
 const result=await optimizeAeroSplit(r);assert.equal(result.status,'selected');if(result.status==='selected')assert.equal(result.netProfit,best.toString());
});
