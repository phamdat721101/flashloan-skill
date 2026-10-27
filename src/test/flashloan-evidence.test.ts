import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {optimizeTradeSize,type SizingBounds} from '../adaptive-sizing.js';
import {digest} from '../liquidity/state.js';
import type {PoolStateEnvelope} from '../liquidity/projection.js';
import {validateRecord,type Asset,type EvidenceRef,type RunRequest,type NativeProof} from '../evidence/contracts.js';
import {buildLedger,compilePolicy,rawThreshold,type Profile} from '../evidence/economics.js';
import {ArtifactStore,evaluateLessonChecks,evidenceBytes,inspectRound,type ArtifactInput,type IntegrityContext,type LessonCheck} from '../evidence/integrity.js';
import {runEvidence,type CapturedMarket,type EvidenceHost} from '../evidence/runtime.js';
import {classifyLiquidityPattern,buildEntryBand,bracketSMin} from '../liquidity/entry-band.js';
import {projectRoundRow,roundRowCsv,ROUND_ROW_COLUMNS_V1} from '../execution-outcome.js';
import {h,now,token0,token1,asset,ref,pools,fixture} from './flashloan-evidence-fixture.js';
const bounds:SizingBounds={minAmount:1n,maxAmount:100n,quantum:1n,maxEvaluations:6,deadlineMs:100,maxPriceImpactBps:100,expectedBlock:1n,expectedStateDigest:h,minProfitRaw:1n};
test('FLASHLOAN_T01 T02 T03 rejected, thrown, hanging, cancelled and foreign quotes consume finite attempts',async()=>{
 for(const quoter of [async()=>undefined,async()=>{throw new Error('READ_FAILED');}]){let count=0;const r=await optimizeTradeSize(bounds,async()=>{count++;return quoter();});assert.equal(count,6);assert.equal(r.rejected,6);assert.equal(r.winner,undefined);}
 const hung=await optimizeTradeSize({...bounds,deadlineMs:10},async()=>new Promise(()=>{}));assert.equal(hung.attempted,1);assert.equal(hung.termination,'time-budget');
 const controller=new AbortController();controller.abort();const cancelled=await optimizeTradeSize({...bounds,signal:controller.signal},async()=>undefined);assert.equal(cancelled.attempted,0);
 const foreign=await optimizeTradeSize(bounds,async amountIn=>({amountIn,netProfitRaw:10n,quoteBlock:2n,stateDigest:h,priceImpactBps:1}));assert.equal(foreign.rejected,6);
});
test('FLASHLOAN_T07 T08 T09 exact policy floors, strict atom threshold and profile identity',()=>{
 const {request,profile,market,policy}=fixture();assert.equal(policy.minProfitRaw,'10');assert.equal(rawThreshold({numerator:'10',denominator:'1'},{numerator:'3',denominator:'1'},0),3n);
 assert.equal(compilePolicy({...request,requestedMinProfitUsd:{numerator:'0',denominator:'1'},principalCapRaw:'10000'},{body:profile,ref:request.riskProfileRef!},asset,market.valuation,now).principalCapRaw,'1000');
 assert.throws(()=>compilePolicy(request,{body:{...profile,maxAttempts:999},ref:request.riskProfileRef!},asset,market.valuation,now),/INPUT_BLOCKED/);
});
test('FLASHLOAN_T13 T14 principal and costs conserve exactly; prefund is excluded',()=>{
 const input={schemaVersion:'5.1' as const,runId:'ledger',asset,principalRaw:'1000',deployedRaw:'950',unusedPrincipalRaw:'50',swapProceedsRaw:'960',flashFeeRaw:'1',networkCostRaw:'1',otherExternalCostsRaw:'0',operatorPrefundRaw:'700',executorOpeningBalanceRaw:'300',evidence:[ref('configuration')]};
 const ledger=buildLedger(input);assert.equal(ledger.simulatedNetRaw,'8');assert.equal(ledger.realizedNetRaw.value,null);assert.throws(()=>buildLedger({...input,unusedPrincipalRaw:'0'}),/PRINCIPAL/);assert.throws(()=>validateRecord('Ledger',{...ledger,principalRaw:1000}),/SCHEMA_INVALID/);
});
test('FLASHLOAN_T43 T45 T47 T48 T69 T71 exact depth bands, null costs and bounded bands',()=>{
 const {policy,market}=fixture();const pattern=classifyLiquidityPattern(market.pools,10,'test-run',[ref('canonical-state')]);validateRecord('LiquidityPattern',pattern);
 const enabled={...policy,watchMode:'band' as const,maxTriggerToSimulationBlocks:2,bandTtlBlocks:3,bandRebuildTicks:1,bandMaxEvaluationsPerRow:4,bandMaxEvaluationsTotal:12,watchQueueCapacity:2,watchMaxSolves:2};
 const band=buildEntryBand({pools:market.pools,pattern,policy:enabled,lender:{provider:'fixture',feePips:0,capacityRaw:'1000',callbackAdmitted:false},networkCostRaw:null,minimumRaw:'100',quantumRaw:'100',triggerGridRaw:['100','200']});
 assert.ok(band.rows.every(r=>r.solve.netRaw===null&&r.solve.reason));assert.ok(band.rows.reduce((n,r)=>n+r.solve.evaluations,0)<=12);assert.ok(band.sMin.every(r=>r.method==='incomplete-evidence'));
 assert.deepEqual(bracketSMin(0n,10n,8,()=>null),{low:'0',high:'10',method:'grid-first-positive',evaluations:1});
});
test('FLASHLOAN_T49 corrected strict schema permits bandless solve but requires run lineage and a reason',()=>{
 const value={schemaVersion:'5.1',recordType:'trigger-observation',runId:'watch',state:fixture().market.identity,transactionId:'tx',logIndex:0,poolId:'p',direction:'sell-base',amountInRaw:'1',observedAtNs:'1',inclusionToObservationMs:null,bandRef:null,sMinRaw:null,decision:'SOLVE',solverRunId:'solver',reason:'SHADOW'};
 validateRecord('TriggerObservation',value);assert.throws(()=>validateRecord('TriggerObservation',{...value,solverRunId:null}),/SCHEMA/);assert.throws(()=>validateRecord('TriggerObservation',{...value,reason:null}),/SCHEMA/);
});
test('FLASHLOAN_T56 T57 T58 T59 T61 T68 T72 integrity, reuse and approved lesson gate prevent publication',async()=>{
 const context:IntegrityContext={runId:'run',roundId:'R1',stateDigest:null,policyHash:null,candidateHash:null,executionContextHash:null,payloadHash:null,executorCodeOrPackageHash:null,adapterRevision:null,nowNs:now.toString()};
 const report={schemaVersion:'5.1',recordType:'round-report',runId:'run',outcome:'INCONCLUSIVE',policyHash:null,stateDigest:null,inventoryRefs:[],solverRef:null,simulationRef:null,ledgerRef:null,receiptRef:null,changedState:[],reasons:['$2,000 is display text']};
 const inputs:ArtifactInput[]=[{kind:'report',definition:'Report',value:report}];const integrity=inspectRound(inputs,context);assert.equal(integrity.verdict,'PASS');assert.equal(integrity.evidenceClass,'PARAMETRIC');
 const root=await mkdtemp(join(tmpdir(),'evidence-gate-')),store=new ArtifactStore(root);await store.publish(inputs,context);assert.equal((await store.load('run')).context.runId,'run');
 assert.equal(inspectRound([{...inputs[0],value:{...report,evidenceClass:'NATIVE_SIM'}}],context).verdict,'BLOCK');
 const check:LessonCheck={schemaVersion:'5.1',recordType:'lesson-check',runId:'run',checkId:'test',lessonId:'lesson',lessonVersionHash:h,stage:'report',severity:'BLOCK',ownerApprovalRef:null,predicate:{kind:'NONEMPTY_ARTIFACTS'}};
 assert.throws(()=>evaluateLessonChecks([check],inputs,integrity),/SCHEMA/);assert.throws(()=>evidenceBytes({bad:undefined}),/NON_SERIALIZABLE/);
 assert.throws(()=>evaluateLessonChecks([{...check,ownerApprovalRef:h,predicate:{kind:'eval'} as never}],inputs,integrity),/SCHEMA/);
 const approved={...check,ownerApprovalRef:h};assert.throws(()=>evaluateLessonChecks([approved],inputs,integrity),/OWNER_APPROVAL_UNVERIFIED/);
 const empty={...integrity,artifacts:[{...integrity.artifacts[0],bytes:0}]};
 assert.equal(evaluateLessonChecks([approved],inputs,empty,undefined,[],new Set([h])).blocked,true);
 assert.equal(evaluateLessonChecks([{...approved,severity:'WARN'}],inputs,empty).blocked,false);
});
test('FLASHLOAN_T66 full offline pipeline uses real exact pool math and retains model fidelity',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'evidence-offline-'));const result=await runEvidence(f.request,{store:new ArtifactStore(root),host:f.host,nowNs:()=>now,maxDurationMs:5000});
 assert.equal(result.integrity.verdict,'PASS',JSON.stringify(result.integrity));assert.equal(result.integrity.evidenceClass,'SNAPSHOT_MODEL');
 const report=result.artifacts.find(a=>a.kind==='report')!.value as import('../evidence/contracts.js').Report;assert.equal(report.outcome,'INCONCLUSIVE');
 const state=result.artifacts.find(a=>a.kind==='canonical-state')!.value as import('../evidence/contracts.js').StateBundle;
 const plan=result.artifacts.find(a=>a.kind==='plan')!.value as import('../evidence/contracts.js').Plan;assert.ok(BigInt(plan.netProfitRaw.value!)>10n);
 const row=projectRoundRow(report,result.integrity,{state,plan,recall:result.recall},{date:'2026-10-27',roundId:'R1',strategy:'S1',artifactPath:root});
 validateRecord('RoundRow',row);assert.equal(row.net_usd,null);assert.equal(ROUND_ROW_COLUMNS_V1.length,26);assert.ok(roundRowCsv([row]).startsWith(ROUND_ROW_COLUMNS_V1.join(',')));
 assert.ok(result.artifacts.some(a=>a.kind==='stage-event'));assert.equal((await new ArtifactStore(root).load('test-run')).artifacts.length,result.artifacts.length);
});

test('pre-save gate rejects arithmetically false ledgers and native-free positive outcomes',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'economic-mutation-')),store=new ArtifactStore(root),m=await runEvidence(f.request,{host:f.host,store,nowNs:()=>now,maxDurationMs:5000});
 const report=m.artifacts.find(a=>a.kind==='report')!.value as import('../evidence/contracts.js').Report;
 const forged=m.artifacts.map(a=>a.kind==='report'?{...a,value:{...report,outcome:'SIMULATED_OPPORTUNITY'}}:a);
 assert.equal(inspectRound(forged,m.context).verdict,'BLOCK');
 const ledger=buildLedger({schemaVersion:'5.1',runId:f.request.runId,asset,principalRaw:'100',deployedRaw:'100',unusedPrincipalRaw:'0',swapProceedsRaw:'120',flashFeeRaw:'0',networkCostRaw:'1',otherExternalCostsRaw:'0',operatorPrefundRaw:'0',executorOpeningBalanceRaw:'0',evidence:[ref('configuration')]});
 assert.equal(inspectRound([...m.artifacts,{kind:'ledger',definition:'Ledger',value:{...ledger,simulatedNetRaw:'999999'}}],m.context).verdict,'BLOCK');
 assert.equal(inspectRound([...m.artifacts,{kind:'ledger',definition:'Ledger',value:ledger}],m.context).verdict,'BLOCK','internally valid ledger must match selected principal');
 const state=m.artifacts.find(a=>a.kind==='canonical-state')!;assert.equal(inspectRound([{...state,value:{...(state.value as object),poolEvidence:[]}}],m.context).evidenceClass,'PARAMETRIC');
});
test('FLASHLOAN_T21 decimal metadata conflict blocks before solve, and inclusive USD floors round upward',async()=>{
 const f=fixture(),price={price:{numerator:'3',denominator:'1'},ref:f.market.valuation.ref};
 const p=compilePolicy({...f.request,requestedMinPrincipalUsd:{numerator:'10',denominator:'1'}},{body:f.profile,ref:f.request.riskProfileRef!},asset,price,now);assert.equal(p.minimumPrincipalRaw,'100');
 const profile={...f.profile,minimumPrincipalRaw:'0'},profileRef=ref('configuration',digest(profile));
 const tight=compilePolicy({...f.request,riskProfileRef:profileRef,requestedMinPrincipalUsd:{numerator:'10',denominator:'1'}},{body:profile,ref:profileRef},asset,price,now);assert.equal(tight.minimumPrincipalRaw,'4');
 f.market.pools[0].decimals0=18;const root=await mkdtemp(join(tmpdir(),'wrong-decimals-')),m=await runEvidence(f.request,{store:new ArtifactStore(root),host:f.host,nowNs:()=>now,maxDurationMs:5000});
 const report=m.artifacts.find(a=>a.kind==='report')!.value as import('../evidence/contracts.js').Report;assert.ok(report.reasons.includes('ASSET_DECIMALS_MISMATCH'));assert.ok(!m.artifacts.some(a=>a.kind==='plan'));
});
test('FLASHLOAN_T56 historical empty and invalid files retain original hashes and bytes',async()=>{
 const {writeFile}=await import('node:fs/promises'),{loadRawArtifact}=await import('../evidence/integrity.js');const root=await mkdtemp(join(tmpdir(),'legacy-bytes-'));
 await writeFile(join(root,'empty.json'),'');await writeFile(join(root,'bad.json'),'{broken');
 const context:IntegrityContext={runId:'legacy',roundId:'legacy',stateDigest:null,policyHash:null,candidateHash:null,executionContextHash:null,payloadHash:null,executorCodeOrPackageHash:null,adapterRevision:null,nowNs:now.toString()};
 const rows=inspectRound([await loadRawArtifact(join(root,'empty.json')),await loadRawArtifact(join(root,'bad.json'))],context);assert.equal(rows.artifacts[0].bytes,0);assert.equal(rows.artifacts[0].parse,'empty');assert.equal(rows.artifacts[1].parse,'invalid-json');assert.notEqual(rows.artifacts[0].sha256,rows.artifacts[1].sha256);assert.equal(rows.verdict,'BLOCK');
});

test('coverage exhaustion cannot certify a finite V3 sizing domain',async()=>{
 const {sizeConditionalCycle}=await import('../liquidity/sizing.js');
 const ps=pools().map(p=>({...p,state:{protocol:'uniswap-v3' as const,sqrtPriceX96:'79228162514264337593543950336',tick:0,liquidity:'1000000',feePips:3000,tickSpacing:1,unlocked:true,lowerTick:-1,upperTick:1,bitmapWords:[{wordPosition:-1,bitmap:'0'},{wordPosition:0,bitmap:'0'}],initializedTicks:[]}}));
 const venues=ps.map(p=>({poolId:p.poolId,identity:p.identity,token0:p.token0,token1:p.token1,kind:'pool' as const,state:p,feeResolutions:[]}));
 const result=sizeConditionalCycle(venues,{schemaVersion:'4.0',snapshotDigest:digest(venues),borrowAsset:token0,route:[{poolId:ps[0].poolId,tokenIn:token0},{poolId:ps[1].poolId,tokenIn:token1}],minimum:'1000000',maximum:'1000000',quantum:'1',lenderAvailable:'1000000',flashFeeNumerator:'0',flashFeeDenominator:'1',costInBorrowAsset:'0',costEvidenceDigest:h,minProfit:'1',maxEvaluations:1});
 assert.equal(result.status,'incomplete-evidence');assert.equal(result.evidenceComplete,false);assert.equal(result.optimality,'best-found');assert.ok(result.rejectedQuotes.CLMM_COVERAGE_EXHAUSTED>0);
});
test('fabricated negative coverage is rejected and a complete negative replays from retained domain bytes',async()=>{
 const f=fixture();f.market.pools[1].state={...f.market.pools[0].state};
 const root=await mkdtemp(join(tmpdir(),'negative-replay-')),store=new ArtifactStore(root),m=await runEvidence(f.request,{store,host:f.host,nowNs:()=>now,maxDurationMs:5000});
 const report=m.artifacts.find(a=>a.kind==='report')!.value as import('../evidence/contracts.js').Report;
 assert.equal(report.outcome,'NO_OPPORTUNITY');assert.equal(m.integrity.verdict,'PASS');
 const solver=m.artifacts.find(a=>a.kind==='solver')!.value as {search:import('../evidence/contracts.js').Search};
 const forged={...solver,search:{...solver.search,attempted:1,accepted:1}};
 const mutated=m.artifacts.map(a=>a.kind==='solver'?{...a,value:forged}:a.kind==='report'?{...a,value:{...report,solverRef:digest(forged)}}:a);
 assert.equal(inspectRound(mutated,m.context).verdict,'BLOCK');const rejected=await new ArtifactStore(await mkdtemp(join(tmpdir(),'reject-negative-'))).publish(mutated,m.context);assert.equal(rejected.artifacts.length,0);
});
test('fresh native results cannot promote expired bound state and cost evidence',async()=>{
 const {deriveEvidenceClass}=await import('../evidence/integrity.js'),{createHash}=await import('node:crypto');
 const f=fixture(),m=await runEvidence(f.request,{host:f.host,store:new ArtifactStore(await mkdtemp(join(tmpdir(),'native-age-'))),nowNs:()=>now,maxDurationMs:5000});
 const raw=(kind:string,hex:string):ArtifactInput=>({kind,definition:'RawEvidence',value:{schemaVersion:'5.1',recordType:'raw-evidence',runId:f.request.runId,evidenceKind:kind,bytesHex:hex,contentHash:createHash('sha256').update(Buffer.from(hex.slice(2),'hex')).digest('hex')}});
 const payload=raw('unsigned-payload','0x1234'),result=raw('native-result','0x7b7d'),ph=(payload.value as {contentHash:string}).contentHash,rh=(result.value as {contentHash:string}).contentHash;
 const original=m.artifacts.find(a=>a.kind==='plan')!.value as import('../evidence/contracts.js').Plan,plan={...original,unsignedPayloadRef:ref('configuration',ph)};plan.planHash=digest(Object.fromEntries(Object.entries(plan).filter(([k])=>k!=='planHash')));
 const proof:NativeProof={schemaVersion:'5.1',recordType:'native-simulation-proof',runId:f.request.runId,candidateHash:plan.planHash,stateDigest:plan.stateDigest,policyHash:plan.policyHash,payloadHash:ph,executorCodeOrPackageHash:h,adapterRevision:'test',fidelity:'existing-native',success:true,repaymentProven:true,terminalBalanceBasis:'before-debt-with-unused',terminalBalanceRaw:{value:'1001',reason:null},revertDataRef:null,overrideRefs:[],resultEvidence:{...ref('native-simulation',rh),expiresAtNs:(now+1000000000000n).toString()},executionContextHash:plan.executionContextHash};
 const inputs=[...m.artifacts.filter(a=>!['plan','report'].includes(a.kind)),{kind:'plan',definition:'Plan',value:plan},payload,result,{kind:'native-simulation',definition:'NativeProof',value:proof}],ctx={...m.context,candidateHash:plan.planHash,payloadHash:ph,executorCodeOrPackageHash:h,adapterRevision:'test',executionContextHash:plan.executionContextHash};
 assert.equal(deriveEvidenceClass(inputs,ctx),'NATIVE_SIM');
 const later=now+BigInt(f.policy.maxStateAgeNs)+1n;proof.resultEvidence.observedAtNs=later.toString();
 assert.equal(deriveEvidenceClass(inputs,{...ctx,nowNs:later.toString()}),'SNAPSHOT_MODEL');
});
test('readiness requires execution mode, addresses, canonical reads, gas, budget and admission',async()=>{
 const {assessReadiness,EvmBudget}=await import('../evm/budget.js'),{AttemptJournal}=await import('../liquidity/journal.js'),root=await mkdtemp(join(tmpdir(),'readiness-')),journal=new AttemptJournal(join(root,'attempts.jsonl')),budget=new EvmBudget(42161,token0 as `0x${string}`,root);
 const chain={identity:fixture().market.identity,nativeBalance:async()=> '1',executorBalances:async()=>[],canonical:async()=>true};
 const run=(mode:'research'|'authorized-execution',admitted=true,operator:string|null=token0,executor:string|null=token1,gas='1',canonical=true,b=budget)=>assessReadiness(mode,{...chain,nativeBalance:async()=>gas,canonical:async()=>canonical},operator,executor,{admitted},journal,b,'ready') as Promise<{verdict:string;reasons:string[]}>;
 assert.equal((await run('authorized-execution')).verdict,'READY');
 for(const row of [await run('research'),await run('authorized-execution',false),await run('authorized-execution',true,null),await run('authorized-execution',true,token0,null),await run('authorized-execution',true,token0,token1,'0'),await run('authorized-execution',true,token0,token1,'1',false),await assessReadiness('authorized-execution',chain,token0,token1,{admitted:true},journal,undefined,'missing-budget') as {verdict:string}])assert.notEqual(row.verdict,'READY');
});
