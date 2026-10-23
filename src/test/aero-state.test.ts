import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAeroRequest } from '../aero/types.js';
import { aeroFixture } from './aero-fixture.js';
import { resolveAeroImplementation } from '../aero/capture.js';
const address='0x0000000000000000000000000000000000000011' as const;
test('AERO_IMPL_EDGE_01 rejects wrong chain, numeric money, duplicate references and incomplete cycles',()=>{
  for(const change of [(r:any)=>{r.identity.chainId=10;},(r:any)=>{r.bounds.quantum=0;},(r:any)=>{r.branches[0].legs[1].tokenIn=r.borrowAsset;},(r:any)=>{r.pools.push(r.pools[0]);},(r:any)=>{r.pools[0].state.stable=true;},(r:any)=>{r.cost.costInBorrowAsset='2';},(r:any)=>{r.bounds.maximum='101';r.bounds.quantum='2';}]){
    const r=aeroFixture();change(r);assert.throws(()=>parseAeroRequest(r));
  }
  console.log('AERO_IMPL_EDGE_01');
});
test('clone resolution preserves the implementation instead of pinning only a shared shell',()=>{
  assert.equal(resolveAeroImplementation(address,`0x363d3d373d3d3d363d73${'2'.repeat(40)}5af43d82803e903d91602b57fd5bf3`),`0x${'2'.repeat(40)}`);
  assert.equal(resolveAeroImplementation(address,'0x6000'),address);
});

test('gas conversion rejects arbitrary native ratios and enforces the stricter request price age',async()=>{
 const {verifyAeroValuation}=await import('../aero/execution.js');
 const r=aeroFixture(),weth='0x4200000000000000000000000000000000000006' as const;
 r.cost.nativeAsset=weth;r.borrowAsset=weth;r.cost.conversionNumerator='1';r.cost.conversionDenominator='1000000000000000000';
 await assert.rejects(verifyAeroValuation({} as any,r),/COST_EVIDENCE_INVALID/);
 r.borrowAsset='0x0000000000000000000000000000000000000011';
 const nativeUsdFeed='0x0000000000000000000000000000000000000041' as const,assetUsdFeed='0x0000000000000000000000000000000000000042' as const;
 for(const address of[nativeUsdFeed,assetUsdFeed])r.pins.push({address,role:'price-feed',codeHash:`0x${'1'.repeat(64)}`,sourceRevision:'1'.repeat(40)});
 const client={getBlock:async()=>({timestamp:10000n}),readContract:async(a:any)=>a.functionName==='decimals'?8:[1n,a.address===nativeUsdFeed?200000000000n:100000000n,1n,6400n,1n]} as any;
 await assert.rejects(verifyAeroValuation(client,r,{valuation:{asset:r.borrowAsset,decimals:6,nativeUsdFeed,assetUsdFeed,maxAgeSeconds:86400}}),/INVALID_OR_STALE_PRICE/);
});
