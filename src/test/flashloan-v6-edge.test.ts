import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fixture,ref,now,token0,token1,h} from './flashloan-evidence-fixture.js';
import {compilePolicy,rawThreshold,buildLedger,reconcileReceipt,type ApprovedProfile} from '../evidence/economics.js';
import {fresh} from '../evidence/contracts.js';
import {digest} from '../liquidity/state.js';
import {searchAllocation} from '../liquidity/price-gap.js';
import {solvePoolGraph} from '../evidence/solver.js';
import {toRunRequest,checkCapabilities,runFlashRound,type FundingOption,type GapHost} from '../evidence/gap-runtime.js';
import {ArtifactStore} from '../evidence/integrity.js';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateCandidateLedger,mergeLocalOutcomes,fromRouteStats} from '../evidence/candidate-ledger.js';

/** Pinned with hypermove's vendored copy (review D3); bump both repos together on any schema change. */
export const FLASHLOAN_V6_SCHEMA_SHA256='a5f4a58e438757f0511072465b5318289e59afb7bec3ca78154c5558e8f6ff2c';
const marker=(edge:string,extra:Record<string,unknown>={})=>console.log(`FLASHLOAN_V6_EDGE_0${edge} ${JSON.stringify({pass:true,...extra})}`);
const chain='eip155:42161',aid=(t:string)=>`${chain}/erc20:${t}`;
const ev={kind:'route-search-result',content_hash:`sha256:${h}`,captured_at:'2026-10-29T00:00:00Z',trace_id:'t-1'};
function small(){const f=fixture();f.request.schemaVersion='5.2';f.profile.minProfitUsd={numerator:'0',denominator:'1'};f.profile.minimumPrincipalRaw='1';f.profile.principalCapRaw='100';f.request.principalCapRaw='100';f.market.lender.capacityRaw='100';f.market.quantumRaw='1';f.request.riskProfileRef=ref('configuration',digest(f.profile));f.policy=compilePolicy(f.request,{body:f.profile,ref:f.request.riskProfileRef},f.market.asset,f.market.valuation,now);return f;}
function runRequest(f=fixture(),patch:Record<string,unknown>={}){
  return {schema:'flash-run-request/1',round_id:'r-1',network:chain,mode:'research',
    selection:{movers:true,explicit_assets:[aid(token1)],anchor_assets:[{asset_id:aid(token0),role:'funding'}],min_reported_liquidity_usd:'15000',max_candidates:10},
    policy_ref:{id:'owner',version:'1',hash:`sha256:${digest(f.profile)}`},limits:{max_rpc_calls:10,max_evaluations:100,deadline_ms:1000},snapshot_ref:null,execution_authorization_ref:null,...patch};
}

test('FLASHLOAN_V6_EDGE_01 every candidate ends with one traceable outcome and EVALUATED needs a quoted route',()=>{
  const f=small(),solved=solvePoolGraph(f.request,f.policy,f.market,digest(f.market.pools),ref('configuration'));
  const routes=fromRouteStats(solved.routeStats);assert.ok(routes.some(r=>r.evaluations>0));
  const y=`0x${'7'.repeat(40)}`,w=`0x${'8'.repeat(40)}`,seen='2026-10-29T00:00:00Z';
  const ledger=mergeLocalOutcomes({roundId:'r-1',chainId:chain,asOf:seen,coverage:'BOUNDED',providers:['dexscreener'],sourceRefs:[ev],maxCandidates:3,inventoryOutcomes:{},routes,evidence:[ev],candidates:[
    {asset_id:aid(token1),role:'target',sources:['movers'],first_seen:seen,reported_metrics:{change_24h_pct:'12.1',liquidity_usd:'28000'}},
    {asset_id:aid(token1),role:'target',sources:['explicit'],first_seen:seen},
    {asset_id:aid(y),role:'target',sources:['explicit'],first_seen:seen},
    {asset_id:aid(`0x${'9'.repeat(40)}`),role:'target',sources:['movers'],first_seen:seen},
    {asset_id:aid(w),role:'target',sources:['movers'],first_seen:seen}]});
  const ok=validateCandidateLedger(ledger,routes,[aid(token1),aid(y)]);
  assert.deepEqual(ok.items.map(i=>[i.outcome,i.reason_code]),[['EVALUATED',null],['REJECTED','NO_CLOSED_ROUTE'],['REJECTED','NO_CLOSED_ROUTE'],['DEFERRED_BUDGET','CANDIDATE_CAP']]);
  assert.deepEqual(ok.items[0].sources,['movers','explicit']);assert.equal(ok.counts.requested,4);
  const tampered=structuredClone(ledger);Object.assign(tampered.items[1],{outcome:'EVALUATED',stage:'solve',reason_code:null,route_ids:[routes[0].id]});tampered.counts.evaluated++;tampered.counts.rejected--;
  assert.throws(()=>validateCandidateLedger(tampered,routes),/LEDGER_INVARIANT_3/);
  const skipped=routes.map(r=>({...r,evaluations:0}));assert.throws(()=>validateCandidateLedger(ledger,skipped),/LEDGER_INVARIANT_3/);
  const counted=structuredClone(ledger);counted.counts.deferred=0;assert.throws(()=>validateCandidateLedger(counted,routes),/LEDGER_INVARIANT_2/);
  const dup=structuredClone(ledger);dup.items.push(dup.items[0]);dup.counts.requested++;dup.counts.evaluated++;assert.throws(()=>validateCandidateLedger(dup,routes),/LEDGER_INVARIANT_1/);
  const empty=mergeLocalOutcomes({roundId:'r-1',chainId:chain,asOf:seen,coverage:'FULL',providers:['dexscreener'],sourceRefs:[],maxCandidates:3,inventoryOutcomes:{},routes,evidence:[],candidates:[{asset_id:aid(y),role:'target',sources:['explicit'],first_seen:seen}]});
  assert.throws(()=>validateCandidateLedger(empty,routes),/LEDGER_INVARIANT_6/);
  const deferred=mergeLocalOutcomes({roundId:'r-1',chainId:chain,asOf:seen,coverage:'BOUNDED',providers:[],sourceRefs:[],maxCandidates:3,inventoryOutcomes:{},routes:skipped,evidence:[],candidates:[{asset_id:aid(token1),role:'target',sources:['movers'],first_seen:seen}]});
  assert.equal(validateCandidateLedger(deferred,skipped).items[0].next_dependency,'evaluation-budget');
  marker('1',{items:ok.items.length});
});

test('FLASHLOAN_V6_EDGE_02 unequal split matches an exhaustive oracle, models order, and respects budgets',()=>{
  // Separable concave net with its integer optimum at 97/303 of 400: 25/75 beats 50/50 and both singles.
  const total=400n,net=(a:bigint[],order:number[])=>-((a[0]-97n)**2n)-((a[1]-303n)**2n)+(order[0]===1?5n:0n);
  let calls=0;const result=searchAllocation({k:2,total,quantum:1n,overlap:true,deadline:Infinity,remaining:()=>1000-calls,evaluate:(o,a)=>{calls++;return net(a,o);}});
  let oracle={net:-(10n**30n),a:[0n,0n],o:[0,1]};
  for(let x=0n;x<=total;x++)for(const o of [[0,1],[1,0]]){const v=net([x,total-x],o);if(v>oracle.net)oracle={net:v,a:[x,total-x],o};}
  assert.deepEqual(result.amounts,oracle.a);assert.deepEqual(result.order,oracle.o);assert.equal(result.net,oracle.net);
  assert.ok(net([100n,300n],[0,1])>net([200n,200n],[0,1])&&net([100n,300n],[0,1])>net([400n,0n],[0,1])&&net([100n,300n],[0,1])>net([0n,400n],[0,1]));
  assert.ok(result.ordersTried>=2&&result.explored<=calls);
  let budget=7,used=0;const capped=searchAllocation({k:3,total,quantum:1n,overlap:false,deadline:Infinity,remaining:()=>budget-used,evaluate:()=>{used++;return null;}});
  assert.ok(used<=7);assert.equal(capped.net,null);
  const start=performance.now();searchAllocation({k:2,total,quantum:1n,overlap:false,deadline:start+20,remaining:()=>1e9,evaluate:(_o,a)=>{const t=performance.now();while(performance.now()-t<5);return -a[0];}});
  assert.ok(performance.now()-start<200);
  // Integration: shared-pool subsets reach the staged refinement without exceeding the attempt budget.
  const f=small();f.profile.maxBranches=2;f.profile.maxTotalSwaps=4;f.profile.maxAttempts=60;
  f.market.pools.push({...structuredClone(f.market.pools[1]),poolId:'arbitrum:42161:pool-2',poolAddress:`0x${'5'.repeat(40)}`,state:{protocol:'uniswap-v2',reserve0:'100000',reserve1:'120000',feeNumerator:'997',feeDenominator:'1000'}});
  f.request.riskProfileRef=ref('configuration',digest(f.profile));f.policy=compilePolicy(f.request,{body:f.profile,ref:f.request.riskProfileRef},f.market.asset,f.market.valuation,now);
  const solved=solvePoolGraph(f.request,f.policy,f.market,digest(f.market.pools),ref('configuration'));
  assert.ok(solved.search.attempted<=60);assert.equal(solved.routeStats.length,6);assert.ok(solved.routeStats.every(r=>r.routeId.length===64));
  marker('2',{explored:result.explored,attempted:solved.search.attempted});
});

test('FLASHLOAN_V6_EDGE_03 requests cannot lower the owner floor or grant authority; thresholds use raw units',()=>{
  const f=fixture(),approved:ApprovedProfile={body:f.profile,ref:f.request.riskProfileRef!},refs={valuation:ref('configuration'),networkCost:ref('configuration')};
  assert.throws(()=>toRunRequest({...runRequest(f),force_trade:true},approved,refs),/SCHEMA_INVALID_ARTIFACT/);
  assert.throws(()=>toRunRequest({...runRequest(f),hurdle_mode:'minimal_solvency'},approved,refs),/SCHEMA_INVALID_ARTIFACT/);
  assert.throws(()=>toRunRequest(runRequest(f,{policy_ref:null}),approved,refs),/INPUT_BLOCKED/);
  assert.throws(()=>toRunRequest(runRequest(f,{policy_ref:{id:'o',version:'1',hash:`sha256:${'b'.repeat(64)}`}}),approved,refs),/INPUT_BLOCKED/);
  assert.throws(()=>toRunRequest(runRequest(f,{execution_authorization_ref:`sha256:${h}`}),approved,refs),/SCHEMA_INVALID_ARTIFACT/);
  const mapped=toRunRequest(runRequest(f,{mode:'execute'}),approved,refs);assert.equal(mapped.mode,'unsigned-simulation');assert.equal(mapped.principalCapRaw,f.profile.principalCapRaw);
  const policy=compilePolicy(mapped,approved,f.market.asset,f.market.valuation,now);assert.equal(policy.executionAuthorizationRef,null);
  const lower=compilePolicy({...mapped,requestedMinProfitUsd:{numerator:'1',denominator:'100'}},approved,f.market.asset,f.market.valuation,now);assert.equal(lower.minProfitRaw,policy.minProfitRaw);
  const tighter=compilePolicy({...mapped,requestedMinProfitUsd:{numerator:'50',denominator:'1'}},approved,f.market.asset,f.market.valuation,now);assert.ok(BigInt(tighter.minProfitRaw)>BigInt(policy.minProfitRaw));
  // Independent bigint expectations: $10 floor in USDC (6 dp, $1) and WETH (18 dp, $2000), floored.
  assert.equal(rawThreshold({numerator:'10',denominator:'1'},{numerator:'1',denominator:'1'},6),10n*10n**6n);
  assert.equal(rawThreshold({numerator:'10',denominator:'1'},{numerator:'2000',denominator:'1'},18),10n*10n**18n/2000n);
  const ledger=buildLedger({runId:'r',schemaVersion:'5.2',asset:f.market.asset,principalRaw:'1000',deployedRaw:'1000',unusedPrincipalRaw:'0',swapProceedsRaw:'1100',flashFeeRaw:'5',networkCostRaw:'7',otherExternalCostsRaw:'3',operatorPrefundRaw:'0',executorOpeningBalanceRaw:'0',evidence:[]});
  assert.equal(ledger.simulatedNetRaw,(1100n-1000n-5n-7n-3n).toString());
  marker('3');
});

test('FLASHLOAN_V6_EDGE_04 stale, foreign or mismatched evidence blocks before simulation',()=>{
  const f=fixture(),approved:ApprovedProfile={body:f.profile,ref:f.request.riskProfileRef!},refs={valuation:ref('configuration'),networkCost:ref('configuration')};
  const other=`eip155:8453/erc20:${token1}`;
  assert.throws(()=>toRunRequest(runRequest(f,{selection:{...runRequest(f).selection,explicit_assets:[other]}}),approved,refs),/INPUT_BLOCKED/);
  const rehashed={...ref('configuration','c'.repeat(64)),observedAtNs:'1',expiresAtNs:null};
  assert.throws(()=>fresh(rehashed,now,10n),/STALE_EVIDENCE/,'a new hash with old observation time is not fresh');
  const expired={...f.request.riskProfileRef!,expiresAtNs:now.toString()};
  assert.throws(()=>compilePolicy(f.request,{body:f.profile,ref:expired},f.market.asset,f.market.valuation,now),/STALE_EVIDENCE/);
  const s=small(),timed=solvePoolGraph(s.request,s.policy,s.market,digest(s.market.pools),ref('configuration'),undefined,1e-9);
  assert.equal(timed.plan,null);assert.equal(timed.status,'INCONCLUSIVE');
  const versions=JSON.parse(readFileSync(new URL('../../config/flashloan-versions.json',import.meta.url),'utf8'));
  const observed={promptSha256:versions.prompt.sha256,publicSchema:'flashloan.public.v3',inventory:'flashloan.inventory.v2',movers:'flashloan.movers.v1',envelopeVersion:2,operations:['flashloan_capabilities']};
  assert.equal(checkCapabilities(versions,observed).runtime,'5.2');
  assert.throws(()=>checkCapabilities(versions,{...observed,promptSha256:'0'.repeat(64)}),/CAPABILITY_UNSUPPORTED/);
  assert.throws(()=>checkCapabilities(versions,{...observed,inventory:'flashloan.inventory.v9'}),/CAPABILITY_UNSUPPORTED/);
  const schema=readFileSync(new URL('../../schemas/flashloan-v6.schema.json',import.meta.url));
  assert.equal(createHash('sha256').update(schema).digest('hex'),FLASHLOAN_V6_SCHEMA_SHA256,'schema changed: bump the pin here and in hypermove');
  marker('4');
});

test('FLASHLOAN_V6_EDGE_05 unit: prefund cancels, drift is reported, unknown value halts',()=>{
  const f=fixture(),usdc=aid(token0),exec=`0x${'e'.repeat(40)}`,op=`0x${'f'.repeat(40)}`,tx=`0x${'a'.repeat(64)}`;
  const simulated=buildLedger({runId:'r',schemaVersion:'5.2',asset:f.market.asset,principalRaw:'1000',deployedRaw:'1000',unusedPrincipalRaw:'0',swapProceedsRaw:'1100',flashFeeRaw:'5',networkCostRaw:'10',otherExternalCostsRaw:'0',operatorPrefundRaw:'50',executorOpeningBalanceRaw:'0',evidence:[]});
  const header=(status:'success'|'revert')=>({chain_id:chain,round_id:'r',candidate_hash:`sha256:${h}`,policy_hash:`sha256:${h}`,block_hash:`0x${h}`,executor:{address:exec,runtime_hash:`0x${h}`,abi_hash:`sha256:${h}`},
    accounts:[{role:'executor' as const,address:exec},{role:'operator' as const,address:op}],transaction:{sender:op,calldata_hash:`0x${h}`,nonce:'7',tx_hash:tx},
    receipt:{tx_hash:tx,block_hash:`0x${h}`,status,finality:'finalized' as const,gas_used:'2',effective_gas_price:'3',l1_fee_raw:'4'},native_result_ref:null});
  const native={price:{numerator:'1',denominator:'1'},ref:ev};
  // Operator prefunded 50 to the executor inside S; actual proceeds 1090 (state drift of -10); gas 2*3+4=10 native.
  const base={header:header('success'),fixture:false,borrowAssetKey:usdc,simulated,actualSwapProceedsRaw:'1090',repaymentProven:true,prefundByAsset:{[usdc]:'50'},valuations:{native},minFinality:'safe' as const,
    opening:{[op]:{[usdc]:'500',native:'100'},[exec]:{[usdc]:'0'}},closing:{[op]:{[usdc]:'450',native:'90'},[exec]:{[usdc]:'135'}}};
  const ok=reconcileReceipt(base);
  assert.equal(ok.reconciliation,'RECONCILED');assert.equal(ok.net_by_asset[usdc],'85');assert.equal(ok.realized_net_raw,'75');assert.equal(ok.sim_drift_raw,'-10');
  assert.equal(reconcileReceipt({...base,closing:{...base.closing,[exec]:{[usdc]:'134'}}}).reconciliation,'MISMATCH');
  const odd=aid(`0x${'6'.repeat(40)}`);assert.equal(reconcileReceipt({...base,closing:{...base.closing,[exec]:{[usdc]:'135',[odd]:'1'}}}).reconciliation,'UNKNOWN');
  assert.equal(reconcileReceipt({...base,valuations:{}}).reconciliation,'UNKNOWN');
  assert.equal(reconcileReceipt({...base,header:{...header('success'),receipt:{...header('success').receipt,finality:'latest'}}}).reasons[0],'RECEIPT_NOT_FINAL');
  const reverted=reconcileReceipt({...base,header:header('revert'),actualSwapProceedsRaw:null,closing:{[op]:{[usdc]:'450',native:'90'},[exec]:{[usdc]:'50'}}});
  assert.equal(reverted.reconciliation,'RECONCILED');assert.equal(reverted.realized_net_raw,'-10');
  assert.throws(()=>reconcileReceipt({...base,fixture:true}),/RECEIPT_EVIDENCE_INVALID/);
  console.log(`FLASHLOAN_V6_EDGE_05_UNIT ${JSON.stringify({pass:true})}`);
});

test('FLASHLOAN_V6_EDGE_01 skill round: movers and explicit tokens reach the ledger through the funding runtime',async()=>{
  const f=small(),root=await mkdtemp(join(tmpdir(),'v6-round-')),approved={body:f.profile,ref:f.request.riskProfileRef!};
  const option:FundingOption={optionId:'a',lenderId:'a',lenderAddress:token1,callbackMode:'fixture',asset:f.market.asset,repaymentAsset:f.market.asset,identity:f.market.identity,capacityRaw:f.market.lender.capacityRaw,feeNumerator:'0',feeDenominator:'1',evidence:f.market.lender.evidence,executorCapabilityRef:ref('configuration')};
  let captures=0;const host:GapHost={...f.host,funding:async()=>[option],captureFunding:async()=>{captures++;return {market:f.market,profile:approved};}};
  const onecoin=`0x${'4'.repeat(40)}`,movers={schema_version:'flashloan.public.v3',data:{schema_version:'flashloan.movers.v1',completed_at:'2026-10-29T00:00:00.000Z',chains:[{chain_id:42161,outcome:'SUCCESS',tokens:[
    {token_id:onecoin.toUpperCase().replace('0X','0x'),price_change_24h_pct:31.25,liquidity_usd:'2.8e4'},{token_id:token1,price_change_24h_pct:-12.5,liquidity_usd:'50000'}]}]}};
  const versions=JSON.parse(readFileSync(new URL('../../config/flashloan-versions.json',import.meta.url),'utf8'));
  const base={host,store:new ArtifactStore(root),maxDurationMs:10000,nowNs:()=>now,fundingOptions:[option],profile:approved,refs:{valuation:f.market.valuation.ref,networkCost:f.market.networkCost.evidence},versions,movers};
  const req=runRequest(f,{policy_ref:{id:'owner',version:'1',hash:`sha256:${digest(f.profile)}`},selection:{...runRequest(f).selection,explicit_assets:[aid(token1)]}});
  await assert.rejects(runFlashRound(req,{...base,promptSha256:'0'.repeat(64)}),/CAPABILITY_UNSUPPORTED/);assert.equal(captures,0,'version mismatch blocks before capture');
  const round=await runFlashRound(req,{...base,promptSha256:versions.prompt.sha256});
  const byAsset=Object.fromEntries(round.ledger.items.map(i=>[i.asset_id,i]));
  assert.equal(byAsset[aid(token1)].outcome,'EVALUATED');assert.deepEqual(byAsset[aid(token1)].sources,['movers','explicit']);
  assert.equal(byAsset[aid(onecoin)].outcome,'INCOMPLETE_DATA');assert.equal(byAsset[aid(onecoin)].reason_code,'NOT_IN_CAPTURED_STATE');
  assert.equal(byAsset[aid(onecoin)].reported_metrics.liquidity_usd,'28000');assert.equal(round.ledger.source_state.coverage,'BOUNDED');assert.equal(round.request.mode,'research');
  const none=await runFlashRound(req,{...base,promptSha256:versions.prompt.sha256,movers:{schema_version:'flashloan.movers.v1',completed_at:'2026-10-29T00:00:00Z',chains:[{chain_id:42161,outcome:'EMPTY',tokens:[]}]}});
  assert.equal(none.ledger.source_state.coverage,'EMPTY_PROVIDER');
  marker('1',{scope:'skill-round',items:round.ledger.items.length});
});
