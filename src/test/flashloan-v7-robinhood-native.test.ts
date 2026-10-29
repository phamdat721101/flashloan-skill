import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import type {Address,Hex} from 'viem';
import {partitionV4Inventory,resolveV4Pools,parseInitializeCache,serializeInitializeCache,v4PoolStateSlot,type V4Reader,type InitializeFact} from '../evm/v4-resolution.js';
import {parseInventory} from '../evm/pool-universe.js';
import {sha256Bytes,RoundCounters} from '../evidence/integration.js';
import {deriveV4PoolId} from '../state-adapters.js';

// Verbatim live MCP capture (inventory.v2): the adapter is proven on real payloads, not spec-shaped fixtures.
const read=(p:string)=>readFileSync(new URL(`../../${p}`,import.meta.url));
const capture=JSON.parse(read('src/test/fixtures/robinhood-mcp-inventory-20261029.json').toString());
const inventory=()=>parseInventory(structuredClone(capture.data),['flashloan.inventory.v2','flashloan.inventory.v3']);
const NATIVE='eip155:4663/slip44:60';

test('FLASHLOAN_V7_RH_EDGE_01 inventory: live MCP inventory.v2 rows reach the v4 resolver; foreign network is WRONG_CHAIN',()=>{
  const inv=inventory();
  const part=partitionV4Inventory(inv as never,4663);
  assert.equal(part.references.length,23,'every captured v4 row becomes a v4 reference');
  assert.equal(part.legacy.length,0,'no v4 row falls through to the legacy contract-address universe');
  assert.equal(part.rejected.length,0);
  assert.equal(part.references.filter(r=>r.assetIds.includes(NATIVE)).length,7,'native-ETH pools keep the slip44 identity');
  assert.ok(part.references.every(r=>r.provider==='dexscreener'&&/^0x[0-9a-f]{64}$/.test(r.providerPoolId)));
  const ids=inv.pools.map(p=>(p.reference as unknown as {providerPoolId:string}).providerPoolId.toLowerCase());
  assert.deepEqual(part.references.map(r=>r.providerPoolId),ids,'the provider pool id is used, never the MCP row hash');
  const foreign=partitionV4Inventory({pools:inv.pools.map(p=>({...p,reference:{...p.reference,network:'base'}}))} as never,4663);
  assert.equal(foreign.rejected.length,23);
  assert.ok(foreign.rejected.every(r=>r.reasonCode==='WRONG_CHAIN'));
  const legacyRow={id:'x',reference:{kind:'evm_contract',chainId:4663,address:'0x1111111111111111111111111111111111111111'},asset_ids:[],protocol:'uniswap-v3'};
  assert.deepEqual(partitionV4Inventory({pools:[legacyRow]},4663).legacy,[legacyRow],'contract-address rows still reach the legacy universe unchanged');
});

test('FLASHLOAN_V7_RH_EDGE_02 identity: the reviewed Robinhood mapping pins the canonical PoolManager',()=>{
  const bytes=read('config/v4-managers.robinhood.json'),mapping=JSON.parse(bytes.toString());
  assert.equal(mapping.schema,'v4-manager-mapping/1');
  assert.equal(mapping.chainId,'eip155:4663');
  const pins=JSON.parse(read('config/robinhood-mainnet.json').toString()).roots.find((r:{role:string})=>r.role==='v4-manager');
  assert.deepEqual(mapping.managers.map((m:{provider:string;manager:string;codeHash:string})=>[m.provider,m.manager.toLowerCase(),m.codeHash]),[['dexscreener',pins.address.toLowerCase(),pins.codeHash]],'mapping and deployment manifest pin the same manager and code hash');
  assert.match(sha256Bytes(bytes),/^sha256:[0-9a-f]{64}$/,'managerMappingRef binds these exact bytes');
});

test('FLASHLOAN_V7_RH_EDGE_02 identity: cached Initialize facts skip the log scan but are re-verified; a tampered cache never resolves',async()=>{
  const CHAIN='eip155:4663',MANAGER='0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address,CODE='0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626' as Hex;
  const WETH='0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address,ZERO='0x0000000000000000000000000000000000000000' as Address;
  const key={currency0:ZERO,currency1:WETH,fee:500,tickSpacing:10,hooks:ZERO},id=deriveV4PoolId(key) as Hex,hash=(n:bigint)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
  const fact:InitializeFact={id,key,tick:0,blockNumber:73_772_859n,blockHash:hash(73_772_859n)};
  const calls:string[]=[];
  const reader:V4Reader={
    async block(n){calls.push('block');const b=n??100_000_000n;return {number:b,hash:hash(b),parentHash:hash(b-1n),timestamp:1_793_000_000n};},
    async codeHash(){calls.push('code');return CODE;},
    async initializeLogs(){calls.push('logs');return [fact];},
    async extsload(_m,slot){calls.push('ext');return slot===v4PoolStateSlot(id)?1n<<96n:0n;},
    async decimals(){return 18;}
  };
  const mapping=Buffer.from(JSON.stringify({schema:'v4-manager-mapping/1',chainId:CHAIN,managers:[{provider:'dexscreener',manager:MANAGER,codeHash:CODE,fromBlock:'9070'}]}));
  const request={schema:'pool-resolution-request/1',roundId:'rh-1',chainId:CHAIN,references:[{provider:'dexscreener',providerPoolId:id,assetIds:[`${CHAIN}/slip44:60`,`${CHAIN}/erc20:${WETH}`]}],
    managerMappingRef:{kind:'configuration',contentHash:sha256Bytes(mapping),issuedAt:'2026-10-29T00:00:00Z',expiresAt:null,traceId:'rh-1',locator:'config/v4-managers.robinhood.json'},
    atBlock:null,limits:{maxRpcCalls:20,maxEvaluations:10,maxPools:4,maxRoutes:2,deadlineMs:30000,watchDurationMs:0}};
  const counters=()=>new RoundCounters({maxRpcCalls:20,maxEvaluations:10},Date.now()+60_000);
  // Cold: a 1M page keeps the scan from block 9070 inside a 20-call budget (250-block pages would need ~400k).
  const cold=await resolveV4Pools(request,reader,counters(),{mappingBytes:mapping,pageSize:1_000_000n});
  assert.equal((cold.report as {resolved:unknown[]}).resolved.length,1);
  assert.ok(calls.includes('logs'));
  const cache=parseInitializeCache(JSON.parse(JSON.stringify(serializeInitializeCache(CHAIN,cold.facts))),CHAIN);
  assert.deepEqual([...cache.keys()],[`${MANAGER}:${id}`],'cache round-trips with the manager-scoped key');
  calls.length=0;
  const warm=await resolveV4Pools(request,reader,counters(),{mappingBytes:mapping,knownFacts:cache});
  assert.equal((warm.report as {resolved:unknown[]}).resolved.length,1);
  assert.ok(!calls.includes('logs'),'a cached fact never re-scans Initialize logs');
  assert.ok(calls.includes('ext')&&calls.filter(c=>c==='block').length>=2,'slot0 and the Initialize block hash are still re-read');
  const tampered=new Map([[`${MANAGER}:${id}`,{...fact,key:{...key,fee:3000}}]]);
  const bad=await resolveV4Pools(request,reader,counters(),{mappingBytes:mapping,knownFacts:tampered});
  assert.deepEqual((bad.report as {unresolved:Array<{reasonCode:string}>}).unresolved.map(u=>u.reasonCode),['POOL_ID_MISMATCH']);
  assert.throws(()=>parseInitializeCache({schema:'v4-initialize-cache/1',chainId:'eip155:8453',facts:{}},CHAIN),/v4 initialize cache/);
});
