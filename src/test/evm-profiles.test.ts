import { discoveryTickWindow, isProfitAssetPool } from '../evm/discovery.js';
import { assertTickWindowCoverage } from '../state-adapters.js';
import { EvmBudget, TRADING_GAS_CAP } from '../evm/budget.js';
import { recoverDeadExecutionLock } from '../execution-lock.js';
import { nativeCostInAsset, priceUsdE8 } from '../evm-fees.js';
import type { PublicClient } from 'viem';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evmProfile, matchesEvmNetwork } from '../evm-chains.js';
import { loadConfig } from '../config.js';
import { parseStateIdentity, SnapshotStore, digest } from '../liquidity/state.js';
import { AttemptJournal } from '../liquidity/journal.js';
import { loadScannerConfig } from '../scan/config.js';
import { parseManifest, rootKey, verifyRuntime } from '../evm/deployment.js';
import { enumerateSimpleProfitCycles, parseAcceptance } from '../evm/acceptance.js';
import { receiptNativeCost } from '../evm-fees.js';
import { checkExecutorAbis } from '../evm/abi-check.js';

test('EDGE-01 EVM profiles bind chain, RPC, wrapped asset and strict identity without Arbitrum fallback',async()=>{
  for(const id of [8453,4663]) {
    const p=evmProfile(id), config=loadConfig({CHAIN_ID:String(id),[p.rpcEnv]:'https://rpc.example'});
    assert.equal(config.chainId,id);assert.equal(config.rpcUrl,'https://rpc.example');
    assert.ok(matchesEvmNetwork(p.key,String(id)));assert.equal(matchesEvmNetwork('arbitrum',String(id)),false);
    const identity=parseStateIdentity({chain:p.key,network:String(id),height:'1',blockHash:`0x${'a'.repeat(64)}`});
    const store=new SnapshotStore(1000);store.apply({schemaVersion:'3.0',identity,sourceId:'test',cursor:'1',observedAtMs:1,complete:true,poolIds:[`${p.key}:${id}:pool`],stateDigest:digest('pool')});
    assert.equal(store.current(identity,1).identity.chain,p.key);
    const directory=await mkdtemp(join(tmpdir(),'evm-profile-')), file=join(directory,'scanner.json');
    await writeFile(file,JSON.stringify({chainId:id,rpcUrl:'https://rpc.example',startBlock:'1',protocols:{}}));
    assert.equal((await loadScannerConfig(file)).chainId,id);
  }
  assert.throws(()=>parseStateIdentity({chain:'base',network:'4663',height:'1',blockHash:`0x${'a'.repeat(64)}`}),/IDENTITY/);
  assert.throws(()=>loadConfig({CHAIN_ID:'1'}),/UNSUPPORTED_EVM_CHAIN/);
  console.log('evm_configuration_and_chain_binding_proven');
});
test('EDGE-02 shared route ABI widths agree with compiled Solidity and Rust selectors',async()=>{
  await checkExecutorAbis();console.log('evm_route_abi_and_math_boundary_proven');
});
test('EDGE-03 deployment manifests reject unverified roots, missing Aave and mutated artifacts',()=>{
  assert.throws(()=>parseManifest({schemaVersion:'1.0',chainId:8453,roots:[],contracts:['ImmutableArbitrageExecutor'],exclusions:[]}),/AAVE_REQUIRED/);
  assert.throws(()=>parseManifest({schemaVersion:'1.0',chainId:4663,roots:[],contracts:['ArbitrumMultiSplitFlashExecutor'],exclusions:[]}),/INVALID_DEPLOYMENT/);
  assert.throws(()=>parseAcceptance({schemaVersion:'1.0',chainId:4663}),/INVALID_ACCEPTANCE/);
  const artifact={abi:[],bytecode:{object:'0x6000' as const},deployedBytecode:{object:'0x6000' as const}};
  const owner=`0x${'1'.repeat(40)}` as const;
  verifyRuntime(artifact,'0x6000',owner);assert.throws(()=>verifyRuntime(artifact,'0x6001',owner),/ARTIFACT_MISMATCH/);
  console.log('evm_protocol_and_artifact_admission_proven');
});
test('EDGE-04 separate chain lanes persist unresolved leases and exclude replay after restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'evm-journal-')), path=join(directory,'attempts.jsonl'), journal=new AttemptJournal(path);
  const base={id:'base-attempt',lane:'base:8453',budgetAsset:'base:8453:asset',candidateDigest:digest('base'),resource:'8453:signer:0',state:'prepared' as const,transactionId:null,loss:'10',day:'2026-10-21'};
  await journal.prepare(base,100n,10n);
  await new AttemptJournal(path).prepare({...base,id:'robin-attempt',lane:'robinhood:4663',budgetAsset:'robinhood:4663:asset',resource:'4663:signer:0',candidateDigest:digest('robin')},100n,10n);
  await assert.rejects(new AttemptJournal(path).prepare({...base,id:'duplicate'},100n,10n),/UNRESOLVED_ATTEMPT/);
  console.log('evm_nonce_lease_and_restart_exclusion_proven');
});
test('EDGE-05 Base publication fees are required and Nitro data fees are never double counted',()=>{
  const receipt={gasUsed:100n,effectiveGasPrice:2n};
  assert.equal(receiptNativeCost(8453,receipt,{l1Fee:'0x32'}),250n);
  assert.equal(receiptNativeCost(4663,receipt,{l1Fee:'0x32'}),200n);
  assert.throws(()=>receiptNativeCost(8453,receipt,{}),/L1_FEE_UNKNOWN/);
  console.log('evm_receipt_fee_accounting_or_halt_proven');
});

test('canonical budget survives run-path changes and reserves uncertain submissions across restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'evm-budget-')), signer=`0x${'1'.repeat(40)}` as const, hash=`0x${'a'.repeat(64)}` as const;
  const first=new EvmBudget(8453,signer,dir);await first.load();await first.reserve('trade',hash,TRADING_GAS_CAP);
  const restarted=new EvmBudget(8453,signer,dir);await restarted.load();assert.equal(restarted.remaining('trade'),0n);
  await assert.rejects(restarted.reserve('trade',`0x${'b'.repeat(64)}`,1n),/UNRESOLVED/);
  await restarted.settle(hash,100n);await restarted.settle(hash,100n);assert.equal(restarted.remaining('trade'),TRADING_GAS_CAP-100n);
  for(const letter of ['b','c']){const h=`0x${letter.repeat(64)}` as const;await restarted.reserve('trade',h,1n);await restarted.settle(h,1n);}
  await assert.rejects(restarted.reserve('trade',`0x${'d'.repeat(64)}`,1n),/CHAIN_BUDGET_EXHAUSTED/);
});
test('provably unsent reservations can be cancelled without consuming spending or nonce lanes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'evm-cancel-')), signer=`0x${'2'.repeat(40)}` as const, hash=`0x${'e'.repeat(64)}` as const;
  const budget=new EvmBudget(4663,signer,dir);await budget.load();await budget.reserve('trade',hash,TRADING_GAS_CAP);await budget.cancelUnsent(hash);
  assert.equal(budget.remaining('trade'),TRADING_GAS_CAP);assert.equal(budget.tradeCount(),0);
  const journal=new AttemptJournal(join(dir,'attempts.jsonl'));
  const record={id:'unsent',lane:'robinhood:4663',budgetAsset:'robinhood:4663:asset',candidateDigest:digest('unsent'),resource:'4663:signer:0',state:'prepared' as const,transactionId:null,loss:'10',day:'2026-10-21'};
  await journal.prepare(record,100n,10n);await journal.transition(record.id,'halted',null);await journal.transition(record.id,'cancelled',null,0n);
  await journal.prepare({...record,id:'fresh',candidateDigest:digest('fresh')},100n,10n);
});

test('dead signer-lock recovery never removes a live holder',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'evm-lock-')),path=join(dir,'signer.lock');
  await writeFile(path,`${process.pid}\n`);
  await assert.rejects(recoverDeadExecutionLock(path),/STILL_ALIVE/);
  await writeFile(path,'99999999\n');assert.equal(await recoverDeadExecutionLock(path),true);
});
test('receipt recovery advances a signed journal before reconciling and accounts costs once',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'evm-signed-recovery-')),journal=new AttemptJournal(join(dir,'attempts'));
  const hash=`0x${'f'.repeat(64)}`,record={id:'signed-crash',lane:'base:8453',budgetAsset:'base:8453:asset',candidateDigest:digest('signed-crash'),resource:'8453:signer:1',state:'prepared' as const,transactionId:null,loss:'10',day:'2026-10-21'};
  await journal.prepare(record,100n,10n);await journal.transition(record.id,'signed',hash);
  const recovered=new AttemptJournal(join(dir,'attempts'));
  await recovered.transition(record.id,'submitted',hash);await recovered.transition(record.id,'reconciled',hash,0n);
  assert.equal((await recovered.latest())[0].loss,'0');
});
test('stablecoin gas conversion rounds upward and rejects stale/depegged price evidence',async()=>{
  const native=`0x${'1'.repeat(40)}` as const,asset=`0x${'2'.repeat(40)}` as const;
  let stable=100000000n,updatedAt=999n;
  const client={getBlock:async()=>({timestamp:1000n}),readContract:async(p:{functionName:string;address:string})=>p.functionName==='decimals'?8:[1n,p.address===native?200000000000n:stable,updatedAt,updatedAt,1n]} as unknown as PublicClient;
  const valuation={asset,nativeUsdFeed:native,assetUsdFeed:asset,decimals:6,maxAgeSeconds:60};
  assert.equal(await nativeCostInAsset(client,1000000000000000n,1n,valuation),2000000n);
  assert.equal(await nativeCostInAsset(client,1n,1n,valuation),1n);
  stable=98000000n;await assert.rejects(nativeCostInAsset(client,1n,1n,valuation),/DEPEG/);
  updatedAt=1n;await assert.rejects(priceUsdE8(client,native,1n,60),/STALE/);
});


test('discovery inclusive horizons stay inside fetched bitmap words for negative and positive ticks',()=>{
  for(const tick of [-887000,-200000,-1,0,1,200000,887000])for(const tickSpacing of [1,10,60,200]) {
    const w=discoveryTickWindow(tick,tickSpacing);
    assert.equal(w.bitmapWordPositions.length,7);
    assertTickWindowCoverage({tick,tickSpacing,bitmapWords:w.bitmapWordPositions.map(wordPosition=>({wordPosition,bitmap:'0'})),initializedTicks:[]},w.lowerTick,w.upperTick);
  }
});
test('bounded connected discovery finds intermediary cycles without widening the default settlement filter',()=>{
  const asset=`0x${'a'.repeat(40)}`,intermediary=`0x${'b'.repeat(40)}`,third=`0x${'c'.repeat(40)}`,other=`0x${'d'.repeat(40)}`;
  assert.equal(isProfitAssetPool(asset,intermediary,[asset],false),false);
  assert.equal(isProfitAssetPool(asset,intermediary,[asset],true),true);
  assert.equal(isProfitAssetPool(intermediary,other,[asset],true),false);
  const cycles=enumerateSimpleProfitCycles([
    {poolId:'ab',token0:asset,token1:intermediary},
    {poolId:'bc',token0:intermediary,token1:third},
    {poolId:'ac',token0:asset,token1:third}
  ],asset as `0x${string}`);
  assert.equal(cycles.length,1);
  assert.deepEqual(new Set(cycles[0].map(leg=>leg.poolId)),new Set(['ab','bc','ac']));
  assert.equal(cycles[0][0].tokenIn.toLowerCase(),asset);
  assert.throws(()=>enumerateSimpleProfitCycles([{poolId:'bad',token0:asset,token1:asset},{poolId:'ab',token0:asset,token1:intermediary}],asset as `0x${string}`),/INVALID_CYCLE_GRAPH/);
});
test('Aero deployment is isolated and validates every generation and implementation pin',async()=>{
 const {readFile}=await import('node:fs/promises');
 const m=JSON.parse(await readFile('config/aero-base-mainnet.json','utf8'));
 assert.equal(parseManifest(m).roots.filter(r=>r.role==='aero-pool').length,5);
 assert.throws(()=>parseManifest({...m,chainId:42161}),/AERO_MANIFEST_ISOLATION/);
 assert.throws(()=>parseManifest({...m,contracts:[...m.contracts,'PortableMultiSplitFlashExecutor']}),/AERO_MANIFEST_ISOLATION/);
 const bad=structuredClone(m);delete bad.roots.find((r:any)=>r.role==='aero-pool').implementationCodeHash;assert.throws(()=>parseManifest(bad),/INVALID_ROOT_PIN/);
 assert.throws(()=>parseManifest({...m,roots:[...m.roots,m.roots[0]]}),/DUPLICATE_ROOT_ROLE/);
});

test('manifests pin several factories per role and Algebra roots with stable single-root labels',()=>{
  const pin=(role:string,n:number)=>({role,address:`0x${n.toString(16).padStart(40,'0')}`,codeHash:`0x${'a'.repeat(64)}`,source:'https://example.org'});
  const roots=[pin('v3-factory',1),pin('v3-factory',2),pin('algebra-factory',3),pin('v2-factory',4),pin('morpho',5)];
  const m=parseManifest({schemaVersion:'1.0',chainId:42161,roots,contracts:['MultiVenueArbitrageExecutor'],exclusions:[]});
  assert.deepEqual(m.roots.map(r=>rootKey(r,m.roots)),['v3-factory:0x0000000000000000000000000000000000000001','v3-factory:0x0000000000000000000000000000000000000002','algebra-factory','v2-factory','morpho']);
  assert.throws(()=>parseManifest({schemaVersion:'1.0',chainId:42161,roots:[pin('v3-factory',1),pin('v3-factory',1)],contracts:['MultiVenueArbitrageExecutor'],exclusions:[]}),/DUPLICATE_ROOT_ROLE/);
});
