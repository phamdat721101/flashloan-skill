import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,pools,ref,now,token0,token1} from './flashloan-evidence-fixture.js';
import {compilePolicy} from '../evidence/economics.js';
import {sqrtRatioAtTick} from '../liquidity/clmm.js';
import {digest} from '../liquidity/state.js';
import {composeCurves,stationaryInput,allocateCpmm} from '../liquidity/price-gap.js';
import {solvePoolGraph} from '../evidence/solver.js';
import {ArtifactStore} from '../evidence/integrity.js';
import {runEvidence} from '../evidence/runtime.js';
import {runGapEvidence,type FundingOption,type GapHost,type GapRunRequest} from '../evidence/gap-runtime.js';
import {gapStreamWatchHost,type GapStreamUpdate} from '../evidence/gap-stream.js';
import type {WatchHost} from '../liquidity/trigger-watcher.js';
function small(){const f=fixture();f.request.schemaVersion='5.2';f.profile.minProfitUsd={numerator:'0',denominator:'1'};f.profile.minimumPrincipalRaw='1';f.profile.principalCapRaw='100';f.request.principalCapRaw='100';f.market.lender.capacityRaw='100';f.market.quantumRaw='1';f.request.riskProfileRef=ref('configuration',digest(f.profile));f.policy=compilePolicy(f.request,{body:f.profile,ref:f.request.riskProfileRef},f.market.asset,f.market.valuation,now);return f;}
test('GAP EDGE-01 v5.2 admits small positive net and legacy keeps its floor',()=>{
 const f=small();assert.equal(f.policy.minProfitRaw,'0');const s=solvePoolGraph(f.request,f.policy,f.market,digest(f.market.pools),ref('configuration'));assert.ok(s.plan);assert.ok(BigInt(s.plan.netProfitRaw.value!)>0n);
 const legacy={...f.request,schemaVersion:'5.1' as const};assert.throws(()=>compilePolicy(legacy,{body:f.profile,ref:legacy.riskProfileRef!},f.market.asset,f.market.valuation,now),/INVALID_VALUATION/);
 f.request.requestedMinProfitUsd={numerator:'10',denominator:'1'};assert.equal(compilePolicy(f.request,{body:f.profile,ref:f.request.riskProfileRef!},f.market.asset,f.market.valuation,now).minProfitRaw,'10');console.log(JSON.stringify({marker:'gap_small_profit_and_compatibility_proven',scope:'constructed-local-only'}));
});
test('GAP EDGE-02 serial composition matches independent rational nesting and stationary roots',()=>{
 for(let h=2;h<=6;h++){const hops=Array.from({length:h},(_,i)=>({a:BigInt(1200+i),b:1000n,c:1n}));const c=composeCurves(hops);
 for(let q=1n;q<=40n;q++){let n=q,d=1n;for(const hop of hops){[n,d]=[hop.a*n,hop.b*d+hop.c*n];}assert.equal(n*(c.b+c.c*q),c.a*q*d);}
 const q=stationaryInput(c,0n,1n);assert.ok(q>0n);assert.ok(c.a*c.b>=(c.b+c.c*q)**2n);assert.ok(c.a*c.b<(c.b+c.c*(q+1n))**2n);}
 for(let count=3;count<=8;count++){const allocation=allocateCpmm(Array.from({length:count},()=>({a:140000n,b:100000n,c:1n})),1000n,1n);assert.equal(allocation.reduce((a,b)=>a+b),1000n);assert.ok(allocation.every(n=>n>0n));assert.ok(allocation.every(n=>n*100n<18000n)||count<6);}
 console.log(JSON.stringify({marker:'gap_exact_serial_and_allocation_proven',scope:'constructed-local-only'}));
});
test('GAP solver finds a three-branch schedule and replays exact conservation',()=>{
 const f=small();f.profile.principalCapRaw='30000';f.profile.maxBranches=3;f.profile.maxHopsPerBranch=2;f.profile.maxTotalSwaps=6;f.profile.maxAttempts=512;f.profile.maxPriceImpactBps=10000;f.profile.deadlineMs=10000;f.request.principalCapRaw='30000';f.market.lender.capacityRaw='30000';f.market.quantumRaw='100';
 f.market.pools=Array.from({length:3},(_,i)=>pools().map((p,j)=>({...p,poolId:`arbitrum:42161:branch-${i}-${j}`,token1:`0x${String(i+5).repeat(40)}`}))).flat();f.request.riskProfileRef=ref('configuration',digest(f.profile));f.policy=compilePolicy(f.request,{body:f.profile,ref:f.request.riskProfileRef},f.market.asset,f.market.valuation,now);
 const result=solvePoolGraph(f.request,f.policy,f.market,digest(f.market.pools),ref('configuration'));assert.ok(result.plan);assert.equal(result.plan.branches.length,3);assert.equal(result.plan.branches.reduce((a,b)=>a+BigInt(b.allocatedRaw),0n),BigInt(result.plan.principalRaw));assert.equal(result.search.optimality,'best-found');assert.ok(result.search.attempted<=512);
});
test('GAP exact low-fee hurdle rejects a 45bps spread through two 30bps pools',()=>{
 const f=small();f.market.pools[1].state={protocol:'uniswap-v2',reserve0:'100000',reserve1:'100450',feeNumerator:'997',feeDenominator:'1000'};assert.equal(solvePoolGraph(f.request,f.policy,f.market,digest(f.market.pools),ref('configuration')).plan,null);
});
test('GAP EDGE-03 funding alternatives share a finite attempt budget and persist independently',async()=>{
 const f=small();const root=await mkdtemp(join(tmpdir(),'gap-funding-'));
 const make=(id:string):FundingOption=>({optionId:id,lenderId:id,lenderAddress:token1,callbackMode:'fixture',asset:f.market.asset,repaymentAsset:f.market.asset,identity:f.market.identity,capacityRaw:f.market.lender.capacityRaw,feeNumerator:'0',feeDenominator:'1',evidence:f.market.lender.evidence,executorCapabilityRef:ref('configuration')});
 const options=[make('a'),make('b')];const request:GapRunRequest={schemaVersion:'5.2',recordType:'gap-run-request',runId:f.request.runId,request:f.request,allowedAssets:[f.market.asset],allowedLenderIds:['a','b'],principalCapsRaw:{a:'100',b:'100'},maxFundingOptions:2,maxAttemptsTotal:12,deadlineMs:10000};
 const host:GapHost={...f.host,funding:async()=>options,captureFunding:async()=>({market:f.market,profile:{body:f.profile,ref:f.request.riskProfileRef!}})};
 const result=await runGapEvidence(request,{host,store:new ArtifactStore(root),maxDurationMs:10000,nowNs:()=>now});assert.equal(result.attempts.length,2);assert.equal(result.rounds.length,2,JSON.stringify(result.attempts));assert.ok(result.attempts.every(a=>a.attempted<=6));assert.ok(result.attempts.every(a=>a.error===null),JSON.stringify(result.attempts));assert.equal(result.selectedOptionId,'a');assert.ok(result.rounds.every(r=>r.integrity.verdict==='PASS'),JSON.stringify(result.rounds.map(r=>r.integrity)));
 const duplicate={...host,funding:async()=>[options[0],options[0]]};await assert.rejects(runGapEvidence(request,{host:duplicate,store:new ArtifactStore(root),maxDurationMs:10000}),/DUPLICATE_FUNDING_OPTION/);console.log(JSON.stringify({marker:'gap_dynamic_funding_budget_proven',scope:'constructed-local-only'}));
});
test('GAP EDGE-04 stream duplicates are ignored and gaps require explicit canonical resync',async()=>{
 const f=small();const u:GapStreamUpdate={sourceId:'fixture',adapterRevision:'fixture/1',generation:'1',cursor:'0',parentCursor:null,identity:f.market.identity,parentHash:'parent',payloadKind:'transactions',evidence:ref('canonical-state')};let captures=0,resyncs=0;
 const block={state:f.market.identity,parentHash:'parent',pools:f.market.pools,swaps:[]};const base:Omit<WatchHost,'blocks'>={current:async()=>block,evaluate:async()=>{throw Error('unused');},persist:async()=>{}};
 const host=gapStreamWatchHost({sourceId:u.sourceId,adapterRevision:u.adapterRevision,updates:async function*(){yield u;yield u;yield {...u,cursor:'2',parentCursor:'1'};},capture:async()=>{captures++;return block;},resync:async()=>{resyncs++;return block;},persist:async()=>{}},base);
 const seen=[];for await(const b of host.blocks(new AbortController().signal))seen.push(b);assert.equal(seen.length,2);assert.equal(captures,1);assert.equal(resyncs,1);assert.equal(seen[1].invalidated,true);console.log(JSON.stringify({marker:'gap_stream_lineage_proven',scope:'constructed-local-only'}));
});
test('GAP EDGE-05 version 5.2 survives full artifact publication and reload',async()=>{
 const f=small(),store=new ArtifactStore(await mkdtemp(join(tmpdir(),'gap-integrity-')));const round=await runEvidence(f.request,{host:f.host,store,nowNs:()=>now,maxDurationMs:10000});assert.equal(round.integrity.verdict,'PASS',JSON.stringify(round.integrity));const loaded=await store.load(f.request.runId);assert.equal(loaded.integrity.verdict,'PASS');assert.equal((loaded.artifacts.find(a=>a.kind==='policy')!.value as {minProfitRaw:string}).minProfitRaw,'0');console.log(JSON.stringify({marker:'gap_artifact_integrity_proven',scope:'constructed-local-only'}));
});

function fundingSetup(){
 const f=small();const option:FundingOption={optionId:'a',lenderId:'a',lenderAddress:token1,callbackMode:'fixture',asset:f.market.asset,repaymentAsset:f.market.asset,identity:f.market.identity,capacityRaw:f.market.lender.capacityRaw,feeNumerator:'0',feeDenominator:'1',evidence:f.market.lender.evidence,executorCapabilityRef:ref('configuration')};
 const request:GapRunRequest={schemaVersion:'5.2',recordType:'gap-run-request',runId:f.request.runId,request:f.request,allowedAssets:[f.market.asset],allowedLenderIds:['a'],principalCapsRaw:{a:'100'},maxFundingOptions:1,maxAttemptsTotal:50,deadlineMs:10000};
 const host:GapHost={...f.host,funding:async()=>[option],captureFunding:async()=>({market:f.market,profile:{body:f.profile,ref:f.request.riskProfileRef!}})};return {f,option,request,host};
}
test('large atom principals split equally without per-atom iteration',()=>{
 const total=10n**18n,curve={a:140000n*10n**18n,b:100000n*10n**18n,c:1n};const a=allocateCpmm([curve,curve,curve],total,1n);
 assert.equal(a.reduce((x,y)=>x+y),total);assert.ok(a.every(q=>q>=total/3n&&q<=total/3n+1n),String(a));
});
test('CLMM seed discovers feasible depth far below the owner principal cap',()=>{
 const f=small();f.profile.principalCapRaw='1000000000000000000';f.profile.maxPriceImpactBps=10000;f.request.principalCapRaw=f.profile.principalCapRaw;f.market.lender.capacityRaw=f.profile.principalCapRaw;
 f.market.pools=f.market.pools.map((p,i)=>({...p,state:{protocol:'uniswap-v3' as const,sqrtPriceX96:sqrtRatioAtTick(i?100:0).toString(),tick:i?100:0,liquidity:'1000000000000',feePips:3000,tickSpacing:1,unlocked:true,bitmapWords:[-1,0,1].map(wordPosition=>({wordPosition,bitmap:'0'})),initializedTicks:[],lowerTick:-200,upperTick:200}}));
 f.request.riskProfileRef=ref('configuration',digest(f.profile));f.policy=compilePolicy(f.request,{body:f.profile,ref:f.request.riskProfileRef},f.market.asset,f.market.valuation,now);
 const result=solvePoolGraph(f.request,f.policy,f.market,digest(f.market.pools),ref('configuration'));assert.ok(result.plan,JSON.stringify(result.search));assert.ok(BigInt(result.plan.netProfitRaw.value!)>0n);assert.ok(BigInt(result.plan.principalRaw)<10n**12n);
});
test('funding enforces the shorter host deadline and makes progress after a stalled option',async()=>{
 const {f,option,request,host}=fundingSetup();const store=new ArtifactStore(await mkdtemp(join(tmpdir(),'gap-deadline-')));
 await assert.rejects(runGapEvidence(request,{host:{...host,funding:async()=>new Promise(()=>{})},store,maxDurationMs:20}),/GAP_CANCELLED/);
 const b={...option,optionId:'b',lenderId:'b'};request.allowedLenderIds.push('b');request.principalCapsRaw.b='100';request.maxFundingOptions=2;request.maxAttemptsTotal=100;
 const result=await runGapEvidence(request,{host:{...host,funding:async()=>[option,b],captureFunding:async(r,o,s)=>o.optionId==='a'?new Promise(()=>{}):host.captureFunding(r,o,s)},store,maxDurationMs:1000,nowNs:()=>now});
 assert.equal(result.attempts.length,2);assert.equal(result.attempts[0].error,'FUNDING_OPTION_DEADLINE');assert.equal(result.selectedOptionId,'b');
});
test('funding caps and owner profile binding cannot be loosened by captured options',async()=>{
 const {f,request,host}=fundingSetup();request.request.principalCapRaw='1';const store=new ArtifactStore(await mkdtemp(join(tmpdir(),'gap-caps-')));
 const result=await runGapEvidence(request,{host,store,maxDurationMs:1000,nowNs:()=>now});const p=result.rounds[0].artifacts.find(a=>a.kind==='policy')!.value as {principalCapRaw:string};assert.equal(p.principalCapRaw,'1');
 const other={...host,captureFunding:async()=>({market:f.market,profile:{body:f.profile,ref:ref('configuration','f'.repeat(64))}})};
 const bad=await runGapEvidence({...request,runId:'other',request:{...request.request,runId:'other'}},{host:other,store,maxDurationMs:1000,nowNs:()=>now});assert.equal(bad.attempts[0].error,'FUNDING_PROFILE_MISMATCH');
});
test('distinct borrow assets use exact decimal-normalized valuation and retain lender bindings',async()=>{
 const {f,option,request,host}=fundingSetup();f.market.pools=f.market.pools.map(p=>({...p,decimals1:6}));
 const otherAsset={...f.market.asset,assetId:token1,decimals:6};const b={...option,optionId:'b',lenderId:'b',asset:otherAsset,repaymentAsset:otherAsset};request.allowedAssets.push(otherAsset);request.allowedLenderIds.push('b');request.principalCapsRaw.b='100';request.maxFundingOptions=2;request.maxAttemptsTotal=100;
 const marketB={...f.market,asset:otherAsset,networkCost:{...f.market.networkCost,asset:otherAsset},valuation:{...f.market.valuation,price:{numerator:'2000000',denominator:'1'}}};
 const result=await runGapEvidence(request,{host:{...host,funding:async()=>[option,b],captureFunding:async(_r,o)=>({market:o.optionId==='b'?marketB:f.market,profile:{body:f.profile,ref:f.request.riskProfileRef!}})},store:new ArtifactStore(await mkdtemp(join(tmpdir(),'gap-assets-'))),nowNs:()=>now,maxDurationMs:10000});
 assert.equal(result.selectedOptionId,'b',JSON.stringify(result.attempts));assert.ok(result.rounds.every(r=>r.artifacts.some(a=>a.kind==='funding-option')));const contexts=result.rounds.map(r=>(r.artifacts.find(a=>a.kind==='plan')!.value as {executionContextHash:string}).executionContextHash);assert.notEqual(contexts[0],contexts[1]);
});

test('quantized marginal allocation improves previously allocated quanta',()=>{
 assert.deepEqual(allocateCpmm([{a:182n,b:35n,c:5n},{a:185n,b:32n,c:10n},{a:137n,b:18n,c:8n}],6n,1n),[3n,1n,2n]);
});
test('direct runtime rejects substituted funding terms and expired executor capability',async()=>{
 for(const mutate of [(o:FundingOption)=>{o.feeNumerator='1';},(o:FundingOption)=>{o.executorCapabilityRef.expiresAtNs='1';}]){
 const {f,option}=fundingSetup();mutate(option);f.market.fundingOption=option;f.request.fundingOptionRef={...option.evidence,contentHash:digest(option)};
 const round=await runEvidence(f.request,{host:f.host,store:new ArtifactStore(await mkdtemp(join(tmpdir(),'gap-direct-'))),nowNs:()=>now,maxDurationMs:1000});
 assert.equal(round.artifacts.some(a=>a.kind==='plan'),false);const report=round.artifacts.find(a=>a.kind==='report')!.value as {reasons:string[]};assert.ok(report.reasons.some(r=>r==='FUNDING_EVIDENCE_MISMATCH'||r==='STALE_EVIDENCE'));
 }
});
test('scaled CLMM depth discovery does not depend on token decimal order',()=>{
 const f=small();f.profile.principalCapRaw=(10n**36n).toString();f.profile.maxPriceImpactBps=10000;f.request.principalCapRaw=f.profile.principalCapRaw;f.market.lender.capacityRaw=f.profile.principalCapRaw;f.market.networkCost.amountRaw={value:(10n**18n).toString(),reason:null};
 f.market.pools=f.market.pools.map((p,i)=>({...p,state:{protocol:'uniswap-v3' as const,sqrtPriceX96:sqrtRatioAtTick(i?100:0).toString(),tick:i?100:0,liquidity:(10n**30n).toString(),feePips:3000,tickSpacing:1,unlocked:true,bitmapWords:[-1,0,1].map(wordPosition=>({wordPosition,bitmap:'0'})),initializedTicks:[],lowerTick:-200,upperTick:200}}));
 f.request.riskProfileRef=ref('configuration',digest(f.profile));f.policy=compilePolicy(f.request,{body:f.profile,ref:f.request.riskProfileRef},f.market.asset,f.market.valuation,now);
 assert.ok(solvePoolGraph(f.request,f.policy,f.market,digest(f.market.pools),ref('configuration')).plan);
});
test('a blocked negative child never certifies the aggregate funding domain',async()=>{
 const {f,option,request,host}=fundingSetup();f.profile.principalCapRaw='2';f.request.principalCapRaw='2';f.market.lender.capacityRaw='2';option.capacityRaw='2';request.principalCapsRaw.a='2';f.market.pools[1].state=structuredClone(f.market.pools[0].state);f.request.riskProfileRef=ref('configuration',digest(f.profile));
 const result=await runGapEvidence(request,{host,store:new ArtifactStore(await mkdtemp(join(tmpdir(),'gap-blocked-'))),nowNs:()=>now,maxDurationMs:10000,approvedOwnerRefs:new Set(['a'.repeat(64)]),checks:[{schemaVersion:'5.1',recordType:'lesson-check',runId:f.request.runId,checkId:'block-zero',lessonId:'owner-test',lessonVersionHash:'a'.repeat(64),stage:'report',severity:'BLOCK',ownerApprovalRef:'a'.repeat(64),predicate:{kind:'FORBID_POLICY_VALUE',field:'minProfitRaw',forbidden:['0']}}]});
 assert.equal(result.status,'INCONCLUSIVE');assert.equal(result.attempts[0].status,'EVIDENCE_BLOCKED');
});
test('stream adapter preserves class host prototype methods',()=>{
 class Host {value=1;async current(){assert.equal(this.value,1);return {state:fixture().market.identity,parentHash:'p',pools:pools(),swaps:[]};}async persist(){assert.equal(this.value,1);}async evaluate():Promise<never>{throw Error('unused');}}
 const adapted=gapStreamWatchHost({sourceId:'s',adapterRevision:'r',updates:async function*(){},capture:async()=>{throw Error('unused');},resync:async()=>{throw Error('unused');},persist:async()=>{}},new Host());
 assert.equal(typeof adapted.current,'function');return adapted.current(new AbortController().signal).then(()=>adapted.persist({} as never,new AbortController().signal));
});
