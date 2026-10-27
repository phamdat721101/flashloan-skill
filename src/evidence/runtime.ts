import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { digest, uint } from '../liquidity/state.js';
import { parsePoolState, projectPool, type PoolStateEnvelope, type ProjectionResult } from '../liquidity/projection.js';
import { attributeLegs } from '../liquidity/sizing.js';
import { compilePolicy, buildLedger, verifyNative, verifyPlan, type ApprovedProfile } from './economics.js';
import { ArtifactStore, evidenceBytes, type ArtifactInput, type IntegrityContext, type LessonCheck, type RecalledLesson, type RoundManifest } from './integrity.js';
import { fresh, recordHash, sameAsset, validateRecord, type Asset, type Cost, type EvidenceRef, type Identity, type NativeProof, type Plan, type Policy, type Ratio, type Report, type RunRequest, type Search, type StateBundle } from './contracts.js';
import {solvePoolGraph,type CapturedMarket} from './solver.js';
export {solvePoolGraph,type CapturedMarket,type ExactPoolSolve} from './solver.js';
export interface CompiledPayload {bytesHex:string;executionContextHash:string;executorCodeOrPackageHash:string;adapterRevision:string;sourceId:string;observedAtNs:string;expiresAtNs:string;executionCandidate?:import('../liquidity/runtime.js').RouteCandidate}
export interface EvidenceHost {
  profile(request:RunRequest,signal:AbortSignal):Promise<ApprovedProfile>;
  inventory(request:RunRequest,signal:AbortSignal):Promise<unknown[]>;
  capture(request:RunRequest,signal:AbortSignal):Promise<CapturedMarket>;
  readiness?(request:RunRequest,signal:AbortSignal):Promise<unknown>;
  compile?(request:RunRequest,plan:Plan,market:CapturedMarket,signal:AbortSignal):Promise<CompiledPayload>;
  simulate?(request:RunRequest,plan:Plan,payload:CompiledPayload,market:CapturedMarket,signal:AbortSignal):Promise<{proof:NativeProof;rawResult:{bytesHex:string}}>;
  memory?(proposal:{runId:string;evidenceClass:string;status:'provisional';sources:string[];statement:string},signal:AbortSignal):Promise<void>;
}
export interface EvidenceOptions {store:ArtifactStore;host?:EvidenceHost;checks?:LessonCheck[];approvedOwnerRefs?:ReadonlySet<string>;previous?:RoundManifest;signal?:AbortSignal;nowNs?:()=>bigint;maxDurationMs:number}
const kindRef=(kind:EvidenceRef['kind'],value:unknown,sourceId:string,observedAtNs:string,expiresAtNs:string|null):EvidenceRef=>({kind,contentHash:createHash('sha256').update(evidenceBytes(value)).digest('hex'),sourceId,locator:'content-addressed',observedAtNs,expiresAtNs});
export const payloadHash=(bytesHex:string)=>{if(!/^0x(?:[a-f0-9]{2})+$/i.test(bytesHex))throw new Error('INVALID_PAYLOAD_BYTES');return createHash('sha256').update(Buffer.from(bytesHex.slice(2),'hex')).digest('hex');};
export async function runEvidence(raw:unknown,options:EvidenceOptions):Promise<RoundManifest>{
  const obj=raw as {schemaVersion?:unknown};const request=validateRecord<RunRequest>('RunRequest',raw,obj?.schemaVersion==='5.0'?'5.0':'5.1');
  if(!Number.isSafeInteger(options.maxDurationMs)||options.maxDurationMs<1||options.maxDurationMs>3600000)throw new Error('INVALID_RUN_DEADLINE');
  const now=options.nowNs??(()=>BigInt(Date.now())*1000000n),controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)controller.abort();
  const timer=setTimeout(abort,options.maxDurationMs),inputs:ArtifactInput[]=[],events:unknown[]=[];
  let policy:Policy|undefined,market:CapturedMarket|undefined,plan:Plan|undefined;
  const ctx:IntegrityContext={runId:request.runId,roundId:request.roundId??request.runId,stateDigest:null,policyHash:null,candidateHash:null,executionContextHash:null,payloadHash:null,executorCodeOrPackageHash:null,adapterRevision:null,nowNs:now().toString()};
  const report:Report={schemaVersion:request.schemaVersion,recordType:'round-report',runId:request.runId,outcome:'INCONCLUSIVE',policyHash:null,stateDigest:null,inventoryRefs:[],solverRef:null,simulationRef:null,ledgerRef:null,receiptRef:null,changedState:[],reasons:[]};
  const put=(kind:string,definition:string,value:unknown)=>{validateRecord(definition,value,(value as {schemaVersion?:string}).schemaVersion==='5.0'?'5.0':'5.1');inputs.push({kind,definition,value});return createHash('sha256').update(evidenceBytes(value)).digest('hex');};
  const rawEvidence=(kind:string,bytesHex:string)=>{const contentHash=payloadHash(bytesHex);put(kind,'RawEvidence',{schemaVersion:'5.1',recordType:'raw-evidence',runId:request.runId,evidenceKind:kind,bytesHex,contentHash});return contentHash;};
  const step=async<T>(stage:string,operation:()=>Promise<T>):Promise<T>=>{
    if(controller.signal.aborted)throw new Error('RUN_CANCELLED');const started=performance.now();let cancel:(()=>void)|undefined;
    try{const value=await Promise.race([operation(),new Promise<never>((_,reject)=>{cancel=()=>reject(new Error('RUN_CANCELLED'));controller.signal.addEventListener('abort',cancel,{once:true});})]);events.push({stage,outcome:'accepted',atNs:now().toString(),durationMs:Math.floor(performance.now()-started)});return value;}catch(e){events.push({stage,outcome:'failed',atNs:now().toString(),durationMs:Math.floor(performance.now()-started)});throw e;}finally{if(cancel)controller.signal.removeEventListener('abort',cancel);}
  };
  try{
    const host=options.host;if(!host)throw new Error('HANDOFF_REQUIRED');
    if(host.readiness&&request.schemaVersion==='5.1')put('readiness','Readiness',await step('readiness',()=>host.readiness!(request,controller.signal)));
    const approved=await step('policy',()=>host.profile(request,controller.signal));
    const inventory=await step('discovery',()=>host.inventory(request,controller.signal));
    for(const row of inventory)report.inventoryRefs.push(put('discovery','Inventory',row));
    market=await step('state',()=>host.capture(request,controller.signal));
    if(!market.pools.length||market.pools.length>16||market.pools.some(p=>p.stateClass!=='canonical'||digest(p.identity)!==digest(market!.pools[0].identity))||market.identity.finality==='provisional')throw new Error('INCOHERENT_STATE');
    const source=market.pools[0].identity,sourceHash=source.chain==='sui'?source.checkpointDigest:source.blockHash;
    if(market.identity.namespace!==(source.chain==='sui'?'sui':'eip155')||market.asset.namespace!==market.identity.namespace||market.asset.networkId!==market.identity.networkId||source.network!==request.networkId||market.identity.networkId!==request.networkId||source.height!==market.identity.height||sourceHash!==market.identity.stateHashOrDigest)throw new Error('STATE_IDENTITY_MISMATCH');
    for(const pool of market.pools){if(pool.token0===market.asset.assetId&&pool.decimals0!==market.asset.decimals||pool.token1===market.asset.assetId&&pool.decimals1!==market.asset.decimals)throw new Error('ASSET_DECIMALS_MISMATCH');}
    const decimals=new Map<string,number>();for(const pool of market.pools)for(const [token,value]of [[pool.token0,pool.decimals0],[pool.token1,pool.decimals1]] as const){if(decimals.has(token)&&decimals.get(token)!==value)throw new Error('ASSET_DECIMALS_MISMATCH');decimals.set(token,value);}
    if(!decimals.has(market.asset.assetId))throw new Error('BORROW_ASSET_MISMATCH');
    policy=compilePolicy(request,approved,market.asset,market.valuation,now());ctx.policyHash=policy.policyHash;report.policyHash=policy.policyHash;put('policy','Policy',policy);
    if(market.networkCost.evidence.contentHash!==request.networkCostEvidenceRef?.contentHash)throw new Error('COST_EVIDENCE_MISMATCH');
    fresh({kind:'canonical-state',contentHash:digest(market.pools),sourceId:'host',locator:'state',observedAtNs:market.observedAtNs,expiresAtNs:null},now(),uint(policy.maxStateAgeNs));
    fresh(market.lender.evidence,now(),uint(policy.maxStateAgeNs));fresh(market.networkCost.evidence,now(),uint(policy.maxStateAgeNs));
    if(!sameAsset(market.asset,market.networkCost.asset)||!uint(market.lender.feeDenominator))throw new Error('FUNDING_EVIDENCE_MISMATCH');
    ctx.stateDigest=digest(market.pools);report.stateDigest=ctx.stateDigest;
    const poolRefs=market.pools.map(p=>{const bytesHex='0x'+evidenceBytes(p).toString('hex');const contentHash=rawEvidence('raw-pool',bytesHex);return {kind:'canonical-state' as const,contentHash,sourceId:'explicit-host',locator:'content-addressed',observedAtNs:market!.observedAtNs,expiresAtNs:null};});
    const state:StateBundle={schemaVersion:request.schemaVersion,recordType:'state-bundle',runId:request.runId,identity:market.identity,stateDigest:ctx.stateDigest,poolEvidence:poolRefs,lenderEvidence:market.lender.evidence,coverageComplete:market.pools.every(p=>p.state.protocol==='uniswap-v2'),coverageReasons:market.pools.some(p=>p.state.protocol!=='uniswap-v2')?['BOUNDED_TICK_HORIZON']:[]};
    put('canonical-state','StateBundle',state);
    if(!host.readiness)report.reasons.push('READINESS_HOST_UNAVAILABLE');
    const domainBytes='0x'+evidenceBytes({request,market}).toString('hex'),domainHash=rawEvidence('search-domain',domainBytes);
    const domainRef:EvidenceRef={kind:'configuration',contentHash:domainHash,sourceId:'exact-pool-graph',locator:'content-addressed',observedAtNs:now().toString(),expiresAtNs:null};
    const solved=await step('solve',async()=>solvePoolGraph(request,policy!,market!,ctx.stateDigest!,domainRef));
    plan=solved.plan??undefined;
    if(plan&&host.compile&&host.simulate&&request.caller&&request.executor){
      const payload=await step('payload',()=>host.compile!(request,plan!,market!,controller.signal));
      ctx.payloadHash=rawEvidence('unsigned-payload',payload.bytesHex);ctx.executionContextHash=payload.executionContextHash;ctx.executorCodeOrPackageHash=payload.executorCodeOrPackageHash;ctx.adapterRevision=payload.adapterRevision;
      if(payload.executionContextHash!==plan.executionContextHash)throw new Error('EXECUTION_CONTEXT_MISMATCH');
      plan.unsignedPayloadRef={kind:'configuration',contentHash:ctx.payloadHash,sourceId:payload.sourceId,locator:'unsigned-payload',observedAtNs:payload.observedAtNs,expiresAtNs:payload.expiresAtNs};plan.planHash=recordHash(plan,'planHash');ctx.candidateHash=plan.planHash;
      if(payload.executionCandidate){ctx.executionCandidateHash=digest(payload.executionCandidate);put('execution-candidate','ExecutionCandidate',{schemaVersion:'5.1',recordType:'execution-candidate',runId:request.runId,planHash:plan.planHash,candidate:payload.executionCandidate});}
      put('plan','Plan',plan);
      const simulation=await step('simulate',()=>host.simulate!(request,plan!,payload,market!,controller.signal));
      if(rawEvidence('native-result',simulation.rawResult.bytesHex)!==simulation.proof.resultEvidence.contentHash)throw new Error('NATIVE_RESULT_HASH_MISMATCH');
      report.simulationRef=put('native-simulation','NativeProof',simulation.proof);
      if(request.executorMode==='existing'){
        verifyNative(simulation.proof,plan,{payloadHash:ctx.payloadHash,executorCodeOrPackageHash:payload.executorCodeOrPackageHash,adapterRevision:payload.adapterRevision,nowNs:now(),maxAgeNs:uint(policy.maxStateAgeNs)});
        if(!market.openingBalances)throw new Error('OPENING_BALANCE_EVIDENCE_MISSING');
        fresh(market.openingBalances.evidence,now(),uint(policy.maxStateAgeNs));
        const opening=uint(market.openingBalances.executorOpeningBalanceRaw)+uint(market.openingBalances.operatorPrefundRaw);
        const terminal=uint(simulation.proof.terminalBalanceRaw.value!),principal=uint(plan.principalRaw),fee=uint(plan.flashFeeRaw),unused=uint(plan.unusedPrincipalRaw);
        const totalBefore=simulation.proof.terminalBalanceBasis==='before-debt-with-unused'?terminal:terminal+principal+fee;
        if(totalBefore<opening)throw new Error('NATIVE_BALANCE_BASIS_MISMATCH');const before=totalBefore-opening;
        if(before<unused)throw new Error('NATIVE_BALANCE_BASIS_MISMATCH');
        const ledger=buildLedger({schemaVersion:request.schemaVersion,runId:request.runId,asset:market.asset,principalRaw:plan.principalRaw,deployedRaw:(principal-unused).toString(),unusedPrincipalRaw:plan.unusedPrincipalRaw,swapProceedsRaw:(before-unused).toString(),flashFeeRaw:plan.flashFeeRaw,networkCostRaw:market.networkCost.amountRaw.value!,otherExternalCostsRaw:'0',operatorPrefundRaw:market.openingBalances.operatorPrefundRaw,executorOpeningBalanceRaw:market.openingBalances.executorOpeningBalanceRaw,evidence:[simulation.proof.resultEvidence,market.networkCost.evidence]});
        report.ledgerRef=put('ledger','Ledger',ledger);report.outcome=BigInt(ledger.simulatedNetRaw)>uint(policy.minProfitRaw)?'SIMULATED_OPPORTUNITY':'INCONCLUSIVE';
      }else report.reasons.push('FIXTURE_NATIVE_RESEARCH_ONLY');
    }else report.outcome=solved.status==='CERTIFIED_NO_OPPORTUNITY'?'NO_OPPORTUNITY':'INCONCLUSIVE';
    if(plan){ctx.candidateHash=plan.planHash;ctx.executionContextHash=plan.executionContextHash;if(!inputs.some(a=>a.kind==='plan'))put('plan','Plan',plan);if(request.schemaVersion==='5.1'){const quotes=solved.quotes;let cursor=0;const legs=plan.branches.flatMap(b=>b.poolPath.map(()=>({branchId:b.branchId,quote:quotes[cursor++]})));put('attribution','LegAttribution',attributeLegs({runId:request.runId,planHash:plan.planHash,stateDigest:plan.stateDigest,requestedRaw:policy.principalCapRaw,solvedRaw:plan.principalRaw,netRaw:plan.netProfitRaw.value!,legs},market.pools));}}
    const solver={schemaVersion:request.schemaVersion,recordType:'solver-result',runId:request.runId,status:solved.status,stateDigest:ctx.stateDigest,policyHash:policy.policyHash,search:solved.search,planRef:plan?.planHash??null,reasonCodes:plan?[]:[solved.status]};report.solverRef=put('solver','SolverResult',solver);
    if(plan&&report.outcome!=='SIMULATED_OPPORTUNITY')report.reasons.push('NATIVE_PROOF_OR_CONTEXT_UNAVAILABLE');
  }catch(e){const typed=e as {code?:unknown};const code=typeof typed.code==='string'&&/^[A-Z_]+$/.test(typed.code)?typed.code:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'TOOL_ERROR';report.outcome=code==='HANDOFF_REQUIRED'?'TOOL_ERROR':code==='INPUT_BLOCKED'?'INPUT_BLOCKED':code==='POLICY_UNSUPPORTED'?'POLICY_UNSUPPORTED':'INCONCLUSIVE';report.reasons.push(code);}
  finally{ /* Keep the absolute deadline active through persistence and optional memory. */ }
  for(const [index,value]of events.entries()){const event=value as {stage:string;outcome:string;atNs:string;durationMs:number};const allowed=['request','discovery','state','quote','solve','simulate','admit','submit','receipt','memory',...(request.schemaVersion==='5.1'?['readiness','pattern','watch','integrity','recall']:[])];put('stage-event','StageEvent',{schemaVersion:request.schemaVersion,recordType:'stage-event',runId:request.runId,eventId:`${request.runId}:${index}`,stage:allowed.includes(event.stage)?event.stage:'request',outcome:event.outcome,candidateHash:ctx.candidateHash,policyHash:ctx.policyHash,stateDigest:ctx.stateDigest,attemptNumber:index,code:event.outcome==='accepted'?'STAGE_COMPLETE':'STAGE_FAILED',retryable:false,receivedAtNs:event.atNs,durationMs:event.durationMs,evidence:[]});}
  put('report','Report',report);ctx.nowNs=now().toString();
  try{
    let manifest=await options.store.publish(inputs,ctx,{approvedOwnerRefs:options.approvedOwnerRefs,previous:options.previous,checks:options.checks?.map(c=>({...c,runId:request.runId})),recalled:(request.recalledLessons??[]).filter((l):l is RecalledLesson=>l.status==='active'||l.status==='provisional')});
    if(options.host?.memory&&manifest.integrity.verdict==='PASS'&&!manifest.recall.blocked)try{
      await step('memory',()=>options.host!.memory!({runId:request.runId,evidenceClass:manifest.integrity.evidenceClass,status:'provisional',sources:manifest.artifacts.map(a=>a.hash),statement:`${report.outcome}: ${report.reasons.join(',')}`},controller.signal));
    }catch{
      const event={schemaVersion:request.schemaVersion,recordType:'stage-event',runId:request.runId,eventId:`${request.runId}:memory-unavailable`,stage:'memory',outcome:'failed',candidateHash:ctx.candidateHash,policyHash:ctx.policyHash,stateDigest:ctx.stateDigest,attemptNumber:0,code:'MEMORY_UNAVAILABLE',retryable:false,receivedAtNs:now().toString(),durationMs:0,evidence:[]};
      const amendmentOf=createHash('sha256').update(evidenceBytes(manifest)).digest('hex');
      manifest=await options.store.publish([...inputs,{kind:'stage-event',definition:'StageEvent',value:event}],ctx,{approvedOwnerRefs:options.approvedOwnerRefs,amendmentOf,previous:options.previous,checks:options.checks?.map(c=>({...c,runId:request.runId}))});
    }
    return manifest;
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);controller.abort();}

}
/** Explicit registry supplied by the embedding host; requests cannot import modules or launch commands. */
export class EvidenceHosts {private readonly hosts=new Map<string,EvidenceHost>();register(name:string,host:EvidenceHost){if(!/^[a-z][a-z0-9-]{0,63}$/.test(name)||this.hosts.has(name))throw new Error('INVALID_HOST_REGISTRATION');this.hosts.set(name,host);}get(name:string){return this.hosts.get(name);}}
export async function loadLessonMapping(path:string,runId:string):Promise<LessonCheck[]>{const raw=JSON.parse(await readFile(path,'utf8')) as {schemaVersion?:unknown;checks?:unknown};if(raw.schemaVersion!=='5.1'||!Array.isArray(raw.checks)||raw.checks.length>1024||Object.keys(raw).some(k=>!['schemaVersion','checks'].includes(k)))throw new Error('INVALID_LESSON_MAPPING');return raw.checks.map(c=>validateRecord<LessonCheck>('LessonCheck',{...c,runId}));}
