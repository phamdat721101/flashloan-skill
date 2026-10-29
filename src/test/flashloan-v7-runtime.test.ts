import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import type {Address,Hex} from 'viem';
import {domainHash,sha256Bytes,validateIntegration,RoundCounters,IntegrationError,IntegrationValidationError} from '../evidence/integration.js';
import {resolveV4Pools,partitionV4Inventory,readPinnedBatches,type V4Reader,type InitializeFact} from '../evm/v4-resolution.js';
import {deriveV4PoolId} from '../state-adapters.js';
import {compilePolicy,type RequestedConstraints} from '../evidence/economics.js';
import {adaptIntent,compileEffectivePolicy,toIntegrationAssetId} from '../evidence/intent.js';
import {fixture,ref,now,token0} from './flashloan-evidence-fixture.js';
import {digest} from '../liquidity/state.js';

const ex=(n:string)=>JSON.parse(readFileSync(new URL(`../../schemas/examples/flashloan-integration-v1/${n}`,import.meta.url),'utf8'));
const vectors=ex('vectors.json');
const CHAIN='eip155:4663',MANAGER='0x2222222222222222222222222222222222222222' as Address,CODE=`0x${'c'.repeat(64)}` as Hex,WETH='0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const TOKEN='0x3333333333333333333333333333333333333333',HOOKS='0x00000000000000000000000000000000000000c0';
const key=(c0:string,c1:string,fee=3000,hooks='0x0000000000000000000000000000000000000000')=>({currency0:c0 as Address,currency1:c1 as Address,fee,tickSpacing:60,hooks:hooks as Address});
const slot0=(tick:number)=>(1n<<96n)|(BigInt.asUintN(24,BigInt(tick))<<160n);
const blockHash=(n:bigint)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;

/** In-memory PoolManager: Initialize logs, extsload slot0 and a reorg switch per block. */
function reader(pools:Array<{key:ReturnType<typeof key>;block:bigint;state:bigint;reorged?:boolean}>,opts:{code?:Hex;calls?:string[]}={}):V4Reader{
  const facts:InitializeFact[]=pools.map(p=>({id:deriveV4PoolId(p.key),key:p.key,tick:-200,blockNumber:p.block,blockHash:p.reorged?`0x${'f'.repeat(64)}`:blockHash(p.block)}));
  const log=(c:string)=>opts.calls?.push(c);
  return {
    async block(n){log('block');const b=n??1000n;return {number:b,hash:blockHash(b),parentHash:blockHash(b-1n),timestamp:1_793_000_000n};},
    async codeHash(){log('code');return opts.code??CODE;},
    async initializeLogs(_m,ids,from,to){log('logs');return facts.filter(f=>f.blockNumber>=from&&f.blockNumber<=to&&(!ids||ids.includes(f.id)));},
    async extsload(_m,slot){log('ext');const p=pools.find(p=>slot===(void 0,slot)&&true&&deriveV4PoolId(p.key)&&slotOf(p.key)===slot);return p?.state??0n;},
    async decimals(){log('dec');return 18;}
  };
}
import {v4PoolStateSlot} from '../evm/v4-resolution.js';
const slotOf=(k:ReturnType<typeof key>)=>v4PoolStateSlot(deriveV4PoolId(k));
const mapping=Buffer.from(JSON.stringify({schema:'v4-manager-mapping/1',chainId:CHAIN,managers:[{provider:'hypermove',manager:MANAGER,codeHash:CODE,fromBlock:'0'}]}));
const request=(refs:Array<{provider?:string;providerPoolId:string;assetIds:string[]}>)=>({schema:'pool-resolution-request/1',roundId:'r-1',chainId:CHAIN,
  references:refs.map(r=>({provider:r.provider??'hypermove',...r})),managerMappingRef:{kind:'configuration',contentHash:sha256Bytes(mapping),issuedAt:'2026-10-29T00:00:00Z',expiresAt:null,traceId:'r-1',locator:'config/v4-managers.json'},
  atBlock:null,limits:{maxRpcCalls:100,maxEvaluations:500,maxPools:8,maxRoutes:3,deadlineMs:30000,watchDurationMs:0}});
const counters=(rpc=100)=>new RoundCounters({maxRpcCalls:rpc,maxEvaluations:500},Date.now()+60_000);
const native=`${CHAIN}/slip44:60`,weth=`${CHAIN}/erc20:${WETH}`,tok=`${CHAIN}/erc20:${TOKEN}`;

test('v7 SK-00 validator bounds uint256, closes reason codes and checks ledger counts',()=>{
  const ledger={schema:'candidate-ledger/2',roundId:'r',chainId:CHAIN,items:[{assetId:weth,sources:['explicit'],outcome:'UNSUPPORTED',stage:'identity',reasonCode:'UNSUPPORTED_NATIVE_CURRENCY',nextDependency:'native executor',poolIds:[],routeIds:[],
    support:{read:true,quote:true,prepare:false,simulate:false,execute:false,reasonCodes:[]},evidenceRefs:[]}],counts:{requested:1,discovered:0,resolved:0,evaluated:0,rejected:0,deferred:0,incomplete:0,unsupported:1},exhaustive:false,sourceRefs:[]};
  assert.doesNotThrow(()=>validateIntegration('CandidateLedger',ledger));
  assert.throws(()=>validateIntegration('CandidateLedger',{...ledger,counts:{...ledger.counts,unsupported:0,rejected:1}}),/LEDGER_COUNT_MISMATCH/);
  assert.throws(()=>validateIntegration('CandidateLedger',{...ledger,items:[{...ledger.items[0],reasonCode:'MADE_UP'}]}),/UNKNOWN_REASON_CODE/);
  assert.throws(()=>validateIntegration('CandidateLedger',{...ledger,items:[{...ledger.items[0],outcome:'EVALUATED'}],counts:{...ledger.counts,unsupported:0,evaluated:1}}),/EVALUATED_WITHOUT_ROUTE/);
  const c=counters(2);c.charge('rpc');c.charge('rpc');
  assert.throws(()=>c.charge('rpc'),(e:unknown)=>e instanceof IntegrationError&&e.reason==='DEFERRED_RPC_BUDGET');
  for(const d of vectors.hash.domain) assert.equal(domainHash(d.domain,d.value),d.expected);
  assert.throws(()=>validateIntegration('ResolvedPool',ex('resolved-pool-mismatch.json')),/POOL_ID_MISMATCH/);
  assert.doesNotThrow(()=>validateIntegration('ResolvedPool',ex('resolved-pool-native.json')));
});

test('v7 SK-01 resolves v4 references with one disposition each and verified analytics configs',async()=>{
  const p1=key('0x0000000000000000000000000000000000000000',WETH),p2=key(WETH,TOKEN,0x800000,HOOKS),p3=key(WETH,TOKEN,500),p4=key(WETH,TOKEN,10000),p5=key(WETH,TOKEN,3000);
  const r=reader([{key:p1,block:10n,state:slot0(-200)},{key:p2,block:11n,state:slot0(5)},{key:p3,block:12n,state:0n},{key:p4,block:13n,state:slot0(1),reorged:true},{key:p5,block:14n,state:slot0(60)}]);
  const id=(k:ReturnType<typeof key>)=>deriveV4PoolId(k);
  const refs=[{providerPoolId:id(p1),assetIds:[native,weth]},{providerPoolId:id(p2),assetIds:[weth,tok]},{providerPoolId:id(p3),assetIds:[weth,tok]},{providerPoolId:id(p4),assetIds:[weth,tok]},
    {providerPoolId:id(p5).toUpperCase().replace('0X','0x'),assetIds:[weth,tok]},{providerPoolId:id(p5),assetIds:[weth,tok]},
    {provider:'unknown-dex',providerPoolId:id(p1),assetIds:[native,weth]},{providerPoolId:'pool-123',assetIds:[weth,tok]},{providerPoolId:`0x${'9'.repeat(64)}`,assetIds:[weth,tok]},
    {providerPoolId:id(p5),assetIds:[native,tok],provider:'hypermove'}];
  const {report,configs}=await resolveV4Pools(request(refs.slice(0,9)),r,counters(),{mappingBytes:mapping,pageSize:50n});
  const rep=report as {resolved:Array<{poolId:string;support:{quote:boolean;execute:boolean;reasonCodes:string[]};asset0:{kind:string}}>;unresolved:Array<{providerPoolId:string;reasonCode:string}>;complete:boolean};
  const codes=Object.fromEntries(rep.unresolved.map(u=>[u.providerPoolId,u.reasonCode]));
  assert.equal(rep.resolved.length+rep.unresolved.length,8,'p5 duplicate collapses on (chain,manager,poolId)');
  assert.equal(codes[id(p3)],'UNINITIALIZED_POOL');
  assert.equal(codes[id(p4)],'BLOCK_REORG');
  assert.equal(codes[id(p1)],'MANAGER_MAPPING_REQUIRED');
  assert.equal(codes['pool-123'],'UNRESOLVED_POOL_KEY');
  assert.equal(codes[`0x${'9'.repeat(64)}`],'UNRESOLVED_POOL_KEY');
  const nat=rep.resolved.find(p=>p.poolId===id(p1))!,hooked=rep.resolved.find(p=>p.poolId===id(p2))!;
  assert.equal(nat.asset0.kind,'native');
  assert.deepEqual([nat.support.quote,nat.support.execute,nat.support.reasonCodes],[true,false,['UNSUPPORTED_NATIVE_CURRENCY']]);
  assert.deepEqual([hooked.support.quote,hooked.support.reasonCodes],[false,['UNSUPPORTED_HOOK','UNSUPPORTED_DYNAMIC_FEE']]);
  assert.equal(configs.length,2,'only quotable pools become analytics configs');
  assert.ok(configs.every(c=>c.address===MANAGER.toLowerCase()&&c.protocol==='uniswap-v4'));
  assert.equal(rep.complete,false);
  const mismatch=await resolveV4Pools(request([refs[9]]),r,counters(),{mappingBytes:mapping});
  assert.equal((mismatch.report as typeof rep).unresolved[0].reasonCode,'POOL_ID_MISMATCH','provider assets must equal PoolKey currencies; no zero<->WETH substitution');
});

test('v7 SK-01 drift, budget and tampered mapping fail closed without aborting the round',async()=>{
  const p=key(WETH,TOKEN);const refs=[{providerPoolId:deriveV4PoolId(p),assetIds:[weth,tok]}];
  const drift=await resolveV4Pools(request(refs),reader([{key:p,block:1n,state:slot0(0)}],{code:`0x${'d'.repeat(64)}`}),counters(),{mappingBytes:mapping});
  assert.match((drift.report as {unresolved:Array<{nextDependency:string}>}).unresolved[0].nextDependency,/code hash drift/);
  const budget=await resolveV4Pools(request(refs),reader([{key:p,block:999n,state:slot0(0)}]),counters(4),{mappingBytes:mapping,pageSize:100n});
  assert.equal((budget.report as {unresolved:Array<{reasonCode:string}>}).unresolved[0].reasonCode,'RESOLUTION_BUDGET');
  await assert.rejects(resolveV4Pools(request(refs),reader([]),counters(),{mappingBytes:Buffer.concat([mapping,Buffer.from(' ')])}),/MANAGER_UNMAPPED/);
});

test('v7 SK-01 partitions v4 rows away from the legacy universe and batches snapshots at one block',async()=>{
  const id=deriveV4PoolId(key(WETH,TOKEN));
  const inv={pools:[{id,reference:{kind:'provider_opaque',chainId:4663},asset_ids:[WETH,TOKEN],protocol:'uniswap'},{id:'v3',reference:{kind:'evm_contract',chainId:4663,address:TOKEN},asset_ids:[WETH,TOKEN],protocol:'uniswap-v3'},
    {id:'bad',reference:{kind:'v4_pool',chainId:4663},asset_ids:[WETH],protocol:'uniswap-v4'}]};
  const part=partitionV4Inventory(inv,4663);
  assert.deepEqual(part.references,[{provider:'uniswap',providerPoolId:id,assetIds:[weth,tok]}]);
  assert.equal(part.legacy.length,1);assert.equal(part.rejected[0].reasonCode,'UNRESOLVED_POOL_KEY');
  const cfg=Array.from({length:14},(_,i)=>({protocol:'uniswap-v4' as const,address:MANAGER,expectedCodeHash:CODE,adapterRevision:'r',key:key(WETH,TOKEN,i),bitmapWordPositions:[0],lowerTick:0,upperTick:1}));
  const snap=(h:string)=>({snapshot:{identity:{chain:'robinhood',network:'4663',height:'1',blockHash:h}}} as never);
  const reads:number[]=[];
  const ok=await readPinnedBatches(cfg,'1',13,async b=>{reads.push(b.length);return snap('0x1');});
  assert.deepEqual([reads,ok.deferred.length],[[6,6,1],1]);
  let n=0;
  await assert.rejects(readPinnedBatches(cfg,'1',12,async()=>snap(n++?'0x2':'0x1')),/STATE_CHANGED/);
});

function sized(){const f=fixture();f.request.schemaVersion='5.2';f.profile.minProfitUsd={numerator:'0',denominator:'1'};f.profile.maxBranches=4;f.request.riskProfileRef=ref('configuration',digest(f.profile));return f;}
const constraint=(patch:Partial<RequestedConstraints>={}):RequestedConstraints=>({repaymentAssetId:toIntegrationAssetId({namespace:'eip155',networkId:'42161',assetId:token0}),principalCapRaw:null,minNetProfitRaw:null,maxPriceImpactBps:null,maxRoutes:null,...patch});

test('v7 SK-02 absent constraints keep compilePolicy output byte-identical and constraints only tighten',()=>{
  const f=sized(),approved={body:f.profile,ref:f.request.riskProfileRef!};
  const base=compilePolicy(f.request,approved,f.market.asset,f.market.valuation,now);
  assert.equal(JSON.stringify(compilePolicy(f.request,approved,f.market.asset,f.market.valuation,now,undefined)),JSON.stringify(base));
  const tight=compilePolicy(f.request,approved,f.market.asset,f.market.valuation,now,constraint({principalCapRaw:'500',minNetProfitRaw:'7',maxPriceImpactBps:50,maxRoutes:2}));
  assert.deepEqual([tight.principalCapRaw,tight.minProfitRaw,tight.maxPriceImpactBps,tight.maxBranches],['500','7',50,2]);
  assert.notEqual(tight.policyHash,base.policyHash);
  const loose=compilePolicy(f.request,approved,f.market.asset,f.market.valuation,now,constraint({principalCapRaw:'999999',maxPriceImpactBps:9999,maxRoutes:8}));
  assert.deepEqual([loose.principalCapRaw,loose.maxPriceImpactBps,loose.maxBranches],[base.principalCapRaw,base.maxPriceImpactBps,base.maxBranches],'caller can never widen');
  assert.throws(()=>compilePolicy(f.request,approved,f.market.asset,f.market.valuation,now,constraint({repaymentAssetId:'eip155:42161/erc20:0x2222222222222222222222222222222222222222'})),/CONSTRAINT_ASSET_MISMATCH/);
  assert.throws(()=>compilePolicy(f.request,approved,f.market.asset,f.market.valuation,now,{...constraint(),extra:1} as never),/POLICY_UNSUPPORTED_FIELD/);
});

test('v7 SK-02 null profileRef yields INPUT_BLOCKED for sizing while discovery stays valid; effective policy wraps compilePolicy',()=>{
  const intent={...ex('intent-valid.json'),chainId:'eip155:42161'};
  const blocked=adaptIntent(intent,{});
  assert.deepEqual([blocked.kind,blocked.blockers],['research-only',['INPUT_BLOCKED_PROFILE','INPUT_BLOCKED_AUTHORIZATION']]);
  assert.throws(()=>adaptIntent({...intent,surprise:true},{}),IntegrationValidationError);
  const f=sized(),profile={body:f.profile,ref:f.request.riskProfileRef!,extras:{maxGasReservationNativeRaw:'9000000000000000',maxBlockLag:0,submissionPolicy:'approved-direct' as const,allowedCapabilities:['erc20-multivenue/1']}};
  const refs={profile,repaymentAsset:f.market.asset,valuation:f.market.valuation,networkCostRef:f.request.networkCostEvidenceRef!,authorization:ref('configuration')};
  const adapted=adaptIntent({...intent,requestedConstraints:constraint({maxRoutes:1})},refs);
  assert.equal(adapted.kind,'ready');
  if(adapted.kind!=='ready')return;
  assert.equal(adapted.executeAuthorized,true);
  const {local,effective}=compileEffectivePolicy(adapted,refs,now);
  assert.equal(effective.compiledPolicyHash,`sha256:${local.policyHash}`);
  assert.equal(effective.maxRoutes,1);
  assert.equal(effective.maxGasReservationNativeRaw,'2000000000000000','profile gas reservation is intersected with TRADING_GAS_CAP');
  const {policyHash,roundId,...rest}=effective;
  assert.equal(policyHash,domainHash('flash/effective-policy/1',rest));
  assert.equal(compileEffectivePolicy({...adapted,intent:{...adapted.intent,roundId:'other'}},refs,now).effective.policyHash,policyHash,'roundId is excluded from policy identity');
  void roundId;
});

import {mkdtemp,writeFile,mkdir,readFile as readFileAsync} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeAbiParameters,encodeEventTopics,keccak256,decodeFunctionData,type Abi} from 'viem';
import {storeArtifact,buildExecutorManifest,verifyExecutorManifest} from '../evm/deployment.js';
import {buildRouteCost,contractMinSurplus,verifyPlanV7,toExecutionEvidenceV2} from '../evidence/economics.js';
import {selectRouteCodec,nativeRouteCalldata,NATIVE_V4_ROUTE_CODEC,MULTI_VENUE_ROUTE_CODEC,PORTABLE_SPLIT_ROUTE_CODEC,portableSplitCalldata} from '../liquidity/arbitrum-execution.js';
import {NATIVE_V4_ROUTE_ABI,PORTABLE_SPLIT_ABI} from '../contracts/flash-executor.js';
import {verifyAdmissionBundle} from '../evm/acceptance.js';
import {toReadiness} from '../evm/budget.js';
import {deriveRoundStatus,toLegacyOutcome,RESULT_STATUS_MAP,buildRoundResult,type RoundFacts} from '../execution-outcome.js';
import {checkIntegrationVersions} from '../evidence/integration.js';
import {runIntegrationRound} from '../evidence/gap-runtime.js';
import {fixture as rpcFixture} from './evm-rpc-fixture.js';
import {SnapshotStore} from '../liquidity/state.js';
import {AttemptJournal} from '../liquidity/journal.js';
import {LiquidityRuntime} from '../liquidity/runtime.js';

const TS='2026-10-29T00:00:00Z',H=(c:string)=>`sha256:${c.repeat(64)}`,B=(c:string)=>`0x${c.repeat(64)}`;
const eref=(kind:string,contentHash=H('1'),locator='fixture')=>({kind,contentHash,issuedAt:TS,expiresAt:null,traceId:'t',locator});
const OWNER='0x1111111111111111111111111111111111111111' as Address,EXEC='0x4444444444444444444444444444444444444444' as Address;
const state={chainId:CHAIN,blockNumber:'1000',blockHash:B('a'),parentHash:B('9'),observedAt:TS,finality:'latest',stateDigest:H('3')};
const artifactBytes=()=>readFileSync(new URL('../../out/NativeV4FlashExecutor.sol/NativeV4FlashExecutor.json',import.meta.url));
/** Live runtime = artifact runtime with every immutable slot filled from {owner, WETH, WETH code hash}. */
function liveCode(bytes:Buffer){
  const art=JSON.parse(bytes.toString()),refs=Object.values(art.deployedBytecode.immutableReferences) as Array<Array<{start:number;length:number}>>;
  const values=[OWNER.slice(2).padStart(64,'0'),WETH.slice(2).padStart(64,'0'),'c'.repeat(64)];
  let code=art.deployedBytecode.object.slice(2) as string;
  refs.forEach((group,i)=>group.forEach(r=>{code=code.slice(0,r.start*2)+values[i%3]+code.slice(r.start*2+64);}));
  return `0x${code}` as Hex;
}
async function manifestFixture(){
  const root=await mkdtemp(join(tmpdir(),'v7-artifacts-')),bytes=artifactBytes(),code=liveCode(bytes);
  await storeArtifact(bytes,root);
  const manifest=buildExecutorManifest(4663,{address:EXEC,owner:OWNER,runtimeCodeHash:keccak256(code),deploymentReceiptRef:eref('receipt')},bytes,
    {version:'0.8.26',binaryHash:H('b'),settings:{optimizer:{enabled:true,runs:200}},sourceRevision:'306ca6e65323392ec3e41e14e23ff7487af29b48'},'native-v4-route/1',['evm-native-v4/1'],WETH as Address);
  return {root,bytes,code,manifest};
}

test('v7 SK-03 historical artifact passes and one-byte mutation rejects; stored manifest cannot be overwritten',async()=>{
  const {root,bytes,code,manifest}=await manifestFixture();
  const ok=await verifyExecutorManifest(manifest,{code,owner:OWNER,wrapperCodeHash:B('c') as Hex},root,Buffer.concat([bytes,Buffer.from(' ')]));
  assert.deepEqual([ok.capabilities,ok.rebuild],[['evm-native-v4/1'],'REBUILD_DIFFERS'],'a changed out/ build is diagnostic only');
  const mutated=`${code.slice(0,-2)}${code.endsWith('00')?'01':'00'}` as Hex;
  await assert.rejects(verifyExecutorManifest(manifest,{code:mutated,owner:OWNER,wrapperCodeHash:B('c') as Hex},root),/DEPLOYED_ARTIFACT_MISMATCH|DEPLOYED_CODE_CHANGED/);
  await assert.rejects(verifyExecutorManifest({...manifest,capabilities:['erc20-multivenue/1']},{code,owner:OWNER,wrapperCodeHash:B('c') as Hex},root),/EXECUTOR_MANIFEST_HASH_MISMATCH/);
  await assert.rejects(verifyExecutorManifest(manifest,{code,owner:EXEC,wrapperCodeHash:B('c') as Hex},root),/OWNER_MISMATCH/);
  const sha=manifest.artifactFileHash.slice(7);
  await writeFile(join(root,`${sha}.json`),'{"tampered":true}');
  await assert.rejects(storeArtifact(bytes,root),/ARTIFACT_IMMUTABLE/);
  await assert.rejects(verifyExecutorManifest(manifest,{code,owner:OWNER,wrapperCodeHash:B('c') as Hex},root),/ARTIFACT_HASH_MISMATCH/);
});

const effectivePolicy={policyHash:H('e'),minNetProfitRaw:'1000',principalCapRaw:'1000000',maxRoutes:2,maxHopsPerRoute:4,maxGasReservationNativeRaw:'2000000000000000',repaymentAsset:{assetId:weth}};
function cost(reservation=150000000000000n){
  const c=vectors.nativeToRepayment;
  return buildRouteCost({repaymentAssetId:weth,state,nativeCostUpperRaw:BigInt(c.nativeRaw),otherCostUpperRaw:50n,reservationNativeRaw:reservation,budgetRemainingNativeRaw:2000000000000000n,
    conversion:{nativeUsdUpper:{numerator:c.nativeUsdUpper.num,denominator:c.nativeUsdUpper.den},repaymentUsdLower:{numerator:c.repaymentUsdLower.num,denominator:c.repaymentUsdLower.den},nativeDecimals:18,repaymentDecimals:6},
    valuationRefs:[eref('source')],feeEvidenceRef:eref('source'),expiresAt:TS},effectivePolicy);
}
test('v7 SK-04 reservation never becomes modeled cost; strict net threshold on the plan',()=>{
  const a=cost(),b=cost(1000000000000000n);
  assert.equal(a.networkCostUpperRaw,vectors.nativeToRepayment.expectedUpperRaw);
  assert.equal(a.networkCostUpperRaw,b.networkCostUpperRaw,'a larger reservation does not raise the modeled cost');
  assert.throws(()=>cost(1n),/CHAIN_BUDGET_EXHAUSTED/);
  assert.throws(()=>cost(3000000000000000n),/CHAIN_BUDGET_EXHAUSTED/);
  assert.equal(contractMinSurplus(effectivePolicy,a),1000n+BigInt(a.networkCostUpperRaw)+50n+1n);
  const net=(surplus:bigint)=>({policyHash:effectivePolicy.policyHash,costHash:domainHash('flash/route-cost/1',a),repaymentAssetId:weth,state,principalRaw:'1000000',deployedRaw:'1000000',unusedPrincipalRaw:'0',
    swapProceedsRaw:(1000000n+surplus).toString(),lenderFeeRaw:'0',terminalBeforeDebtRaw:(1000000n+surplus).toString(),surplusAfterDebtRaw:surplus.toString(),
    netLowerBoundRaw:(surplus-BigInt(a.networkCostUpperRaw)-50n).toString(),branches:[{branchId:'b0',allocationRaw:'1000000',actions:[{kind:'SWAP',tokenIn:weth,tokenOut:tok,poolId:B('1')},{kind:'SWAP',tokenIn:tok,tokenOut:weth,poolId:B('2')}]}]});
  const threshold=1000n+BigInt(a.networkCostUpperRaw)+50n;
  assert.throws(()=>verifyPlanV7(net(threshold),effectivePolicy,a),/INSUFFICIENT_NET_PROFIT/,'net equal to the floor does not qualify');
  assert.equal(verifyPlanV7(net(threshold+1n),effectivePolicy,a),1001n);
  assert.throws(()=>verifyPlanV7({...net(threshold+1n),costHash:H('0')},effectivePolicy,a),/BINDING_MISMATCH/);
});

const descriptors=new Map([[B('1'),{manager:MANAGER,key:key('0x0000000000000000000000000000000000000000',TOKEN)}],[B('2'),{manager:MANAGER,key:key('0x0000000000000000000000000000000000000000',TOKEN,500)}]]);
const nativePlan={principalRaw:'100',deployedRaw:'100',expiresAt:'2030-01-01T00:00:00Z',branches:[{allocationRaw:'100',actions:[
  {kind:'UNWRAP' as const,tokenIn:weth,tokenOut:native,minAmountOutRaw:'100',poolId:null},{kind:'SWAP' as const,tokenIn:native,tokenOut:tok,minAmountOutRaw:'190',poolId:B('1')},
  {kind:'SWAP' as const,tokenIn:tok,tokenOut:native,minAmountOutRaw:'101',poolId:B('2')},{kind:'WRAP' as const,tokenIn:native,tokenOut:weth,minAmountOutRaw:'101',poolId:null}]}]};
test('v7 SK-06 codec selection never downgrades, and native calldata/events round-trip',()=>{
  assert.equal(selectRouteCodec(['erc20-multivenue/1'],'single',false).codec,MULTI_VENUE_ROUTE_CODEC);
  assert.throws(()=>selectRouteCodec(['erc20-multivenue/1'],'split',false),/SPLIT_UNSUPPORTED/);
  assert.equal(selectRouteCodec(['erc20-portable-split/1'],'split',false).codec,PORTABLE_SPLIT_ROUTE_CODEC);
  assert.throws(()=>selectRouteCodec(['erc20-portable-split/1'],'single',true),/UNSUPPORTED_NATIVE_CURRENCY/);
  const calldata=nativeRouteCalldata(nativePlan,{kind:1,address:EXEC},WETH as Address,5n,descriptors);
  const view=NATIVE_V4_ROUTE_CODEC.decode(calldata);
  assert.deepEqual([view.flashAmount,view.minProfit,view.size,view.supportedKind,view.unsupportedLeg],[100n,5n,1,true,false]);
  assert.deepEqual(view.pinned,[EXEC,MANAGER]);
  assert.throws(()=>nativeRouteCalldata({...nativePlan,branches:[{...nativePlan.branches[0],actions:[{...nativePlan.branches[0].actions[1],poolId:B('9')}]}]},{kind:1,address:EXEC},WETH as Address,5n,descriptors),/CODEC_UNAVAILABLE/);
  const route=decodeFunctionData({abi:[NATIVE_V4_ROUTE_ABI[0]],data:calldata}).args[0];
  const routeHash=keccak256(encodeAbiParameters(NATIVE_V4_ROUTE_ABI[0].inputs,[route] as never));
  const log=(hash:Hex,surplus:bigint)=>({address:EXEC,topics:encodeEventTopics({abi:NATIVE_V4_ROUTE_ABI as Abi,eventName:'NativeArbitrageExecuted',args:{routeHash:hash,asset:WETH}}) as Hex[],
    data:encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[100n,surplus,1n,7n])});
  assert.deepEqual(NATIVE_V4_ROUTE_CODEC.prove([log(routeHash,6n)],EXEC,calldata,view),{proven:true,profit:6n},'unexplained native (7) is never profit');
  assert.equal(NATIVE_V4_ROUTE_CODEC.prove([log(B('0') as Hex,6n)],EXEC,calldata,view).proven,false);
  assert.equal(NATIVE_V4_ROUTE_CODEC.prove([log(routeHash,4n)],EXEC,calldata,view).proven,false);
  const split=portableSplitCalldata({kind:1,lender:EXEC,flashAsset:WETH as Address,flashAmount:100n,minProfit:1n,deadline:1n,branches:[{amountIn:100n,legs:[
    {venueVersion:2,root:EXEC,pool:MANAGER,tokenIn:WETH as Address,tokenOut:TOKEN as Address,minAmountOut:90n,quotedOutRaw:97n,fee:0,sqrtPriceLimitX96:0n,tickSpacing:0,hooks:'0x0000000000000000000000000000000000000000',hookData:'0x'}]}]});
  const decoded=decodeFunctionData({abi:[PORTABLE_SPLIT_ABI[0]],data:split}).args[0] as unknown as {branches:Array<{legs:Array<{minAmountOut:bigint}>}>};
  assert.equal(decoded.branches[0].legs[0].minAmountOut,97n,'V2 leg requests the exact quoted output');
});

async function admissionFixture(){
  const {root,manifest}=await manifestFixture(),proofRoot=await mkdtemp(join(tmpdir(),'v7-proofs-'));
  const payloadHash=H('d'),policyHash=H('e'),stateDigest=H('3');
  const files:Record<string,string>={schema:'{"ok":1}',math:'{"ok":2}',canary:'{"ok":3}',producer:'{"producer":"reviewer-a"}',review:'{"owner":"approved"}'};
  const sim={schema:'execution-evidence/2',roundId:'r',chainId:CHAIN,kind:'NATIVE_SIM',fixture:false,candidateHash:H('c'),policyHash,executorManifestHash:manifest.manifestHash,payloadHash,state,
    transactionHash:null,receiptRef:null,repaymentProven:true,custodyProven:false,realizedNetRaw:null,producerRef:eref('review'),ownerReviewRef:null,success:true,fidelity:'existing-native',overrideRefs:[],nativeProofRef:eref('native-simulation'),receiptState:null};
  files.sim=JSON.stringify(sim);
  const refs:Record<string,ReturnType<typeof eref>>={};
  for(const [k,v] of Object.entries(files)){await writeFile(join(proofRoot,`${k}.json`),v);refs[k]=eref(k==='sim'?'native-simulation':'review',sha256Bytes(Buffer.from(v)),`${k}.json`);}
  const producersBytes=Buffer.from(JSON.stringify({schema:'admission-producers/1',producers:[{contentHash:refs.producer.contentHash}]}));
  const bundle={schema:'execution-admission/1',chainId:CHAIN,executorManifestHash:manifest.manifestHash,capability:'evm-native-v4/1',schemaProofRef:refs.schema,mathProofRef:refs.math,canaryProofRef:refs.canary,
    nativeSimulationRef:refs.sim,payloadHash,policyHash,stateDigest,producerRef:refs.producer,ownerReviewRef:refs.review,expiresAt:'2030-01-01T00:00:00Z'};
  const trusted={producersBytes,pinnedSha256:sha256Bytes(producersBytes).slice(7)};
  return {root,manifest,proofRoot,bundle,trusted,binding:{manifest,capability:'evm-native-v4/1',payloadHash,policyHash,stateDigest},sim};
}
test('v7 SK-07 edited, replayed, untrusted, expired or fixture proofs never admit',async()=>{
  const f=await admissionFixture(),opts={now:new Date('2026-10-29T00:00:00Z'),proofRoot:f.proofRoot};
  assert.equal((await verifyAdmissionBundle(f.bundle,f.binding,f.trusted,opts)).admitted,true);
  await assert.rejects(verifyAdmissionBundle(f.bundle,{...f.binding,payloadHash:H('f')},f.trusted,opts),/ADMISSION_BINDING_MISMATCH:payloadHash/,'replay onto another payload');
  await assert.rejects(verifyAdmissionBundle(f.bundle,f.binding,{...f.trusted,pinnedSha256:'0'.repeat(64)},opts),/PRODUCER_UNTRUSTED/);
  await assert.rejects(verifyAdmissionBundle({...f.bundle,producerRef:f.bundle.schemaProofRef},f.binding,f.trusted,opts),/PRODUCER_UNTRUSTED/);
  await assert.rejects(verifyAdmissionBundle(f.bundle,f.binding,f.trusted,{...opts,now:new Date('2031-01-01T00:00:00Z')}),/ADMISSION_EXPIRED/);
  await assert.rejects(verifyAdmissionBundle({...f.bundle,capability:'erc20-multivenue/1'},{...f.binding,capability:'erc20-multivenue/1'},f.trusted,opts),/capability/);
  await writeFile(join(f.proofRoot,'math.json'),'{"ok":"edited"}');
  await assert.rejects(verifyAdmissionBundle(f.bundle,f.binding,f.trusted,opts),/ADMISSION_BINDING_MISMATCH:bytes math.json/);
  await writeFile(join(f.proofRoot,'math.json'),'{"ok":2}');
  const fixtureSim=JSON.stringify({...f.sim,fixture:true,fidelity:'fixture'});await writeFile(join(f.proofRoot,'sim.json'),fixtureSim);
  await assert.rejects(verifyAdmissionBundle({...f.bundle,nativeSimulationRef:{...f.bundle.nativeSimulationRef,contentHash:sha256Bytes(Buffer.from(fixtureSim))}},f.binding,f.trusted,opts),/ADMISSION_FIXTURE/);
  await assert.rejects(verifyAdmissionBundle({...f.bundle,schemaProofRef:{...f.bundle.schemaProofRef,locator:'../etc/passwd'}},f.binding,f.trusted,opts),/locator/);
});

test('v7 SK-08 cancel during final verification RPC sends zero and readiness keeps unknowns null',async()=>{
  await rpcFixture(async(adapter,candidate,_config,controls)=>{
    const dir=await mkdtemp(join(tmpdir(),'v7-cancel-'));
    const snapshots=new SnapshotStore(60000);
    snapshots.apply({schemaVersion:'3.0',identity:candidate.identity,sourceId:'local-rpc',cursor:'1',observedAtMs:Date.now(),complete:true,poolIds:candidate.poolIds,stateDigest:candidate.stateDigest});
    const journal=new AttemptJournal(join(dir,'attempts.jsonl')),round=new AbortController();
    let gate=0;
    const decisions=await new LiquidityRuntime(snapshots,journal,new Map([[candidate.adapterId,adapter]])).run([candidate],
      {mode:'auto',concurrency:1,maxCandidates:1,maxDailyLoss:'1000000',minProfit:'10000',budgetAssets:{'arbitrum:42161':candidate.profitAsset},cancel:round.signal},
      async()=>{gate++;round.abort();});
    assert.equal(gate,1);
    assert.deepEqual(decisions.filter(d=>d.attemptId).map(d=>[d.status,d.code]),[['rejected','CANCELLED']]);
    assert.ok(!decisions.some(d=>d.status==='reconciled'||d.status==='halted'));
    assert.equal(controls.sends,0);
    assert.equal((await journal.latest())[0].state,'cancelled','no orphan prepared attempt');
  });
  const r=validateIntegration<{verdict:string;pnlState:string;gasBalanceNativeRaw:null}>('Readiness',toReadiness({verdict:'READY',reasons:[],operatorGasBalanceRaw:null,gasBudgetRaw:null,pnlUnknownHalt:true},
    {roundId:'r',chainId:CHAIN,requestedMode:'execute',operator:null,pendingAttemptIds:['a-1'],admissionRef:null,executorBalanceRefs:[]}));
  assert.deepEqual([r.verdict,r.pnlState,r.gasBalanceNativeRaw],['RESEARCH_ONLY','UNKNOWN',null],'no admission ref means no READY; unknown is null, never 0');
});

const ledger1={schema:'candidate-ledger/2',roundId:'r',chainId:CHAIN,items:[{assetId:tok,sources:['movers'],outcome:'EVALUATED',stage:'solve',reasonCode:null,nextDependency:null,poolIds:[B('1')],routeIds:['route-1'],
  support:{read:true,quote:true,prepare:true,simulate:true,execute:true,reasonCodes:[]},evidenceRefs:[]}],counts:{requested:1,discovered:0,resolved:0,evaluated:1,rejected:0,deferred:0,incomplete:0,unsupported:0},exhaustive:false,sourceRefs:[]};
const facts=(p:Partial<RoundFacts>):RoundFacts=>({versionSupported:true,inputBlockers:[],policyUnsupported:[],submitted:false,pnlState:'KNOWN',evidence:null,planQualified:false,
  search:{attempted:10,complete:false,termination:'attempt-budget',domainHash:null},ledger:ledger1,...p});
test('v7 SK-09 status mapping is exhaustive; unknown receipt halts without realized net; partial grids stay inconclusive',async()=>{
  const spec=JSON.parse(readFileSync(new URL('../../docs/features/flashloan-v7-integration.spec.json',import.meta.url),'utf8'));
  assert.deepEqual(RESULT_STATUS_MAP,spec.resultStatusMap,'code and ledger agree');
  assert.equal(toLegacyOutcome('SUBMITTED_UNKNOWN'),null);
  assert.equal(deriveRoundStatus(facts({})),'INCONCLUSIVE','a partial grid is never a certified negative');
  assert.equal(deriveRoundStatus(facts({search:{attempted:10,complete:true,termination:'domain-certified',domainHash:H('5')}})),'NO_OPPORTUNITY_WITHIN_DOMAIN');
  assert.equal(deriveRoundStatus(facts({submitted:true,pnlState:'UNKNOWN'})),'SUBMITTED_UNKNOWN');
  assert.equal(deriveRoundStatus(facts({submitted:true,pnlState:'HALTED'})),'HALTED');
  assert.equal(deriveRoundStatus(facts({planQualified:true,evidence:{kind:'NATIVE_SIM',success:true,fixture:true,fidelity:'fixture',overrideRefs:[]}})),'MODEL_OPPORTUNITY','a fixture is never a simulation');
  const readiness=toReadiness({verdict:'RESEARCH_ONLY',reasons:['PNL_UNKNOWN_HALT'],operatorGasBalanceRaw:null,gasBudgetRaw:null,pnlUnknownHalt:true},{roundId:'r',chainId:CHAIN,requestedMode:'execute',operator:null,pendingAttemptIds:['a'],admissionRef:null,executorBalanceRefs:[]});
  const res=await buildRoundResult({roundId:'r',chainId:CHAIN,ledger:ledger1,readiness,plan:null,executionEvidence:null,reasonCodes:['PNL_UNKNOWN_HALT'],nextDependencies:['reconcile tx 0xabc'],search:facts({}).search,artifactRefs:[]},facts({submitted:true,pnlState:'UNKNOWN'}));
  assert.equal(res.status,'SUBMITTED_UNKNOWN');
  const v1={kind:'RECEIPT_RECONCILED',reconciliation:'UNKNOWN',fixture:false,chain_id:'4663',transaction:{tx_hash:B('7')},realized_net_raw:null,repayment:{proven:false}} as never;
  assert.throws(()=>toExecutionEvidenceV2(v1,{} as never),/PNL_UNKNOWN_HALT/);
});

test('v7 SK-10 gate off and release drift return VERSION_UNSUPPORTED; installed bundle carries no secrets',async()=>{
  const read=(p:string)=>readFileSync(new URL(`../../${p}`,import.meta.url));
  const release={baseVersionsBytes:read('config/flashloan-versions.json'),promptBytes:read('skills/flashloan-agent/prompt-v7.md'),contractBytes:read('schemas/flashloan-integration-v1.schema.json'),producersBytes:read('config/admission-producers.json')};
  const versions=JSON.parse(read('config/flashloan-integration-versions.json').toString());
  assert.throws(()=>checkIntegrationVersions(versions,release),/integrationV7 gate is off/);
  const on={...versions,features:{integrationV7:true}};
  assert.equal(checkIntegrationVersions(on,release).features.integrationV7,true);
  assert.throws(()=>checkIntegrationVersions(on,{...release,promptBytes:Buffer.concat([release.promptBytes,Buffer.from('x')])}),/installed release drift/);
  const prompt=read('skills/flashloan-agent/prompt-v7.md').toString();
  assert.match(prompt,/^# Flashloan agent prompt — MCP discovery to verified local execution, version 7/);
  const installer=read('src/agent-cli.ts').toString();
  assert.ok(!/\.env|\.nim|signing/.test(installer.split('v7 SK-10')[1].split('\n').slice(1).join('\n')),'installer copies no env, .nim or signing state');
});

test('v7 integration round: gate off is VERSION_UNSUPPORTED; gate on yields a complete ledger and a validated result',async()=>{
  const read=(p:string)=>readFileSync(new URL(`../../${p}`,import.meta.url));
  const release={baseVersionsBytes:read('config/flashloan-versions.json'),promptBytes:read('skills/flashloan-agent/prompt-v7.md'),contractBytes:read('schemas/flashloan-integration-v1.schema.json'),producersBytes:read('config/admission-producers.json')};
  const versions=JSON.parse(read('config/flashloan-integration-versions.json').toString());
  const p1=key('0x0000000000000000000000000000000000000000',WETH),p5=key(WETH,TOKEN);
  const inv={schema_version:'flashloan.inventory.v3',network:'robinhood',observed_at:TS,pools:[
    {id:deriveV4PoolId(p1),reference:{kind:'v4_pool',chainId:4663,provider:'hypermove'},asset_ids:['0x0000000000000000000000000000000000000000',WETH],protocol:'uniswap-v4',liquidity_usd:'1',liquidity_eligible:true},
    {id:deriveV4PoolId(p5),reference:{kind:'v4_pool',chainId:4663,provider:'hypermove'},asset_ids:[WETH,TOKEN],protocol:'uniswap-v4',liquidity_usd:'1',liquidity_eligible:true},
    {id:`0x${'8'.repeat(64)}`,reference:{kind:'v4_pool',chainId:4663,provider:'hypermove'},asset_ids:[WETH,'0x5555555555555555555555555555555555555555'],protocol:'uniswap-v4',liquidity_usd:'1',liquidity_eligible:true}]};
  const r=reader([{key:p1,block:10n,state:slot0(0)},{key:p5,block:11n,state:slot0(5)}]);
  const base={intent:ex('intent-valid.json'),inventory:inv,mappingBytes:mapping,mappingLocator:'config/v4-managers.json',release,refs:{},nowNs:now};
  const off=await runIntegrationRound({...base,versions},r);
  assert.equal(off.result.status,'VERSION_UNSUPPORTED');
  const on=await runIntegrationRound({...base,versions:{...versions,features:{integrationV7:true}}},r);
  const result=on.result as unknown as {status:string;ledger:{items:Array<{assetId:string;outcome:string;reasonCode:string|null}>;counts:{requested:number}};nextDependencies:string[];readiness:{verdict:string}};
  assert.equal(result.status,'INPUT_BLOCKED','null profile ref blocks sizing while research continues');
  const by=Object.fromEntries(result.ledger.items.map(i=>[i.assetId,[i.outcome,i.reasonCode]]));
  assert.deepEqual(by[native],['RESOLVED',null],'native pool is readable/quotable but never executable without the admitted capability');
  assert.deepEqual(by[tok],['RESOLVED',null]);
  assert.deepEqual(by[`${CHAIN}/erc20:0x5555555555555555555555555555555555555555`],['INCOMPLETE_DATA','UNRESOLVED_POOL_KEY']);
  assert.equal(result.ledger.counts.requested,result.ledger.items.length);
  assert.ok(result.nextDependencies.some(d=>/INPUT_BLOCKED_PROFILE/.test(d)));
  assert.equal(result.readiness.verdict,'RESEARCH_ONLY');
  assert.equal(on.configs.length,2);
});
void readFileAsync;void mkdir;
