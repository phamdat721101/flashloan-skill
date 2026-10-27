import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../liquidity/state.js';
import {runTriggerWatcher,type TriggerBlock,type TriggerObservation,type TriggerSurvival,type WatchHost,type WatchEvaluation} from '../liquidity/trigger-watcher.js';
import {classifyLiquidityPattern,EntryBandCache} from '../liquidity/entry-band.js';
import type {RoundManifest} from '../evidence/integrity.js';
import {fixture,ref,h} from './flashloan-evidence-fixture.js';
function block(height='1',hash=`0x${h}`):TriggerBlock{const f=fixture();return {state:{...f.market.identity,height,stateHashOrDigest:hash},parentHash:`0x${h}`,pools:f.market.pools.map(p=>({...p,identity:{...p.identity,height,...(p.identity.chain==='sui'?{checkpointDigest:hash}:{blockHash:hash})}})),swaps:[{transactionId:'tx',logIndex:0,poolId:f.market.pools[0].poolId,direction:'sell-base',amountInRaw:'100',observedAtNs:'1',inclusionToObservationMs:null}]};}
function evaluation(b:TriggerBlock):WatchEvaluation{return {state:b.state,producedAtHeight:b.state.height,solveMs:1,simulationMs:0,manifest:{schemaVersion:'5.1',context:{runId:'stub',roundId:'stub',stateDigest:null,policyHash:null,candidateHash:null,executionContextHash:null,payloadHash:null,executorCodeOrPackageHash:null,adapterRevision:null,nowNs:'1'},artifacts:[],integrity:{schemaVersion:'5.1',recordType:'artifact-integrity',runId:'stub',roundId:'stub',artifacts:[],stateInvariance:{comparedRunId:null,stateDigestChanged:null,economicResultChanged:null,verdict:'NOT_COMPARABLE'},evidenceClass:'PARAMETRIC',flags:[],verdict:'PASS'},recall:{schemaVersion:'5.1',recordType:'recall-application',runId:'stub',mappingHash:h,memorySequence:0,recalled:[],results:[],uncheckedLessons:[],blocked:false}}};}
const limits=()=>({...fixture().policy,watchMode:'shadow' as const,maxTriggerToSimulationBlocks:2,watchQueueCapacity:2,watchMaxSolves:2,deadlineMs:100});
test('FLASHLOAN_T73 canonical shadow replay records queued, solve and unknown survival without native promotion',async()=>{
 const rows:Array<TriggerObservation|TriggerSurvival>=[],b=block();
 const host:WatchHost={blocks:async function*(){yield b;yield b;},current:async()=>b,evaluate:async b=>evaluation(b),persist:async row=>{rows.push(structuredClone(row));}};
 const result=await runTriggerWatcher(host,{runId:'watch',policy:limits(),maxDurationMs:1000,maxObservations:5});
 assert.equal(result.observations,1);assert.equal(result.solved,1);assert.ok(rows.some(r=>r.recordType==='trigger-observation'&&r.decision==='QUEUED'));
 assert.equal(rows.filter(r=>r.recordType==='trigger-survival').length,1);assert.ok(rows.every(r=>r.recordType!=='trigger-survival'||r.result==='UNKNOWN'));
});
test('FLASHLOAN_T67 deadline and mismatched requested head state cannot produce survival',async()=>{
 for(const [name,current,evaluate]of [['late',block('10'),async(b:TriggerBlock)=>evaluation(b)],['foreign',block(),async()=>evaluation(block('2',`0x${'b'.repeat(64)}`))]] as const){
  const rows:Array<TriggerObservation|TriggerSurvival>=[];await runTriggerWatcher({blocks:async function*(){yield block();},current:async()=>current,evaluate,persist:async r=>{rows.push(r);}},{runId:name,policy:limits(),maxDurationMs:1000,maxObservations:1});
  const row=rows.find(r=>r.recordType==='trigger-survival') as TriggerSurvival;assert.equal(row.result,'UNKNOWN');assert.equal(row.reason,name==='late'?'TRIGGER_DEADLINE_EXCEEDED':'SURVIVAL_STATE_MISMATCH');
 }
});
test('FLASHLOAN_T73 completed observations receive durable invalidation even when replacement has no swaps',async()=>{
 let done!:()=>void;const completed=new Promise<void>(r=>{done=r;}),rows:Array<TriggerObservation|TriggerSurvival>=[],b=block(),replacement={...block('1',`0x${'b'.repeat(64)}`),swaps:[]};
 const host:WatchHost={blocks:async function*(){yield b;await completed;yield replacement;},current:async()=>b,evaluate:async x=>evaluation(x),persist:async r=>{rows.push(structuredClone(r));if(r.recordType==='trigger-survival')done();}};
 await runTriggerWatcher(host,{runId:'reorg',policy:limits(),maxDurationMs:1000,maxObservations:5});
 assert.ok(rows.some(r=>r.recordType==='trigger-observation'&&r.decision==='REORGED'));assert.ok(rows.some(r=>r.recordType==='trigger-survival'&&r.reason==='TRIGGER_REORGED'));
});
test('watch operation deadlines bound a hanging producer and a hanging memory-independent persistence callback',async()=>{
 const b=block();const start=performance.now();
 await assert.rejects(runTriggerWatcher({blocks:async function*(){await new Promise(()=>{});yield b;},current:async()=>b,evaluate:async x=>evaluation(x),persist:async()=>{}},{runId:'hung',policy:{...limits(),deadlineMs:10},maxDurationMs:100,maxObservations:1}),/WATCH_OPERATION_DEADLINE/);
 assert.ok(performance.now()-start<1000);
 await assert.rejects(runTriggerWatcher({blocks:async function*(){yield b;},current:async()=>b,evaluate:async x=>evaluation(x),persist:async()=>new Promise(()=>{})},{runId:'hung-persist',policy:{...limits(),deadlineMs:10},maxDurationMs:100,maxObservations:1}),/WATCH_OPERATION_DEADLINE/);
});
test('FLASHLOAN_T70 band cache invalidates on costs, liquidity events and expiry',()=>{
 const f=fixture(),cache=new EntryBandCache(),policy={...f.policy,watchMode:'band' as const,maxTriggerToSimulationBlocks:2,bandTtlBlocks:3,bandRebuildTicks:1,bandMaxEvaluationsPerRow:2,bandMaxEvaluationsTotal:4,watchQueueCapacity:1,watchMaxSolves:1};
 const input={pools:f.market.pools,pattern:classifyLiquidityPattern(f.market.pools,10,f.request.runId,[ref('canonical-state')]),policy,lender:{provider:'fixture',feePips:0,capacityRaw:'1000',callbackAdmitted:false},networkCostRaw:null,minimumRaw:'100',quantumRaw:'100',triggerGridRaw:['100']};
 const first=cache.get(input);assert.deepEqual(cache.get(input),first);assert.equal(cache.rebuildCount,1);
 cache.get(input,['mint']);assert.equal(cache.rebuildCount,2);cache.get(input,['mint']);assert.equal(cache.rebuildCount,2);cache.get(input,['burn']);assert.equal(cache.rebuildCount,3);
 cache.get({...input,lender:{...input.lender,feePips:1}});assert.equal(cache.rebuildCount,4);
 const changed=cache.get({...input,policy:{...policy,networkCostEvidenceRef:ref('configuration','b'.repeat(64))}});assert.notEqual(changed.costEvidenceRef,undefined);assert.equal(cache.rebuildCount,5);
 const expired=structuredClone(input);expired.pattern.state.height='9';const after=cache.get(expired,['mint']);assert.equal(after.validThroughHeight,'12');assert.equal(cache.rebuildCount,6);
});
test('source divergence and global cancellation retain terminal unknown audit records',async()=>{
 for(const mode of ['source','cancel']){
  let finish!:()=>void;const completed=new Promise<void>(r=>{finish=r;}),rows:Array<TriggerObservation|TriggerSurvival>=[],b=block();
  const host:WatchHost={blocks:async function*(){yield b;if(mode==='source'){await completed;throw new Error('SOURCE_GAP_OR_DIVERGENCE');}},current:async()=>b,evaluate:mode==='cancel'?async()=>new Promise(()=>{}):async x=>evaluation(x),persist:async r=>{rows.push(structuredClone(r));if(r.recordType==='trigger-survival')finish();}};
  if(mode==='source')await assert.rejects(runTriggerWatcher(host,{runId:mode,policy:limits(),maxDurationMs:1000,maxObservations:5}),/SOURCE_GAP/);
  else await runTriggerWatcher(host,{runId:mode,policy:limits(),maxDurationMs:10,maxObservations:1});
  assert.ok(rows.some(r=>r.recordType==='trigger-survival'&&r.reason===(mode==='source'?'TRIGGER_REORGED':'WATCH_CANCELLED')));
 }
});
test('canonical ancestry mismatch is unknown before positive classification',async()=>{
 const rows:Array<TriggerObservation|TriggerSurvival>=[],b=block(),head={...block('2'),parentHash:`0x${'b'.repeat(64)}`};
 await runTriggerWatcher({blocks:async function*(){yield b;},current:async()=>head,evaluate:async x=>evaluation(x),persist:async r=>{rows.push(r);}},{runId:'ancestry',policy:limits(),maxDurationMs:1000,maxObservations:1});
 assert.ok(rows.some(r=>r.recordType==='trigger-survival'&&r.reason==='SURVIVAL_ANCESTRY_UNVERIFIED'));
});
test('band cache binds numerical solve grid, quantum, cost and lower bound',()=>{
 const f=fixture(),policy={...f.policy,watchMode:'band' as const,maxTriggerToSimulationBlocks:2,bandTtlBlocks:3,bandRebuildTicks:1,bandMaxEvaluationsPerRow:2,bandMaxEvaluationsTotal:4,watchQueueCapacity:1,watchMaxSolves:1};
 const input={pools:f.market.pools,pattern:classifyLiquidityPattern(f.market.pools,10,f.request.runId,[ref('canonical-state')]),policy,lender:{provider:'fixture',feePips:0,capacityRaw:'1000',callbackAdmitted:false},networkCostRaw:null,minimumRaw:'100',quantumRaw:'100',triggerGridRaw:['100']};
 const cache=new EntryBandCache();cache.get({...input,triggerGridRaw:undefined});cache.get({...input,triggerGridRaw:undefined});assert.equal(cache.rebuildCount,1);cache.clear();cache.get(input);let builds=2;
 for(const change of [{triggerGridRaw:['200']},{minimumRaw:'200'},{quantumRaw:'200'},{networkCostRaw:'1'}]){cache.get({...input,...change});assert.equal(cache.rebuildCount,++builds);}
});
