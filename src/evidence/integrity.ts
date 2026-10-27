import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutionLock } from '../execution-lock.js';
import { AttemptJournal } from '../liquidity/journal.js';
import { parsePoolState, projectPool, type PoolStateEnvelope } from '../liquidity/projection.js';
import { verifyLedger, verifyPlan, verifyNative } from './economics.js';
import { digest, parseStateIdentity, uint } from '../liquidity/state.js';
import {solvePoolGraph,type CapturedMarket} from './solver.js';
import type {RunRequest,Search} from './contracts.js';
import { evmProfile } from '../evm-chains.js';
import { receiptNativeCost } from '../evm-fees.js';
import { fresh, validateRecord, type EvidenceClass, type Header, type NativeProof, type Plan, type StateBundle, type Policy, type Ledger, type Report } from './contracts.js';

export interface ArtifactInput { kind:string; definition:string; value:unknown; reuse?:{runId:string;hash:string};rawBytesHex?:string }
export interface Artifact { path:string;kind:string; sha256:string; bytes:number; parse:'ok'|'empty'|'invalid-json'|'schema-invalid'; declaredReuse:boolean; reusedFrom:{runId:string;path:string}|null }
export interface IntegrityContext {
  runId:string; roundId:string; stateDigest:string|null; policyHash:string|null; candidateHash:string|null;
  executionContextHash:string|null; payloadHash:string|null; executorCodeOrPackageHash:string|null; adapterRevision:string|null;
  nowNs:string; attemptId?:string; executionCandidateHash?:string;
}
export interface Integrity extends Header {
  roundId:string; artifacts:Artifact[]; stateInvariance:{comparedRunId:string|null;stateDigestChanged:boolean|null;economicResultChanged:boolean|null;verdict:'STATE_DEPENDENT'|'PARAMETRIC_SUSPECT'|'NOT_COMPARABLE'};
  evidenceClass:EvidenceClass;flags:string[];verdict:'PASS'|'BLOCK';
}
export interface LessonCheck {
  schemaVersion:'5.1';recordType:'lesson-check';runId:string;checkId:string;lessonId:string;lessonVersionHash:string;
  stage:'solve'|'simulate'|'report'|'memory';severity:'WARN'|'BLOCK';ownerApprovalRef:string|null;predicate:Predicate;
}
export type Predicate = {kind:'RESULT_MUST_CHANGE_WITH_STATE';resultPointer:string}|{kind:'REQUIRES_EVIDENCE_KIND';when:EvidenceClass;evidenceKind:'canonical-state'|'native-simulation'|'receipt'}|{kind:'FORBID_POLICY_VALUE';field:string;forbidden:Array<string|number>}|{kind:'PRINCIPAL_CONSERVED'}|{kind:'NONEMPTY_ARTIFACTS'}|{kind:'HASH_DIFFERS_FROM_PREVIOUS_ROUND';artifactKind:string};
export interface RecalledLesson {lessonId:string;versionHash:string;status:'active'|'provisional'}
export interface RecallApplication extends Header { mappingHash:string;memorySequence:number;recalled:Array<RecalledLesson&{checkIds:string[]}>;results:Array<{checkId:string;artifactPath:string;result:'PASS'|'VIOLATION'|'NOT_APPLICABLE';severity:'WARN'|'BLOCK';detail:string}>;uncheckedLessons:string[];blocked:boolean }
export interface RoundManifest { schemaVersion:'5.1';context:IntegrityContext;artifacts:Array<ArtifactInput&{hash:string}>;integrity:Integrity;recall:RecallApplication;previousManifestHash?:string|null;hashing?:{content:string;plan:string;policy:string;payload:string} }
const definitions:Record<string,string>={discovery:'Inventory','canonical-state':'StateBundle','counterfactual-model':'Plan','native-simulation':'NativeProof',policy:'Policy',plan:'Plan',ledger:'Ledger',report:'Report',solver:'SolverResult',readiness:'Readiness',pattern:'LiquidityPattern',band:'EntryBand',trigger:'TriggerObservation',survival:'TriggerSurvival',attribution:'LegAttribution',receipt:'Receipt','raw-pool':'RawEvidence','unsigned-payload':'RawEvidence','native-result':'RawEvidence','search-domain':'RawEvidence','stage-event':'StageEvent','native-receipt':'RawEvidence','execution-candidate':'ExecutionCandidate'};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export function evidenceBytes(value:unknown):Buffer {
  const visit=(v:unknown):unknown=>{
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'&&Number.isFinite(v))return v;
    if(Array.isArray(v))return v.map(visit);
    if(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)))return Object.fromEntries(Object.keys(v).sort().map(k=>[k,visit((v as Record<string,unknown>)[k])]));
    throw new Error('NON_SERIALIZABLE_EVIDENCE');
  };
  return Buffer.from(JSON.stringify(visit(value)));
}
const hashBytes=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
function validInput(a:ArtifactInput,runId:string):boolean {
  try {
    if(!definitions[a.kind]||definitions[a.kind]!==a.definition)return false;
    const h=object(a.value);if(h.runId!==runId&&!a.reuse)return false;
    validateRecord(a.definition,a.value,h.schemaVersion==='5.0'?'5.0':'5.1');if(a.definition==='RawEvidence'&&(h.evidenceKind!==a.kind||typeof h.bytesHex!=='string'||createHash('sha256').update(Buffer.from(h.bytesHex.slice(2),'hex')).digest('hex')!==h.contentHash))return false;return true;
  }catch{return false;}
}
function canonicalPools(inputs:ArtifactInput[],ctx:IntegrityContext):PoolStateEnvelope[]|null {
  try{
    const state=inputs.find(a=>a.kind==='canonical-state'&&!a.reuse&&validInput(a,ctx.runId))?.value as StateBundle|undefined;
    if(!state||state.stateDigest!==ctx.stateDigest||!state.poolEvidence.length||state.identity.finality==='provisional')return null;
    const pools=state.poolEvidence.map(ref=>{const raw=inputs.find(a=>a.kind==='raw-pool'&&!a.reuse&&object(a.value).contentHash===ref.contentHash&&validInput(a,ctx.runId));if(!raw)throw new Error('MISSING_POOL_BYTES');return parsePoolState(JSON.parse(Buffer.from(String(object(raw.value).bytesHex).slice(2),'hex').toString('utf8')));});
    if(digest(pools)!==state.stateDigest||pools.some(p=>p.stateClass!=='canonical'||p.identity.network!==state.identity.networkId||p.identity.height!==state.identity.height||(p.identity.chain==='sui'?p.identity.checkpointDigest:p.identity.blockHash)!==state.identity.stateHashOrDigest))return null;
    return pools;
  }catch{return null;}
}
function semanticFlags(inputs:ArtifactInput[],ctx:IntegrityContext,evidenceClass:EvidenceClass):string[]{
  const flags=new Set<string>(),get=(kind:string)=>inputs.find(a=>a.kind===kind&&!a.reuse)?.value;
  const policy=get('policy') as Policy|undefined,plan=get('plan') as Plan|undefined,ledger=get('ledger') as Ledger|undefined,proof=get('native-simulation') as NativeProof|undefined;
  const pools=canonicalPools(inputs,ctx);
  if(get('canonical-state')&&!pools)flags.add('LINEAGE_MISMATCH');
  try{
    if(policy&&(policy.runId!==ctx.runId||policy.policyHash!==ctx.policyHash||policy.policyHash!==digest(Object.fromEntries(Object.entries(policy).filter(([k])=>!['policyHash','runId'].includes(k))))))throw new Error('POLICY_HASH_MISMATCH');
    if(plan){if(!policy||!pools||plan.stateDigest!==ctx.stateDigest||plan.planHash!==ctx.candidateHash)throw new Error('PLAN_JOIN_MISMATCH');verifyPlan(plan,policy);
      const mutated=new Map(pools.map(p=>[p.poolId,p]));let outputs=0n;
      for(const [b,branch]of plan.branches.entries()){let amount=branch.allocatedRaw;
        for(const [i,poolId]of branch.poolPath.entries()){const pool=mutated.get(poolId);if(!pool)throw new Error('MISSING_ROUTE_POOL');const q=projectPool(pool,{schemaVersion:'4.0',snapshotDigest:digest(pool),operationId:`integrity:${b}:${i}`,operationClass:'hypothetical',tokenIn:branch.tokenPath[i].assetId,amountIn:amount});if(BigInt(q.unspentInput))throw new Error('UNRECONCILED_INPUT');mutated.set(poolId,q.projectedState);amount=q.amountOut;}
        outputs+=BigInt(amount);
      }if(outputs!==BigInt(plan.outputAfterEmbeddedFeesRaw))throw new Error('OUTPUT_REPLAY_MISMATCH');
    }
    const bridge=object(get('execution-candidate'));
    if(Object.keys(bridge).length){
      const c=object(bridge.candidate),identity=parseStateIdentity(c.identity),raw=object(get('unsigned-payload'));
      const keys=['identity','stateDigest','poolIds','adapterId','adapterRevision','payloadDigest','borrowAmount','profitAsset','minProfit','maxGasCost','expiresAtMs'];
      if(!plan||!policy||!pools||bridge.planHash!==plan.planHash||digest(c)!==ctx.executionCandidateHash||Object.keys(c).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(c,k))||c.stateDigest!==plan.stateDigest||c.borrowAmount!==plan.principalRaw||c.adapterRevision!==ctx.adapterRevision||c.payloadDigest!==digest(raw.bytesHex)||identity.network!==plan.borrowAsset.networkId||identity.height!==pools[0].identity.height||digest(identity)!==digest(pools[0].identity)||c.profitAsset!==`${identity.chain}:${identity.network}:${plan.borrowAsset.assetId}`||uint(c.minProfit)<=uint(policy.minProfitRaw)||!Array.isArray(c.poolIds)||plan.branches.some(b=>b.poolPath.some(p=>!(c.poolIds as unknown[]).includes(p))))throw new Error('EXECUTION_CANDIDATE_MISMATCH');
    }
    if(ledger){verifyLedger(ledger);if(!plan||digest(ledger.asset)!==digest(plan.borrowAsset)||ledger.principalRaw!==plan.principalRaw||ledger.deployedRaw!==(BigInt(plan.principalRaw)-BigInt(plan.unusedPrincipalRaw)).toString()||ledger.unusedPrincipalRaw!==plan.unusedPrincipalRaw||ledger.flashFeeRaw!==plan.flashFeeRaw||ledger.realizedNetRaw.value===null&&(BigInt(ledger.networkCostRaw)+BigInt(ledger.otherExternalCostsRaw)!==plan.costs.filter(c=>!c.includedInSwapOutput).reduce((n,c)=>n+BigInt(c.amountRaw.value!),0n)))throw new Error('LEDGER_PLAN_MISMATCH');if(ledger.runId!==ctx.runId||ledger.realizedNetRaw.value!==null&&evidenceClass!=='RECEIPT')throw new Error('LEDGER_SOURCE_MISMATCH');
      if(ledger.realizedNetRaw.value!==null){
        const r=object(get('receipt')),source=object(r.source),raw=inputs.find(a=>a.kind==='native-receipt'&&object(a.value).contentHash===source.contentHash);if(!raw)throw new Error('RECEIPT_BYTES_MISSING');
        const receipt=object(JSON.parse(Buffer.from(String(object(raw.value).bytesHex).slice(2),'hex').toString('utf8'))),profile=evmProfile(Number(ledger.asset.networkId));
        if(ledger.asset.assetId.toLowerCase()!==profile.wrappedNative||receipt.gasUsed===undefined||receipt.effectiveGasPrice===undefined||receiptNativeCost(Number(ledger.asset.networkId),{gasUsed:BigInt(String(receipt.gasUsed)),effectiveGasPrice:BigInt(String(receipt.effectiveGasPrice))},receipt)!==BigInt(ledger.networkCostRaw)||ledger.realizedNetRaw.value!==ledger.simulatedNetRaw)throw new Error('REALIZED_COST_UNVERIFIED');
      }
      if(proof?.success&&proof.terminalBalanceRaw.value!==null){const terminal=BigInt(proof.terminalBalanceRaw.value)+(proof.terminalBalanceBasis==='after-debt-with-unused'?BigInt(ledger.principalRaw)+BigInt(ledger.flashFeeRaw):0n)-BigInt(ledger.operatorPrefundRaw)-BigInt(ledger.executorOpeningBalanceRaw);if(terminal!==BigInt(ledger.terminalBeforeDebtRaw))throw new Error('LEDGER_NATIVE_BALANCE_MISMATCH');}
    }
    for(const input of inputs.filter(a=>a.kind==='report')){
      const report=input.value as Report;if(report.runId!==ctx.runId||report.policyHash!==ctx.policyHash||report.stateDigest!==ctx.stateDigest)throw new Error('REPORT_JOIN_MISMATCH');
      for(const [field,kind]of [['solverRef','solver'],['simulationRef','native-simulation'],['ledgerRef','ledger']] as const){const ref=report[field];if(ref&&!inputs.some(a=>a.kind===kind&&hashBytes(evidenceBytes(a.value))===ref))throw new Error('REPORT_HASH_MISMATCH');}
      if(report.outcome==='SIMULATED_OPPORTUNITY'&&(!policy||!ledger||!plan||evidenceClass!=='NATIVE_SIM'||!proof?.success||!proof.repaymentProven||BigInt(ledger.simulatedNetRaw)<=BigInt(policy.minProfitRaw)))throw new Error('UNSUPPORTED_POSITIVE_CLAIM');
      if(report.outcome==='SIMULATED_OPPORTUNITY'&&proof&&plan&&policy)verifyNative(proof,plan,{payloadHash:ctx.payloadHash!,executorCodeOrPackageHash:ctx.executorCodeOrPackageHash!,adapterRevision:ctx.adapterRevision!,nowNs:BigInt(ctx.nowNs),maxAgeNs:BigInt(policy.maxStateAgeNs)});
      if(report.outcome==='RECONCILED'&&evidenceClass!=='RECEIPT')throw new Error('RECEIPT_MISSING');
      if(report.outcome==='NO_OPPORTUNITY'){
        const solver=object(get('solver')),search=solver.search as Search,raw=inputs.find(a=>a.kind==='search-domain'&&object(a.value).contentHash===search?.domainEvidenceRef?.contentHash);
        if(!policy||!pools||!raw||solver.stateDigest!==ctx.stateDigest||solver.policyHash!==ctx.policyHash||solver.status!=='CERTIFIED_NO_OPPORTUNITY'||!search.coverageComplete||search.rejected!==0||search.inflight!==0||search.attempted===0||search.attempted!==search.accepted||search.attempted>policy.maxAttempts||search.certificateRef!==null)throw new Error('UNCERTIFIED_NEGATIVE_CLAIM');
        const domain=JSON.parse(Buffer.from(String(object(raw.value).bytesHex).slice(2),'hex').toString('utf8')) as {request:RunRequest;market:CapturedMarket};
        if(digest(domain.market.pools)!==ctx.stateDigest||domain.request.runId!==ctx.runId)throw new Error('SEARCH_DOMAIN_MISMATCH');
        const replay=solvePoolGraph(domain.request,policy,{...domain.market,pools},ctx.stateDigest!,search.domainEvidenceRef);
        if(replay.status!=='CERTIFIED_NO_OPPORTUNITY'||['attempted','accepted','rejected','uniqueAmounts','domainMinimumRaw','domainMaximumRaw','quantumRaw','evaluatedDomainHash'].some(k=>replay.search[k as keyof Search]!==search[k as keyof Search]))throw new Error('SEARCH_REPLAY_MISMATCH');
      }
    }
  }catch{flags.add('ECONOMIC_INVARIANT_FAILED');}
  return [...flags];
}
export function deriveEvidenceClass(inputs:ArtifactInput[],ctx:IntegrityContext,attempts:Awaited<ReturnType<AttemptJournal['latest']>>=[]):EvidenceClass {
  const usable=inputs.filter(a=>!a.reuse&&validInput(a,ctx.runId));
  // Receipts are not inferred from report text or arbitrary files. They require an actual journal identity.
  const bridge=usable.find(a=>a.kind==='execution-candidate');
  const receipt=usable.find(a=>a.kind==='receipt');
  if(receipt){const r=object(receipt.value),source=object(r.source),raw=usable.find(a=>a.kind==='native-receipt'&&object(a.value).contentHash===source.contentHash);let receiptBytes:Record<string,unknown>={};try{receiptBytes=raw?object(JSON.parse(Buffer.from(String(object(raw.value).bytesHex).slice(2),'hex').toString('utf8'))):{};}catch{}const attempt=attempts.find(a=>a.id===ctx.attemptId&&a.state==='reconciled'&&a.candidateDigest===(ctx.executionCandidateHash??ctx.candidateHash)&&a.transactionId===r.transactionId&&a.lane===r.lane);if(raw&&bridge&&object(bridge.value).planHash===ctx.candidateHash&&digest(object(bridge.value).candidate)===ctx.executionCandidateHash&&source.kind==='receipt'&&receiptBytes.transactionHash===r.transactionId&&['success','0x1'].includes(String(receiptBytes.status))&&attempt&&r.runId===ctx.runId&&r.success===true&&r.repaymentProven===true&&r.profitCustodyProven===true)return 'RECEIPT';}
  const rawPayload=usable.find(a=>a.kind==='unsigned-payload');
  const rawNative=usable.find(a=>a.kind==='native-result');
  const native=usable.find(a=>a.kind==='native-simulation')?.value as NativeProof|undefined;
  const plan=usable.find(a=>a.kind==='plan')?.value as Plan|undefined;
  let boundFresh=false;try{const policy=usable.find(a=>a.kind==='policy')?.value as Policy|undefined,state=usable.find(a=>a.kind==='canonical-state')?.value as StateBundle|undefined;if(policy&&state&&plan){for(const ref of [policy.profileRef,policy.valuationEvidenceRef,policy.networkCostEvidenceRef,state.lenderEvidence,...state.poolEvidence,...plan.costs.map(c=>c.evidence)])fresh(ref,BigInt(ctx.nowNs),BigInt(policy.maxStateAgeNs));boundFresh=true;}}catch{}
  if(boundFresh&&native&&plan&&object(rawPayload?.value).contentHash===ctx.payloadHash&&object(rawNative?.value).contentHash===native.resultEvidence.contentHash&&native.fidelity==='existing-native'&&!native.overrideRefs.length&&native.candidateHash===ctx.candidateHash&&plan.planHash===ctx.candidateHash&&native.stateDigest===ctx.stateDigest&&native.policyHash===ctx.policyHash&&native.executionContextHash===ctx.executionContextHash&&native.payloadHash===ctx.payloadHash&&plan.unsignedPayloadRef?.contentHash===ctx.payloadHash&&native.executorCodeOrPackageHash===ctx.executorCodeOrPackageHash&&native.adapterRevision===ctx.adapterRevision&&native.resultEvidence.kind==='native-simulation'&&BigInt(native.resultEvidence.observedAtNs)<=BigInt(ctx.nowNs)&&native.resultEvidence.expiresAtNs!==null&&BigInt(ctx.nowNs)<BigInt(native.resultEvidence.expiresAtNs))return 'NATIVE_SIM';
  return canonicalPools(usable,ctx)?'SNAPSHOT_MODEL':'PARAMETRIC';
}
function economicValue(inputs:ArtifactInput[]):string|null {
  const ledger=object(inputs.find(a=>a.kind==='ledger')?.value);
  if(typeof ledger.simulatedNetRaw==='string')return `ledger:${ledger.simulatedNetRaw}`;
  const plan=object(inputs.find(a=>a.kind==='plan')?.value),net=object(plan.netProfitRaw);
  if(typeof net.value==='string')return `plan:${net.value}`;
  return null;
}
export function inspectRound(inputs:ArtifactInput[],ctx:IntegrityContext,previous?:RoundManifest,attempts:Awaited<ReturnType<AttemptJournal['latest']>>=[]):Integrity {
  const flags=new Set<string>(),artifacts:Artifact[]=[];
  for(const kind of ['policy','plan','ledger','native-simulation','receipt','execution-candidate','canonical-state','solver','report'])if(inputs.filter(a=>a.kind===kind).length>1)flags.add('SCHEMA_INVALID_ARTIFACT');
  if(!inputs.length)throw new Error('EMPTY_ARTIFACT_SET');
  for(const a of inputs){
    let bytes:Buffer;try{bytes=a.rawBytesHex!==undefined?Buffer.from(a.rawBytesHex,'hex'):evidenceBytes(a.value);}catch{bytes=Buffer.alloc(0);}
    const hash=hashBytes(bytes),valid=a.rawBytesHex===undefined&&validInput(a,ctx.runId);let parse:Artifact['parse']=!bytes.length?'empty':valid?'ok':'schema-invalid';if(bytes.length&&a.rawBytesHex!==undefined)try{JSON.parse(bytes.toString('utf8'));}catch{parse='invalid-json';}
    if(!bytes.length)flags.add('EMPTY_ARTIFACT');else if(!valid)flags.add('SCHEMA_INVALID_ARTIFACT');if(parse==='invalid-json')flags.add('INVALID_JSON');
    if(a.reuse&&(!previous||a.reuse.runId!==previous.context.runId||!previous.artifacts.some(p=>p.hash===a.reuse!.hash&&p.kind===a.kind)||a.reuse.hash!==hash))flags.add('UNDECLARED_REUSE');
    if(previous?.artifacts.some(p=>p.kind===a.kind&&p.hash===hash)&&!a.reuse)flags.add('UNDECLARED_REUSE');
    artifacts.push({path:`objects/${hash}.json`,kind:a.kind,sha256:hash,bytes:bytes.length,parse,declaredReuse:!!a.reuse,reusedFrom:a.reuse?{runId:a.reuse.runId,path:`objects/${a.reuse.hash}.json`}:null});
  }
  const evidenceClass=deriveEvidenceClass(inputs,ctx,attempts),current=economicValue(inputs),before=previous?economicValue(previous.artifacts):null;
  const changed=previous?ctx.stateDigest!==previous.context.stateDigest:null;
  const comparable=changed===true&&current!==null&&before!==null;
  const unchanged=comparable&&current===before;
  if(unchanged)flags.add(evidenceClass==='PARAMETRIC'?'PARAMETRIC_SUSPECT':'VALUE_UNCHANGED_ACROSS_STATES');
  const rank:Record<EvidenceClass,number>={PARAMETRIC:0,SNAPSHOT_MODEL:1,NATIVE_SIM:2,RECEIPT:3};
  for(const a of inputs){const r=object(a.value),claimed=r.evidenceClass;if(typeof claimed==='string'&&rank[claimed as EvidenceClass]>rank[evidenceClass])flags.add('SELF_DECLARED_CLASS_MISMATCH');if(a.kind==='report'&&r.simulationRef&&!inputs.some(p=>p.kind==='native-simulation'))flags.add('MISSING_NATIVE_PAYLOAD');}
  for(const flag of semanticFlags(inputs,ctx,evidenceClass))flags.add(flag);
  const blocking=[...flags].some(f=>f!=='VALUE_UNCHANGED_ACROSS_STATES');
  return validateRecord<Integrity>('ArtifactIntegrity',{schemaVersion:'5.1',recordType:'artifact-integrity',runId:ctx.runId,roundId:ctx.roundId,artifacts,stateInvariance:{comparedRunId:previous?.context.runId??null,stateDigestChanged:changed,economicResultChanged:comparable?current!==before:null,verdict:unchanged&&evidenceClass==='PARAMETRIC'?'PARAMETRIC_SUSPECT':comparable?'STATE_DEPENDENT':'NOT_COMPARABLE'},evidenceClass,flags:[...flags],verdict:blocking?'BLOCK':'PASS'});
}
function pointer(value:unknown,path:string):unknown {
  return path.slice(1).split('/').reduce<unknown>((v,k)=>object(v)[k.replace(/~1/g,'/').replace(/~0/g,'~')],value);
}
export function evaluateLessonChecks(checks:LessonCheck[],inputs:ArtifactInput[],integrity:Integrity,previous?:RoundManifest,recalled:RecalledLesson[]=[],approvedOwnerRefs:ReadonlySet<string>=new Set()):RecallApplication {
  const results:RecallApplication['results']=[];
  for(const check of checks){
    validateRecord('LessonCheck',check);
    if(check.runId!==integrity.runId)throw new Error('LESSON_RUN_MISMATCH');
    if(check.severity==='BLOCK'&&(!check.ownerApprovalRef||!approvedOwnerRefs.has(check.ownerApprovalRef)))throw new Error('LESSON_OWNER_APPROVAL_UNVERIFIED');
    let bad=false,applicable=true;const p=check.predicate;
    if(p.kind==='NONEMPTY_ARTIFACTS')bad=integrity.artifacts.some(a=>a.bytes===0);
    else if(p.kind==='PRINCIPAL_CONSERVED'){const l=object(inputs.find(a=>a.kind==='ledger')?.value);applicable=!!l.principalRaw;bad=applicable&&BigInt(String(l.principalRaw))!==BigInt(String(l.deployedRaw))+BigInt(String(l.unusedPrincipalRaw));}
    else if(p.kind==='RESULT_MUST_CHANGE_WITH_STATE'){applicable=!!previous&&integrity.stateInvariance.stateDigestChanged===true;const now=pointer(Object.fromEntries(inputs.map(a=>[a.kind,a.value])),p.resultPointer),prior=previous?pointer(Object.fromEntries(previous.artifacts.map(a=>[a.kind,a.value])),p.resultPointer):null;bad=applicable&&typeof now==='string'&&now===prior&&integrity.evidenceClass==='PARAMETRIC';}
    else if(p.kind==='HASH_DIFFERS_FROM_PREVIOUS_ROUND')bad=integrity.flags.includes('UNDECLARED_REUSE')&&inputs.some(a=>a.kind===p.artifactKind);
    else if(p.kind==='REQUIRES_EVIDENCE_KIND'){applicable=integrity.evidenceClass===p.when;bad=applicable&&!integrity.artifacts.some(a=>a.kind===p.evidenceKind&&a.parse==='ok');}
    else if(p.kind==='FORBID_POLICY_VALUE'){const policy=object(inputs.find(a=>a.kind==='policy')?.value);applicable=Object.hasOwn(policy,p.field);bad=applicable&&p.forbidden.some(v=>JSON.stringify(v)===JSON.stringify(policy[p.field]));}
    results.push({checkId:check.checkId,artifactPath:'round',result:!applicable?'NOT_APPLICABLE':bad?'VIOLATION':'PASS',severity:check.severity,detail:!applicable?'NO_COMPARABLE_INPUT':bad?p.kind:'CHECK_SATISFIED'});
  }
  return {schemaVersion:'5.1',recordType:'recall-application',runId:integrity.runId,mappingHash:digest(checks.map(({runId,...c})=>c)),memorySequence:0,recalled:recalled.map(l=>({...l,checkIds:checks.filter(c=>c.lessonId===l.lessonId&&c.lessonVersionHash===l.versionHash).map(c=>c.checkId)})),results,uncheckedLessons:recalled.filter(l=>!checks.some(c=>c.lessonId===l.lessonId&&c.lessonVersionHash===l.versionHash)).map(l=>l.lessonId),blocked:results.some(r=>r.result==='VIOLATION'&&r.severity==='BLOCK')};
}
/** Only serializer-produced bytes enter custody. References are hashes, never arbitrary read paths. */
export async function writeEvidence(path:string,value:unknown):Promise<string>{
  const bytes=evidenceBytes(value);await mkdir(join(path,'..'),{recursive:true});
  const temporary=`${path}.${randomUUID()}.tmp`,file=await open(temporary,'wx',0o600);
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
  await rename(temporary,path);return hashBytes(bytes);
}
function roundComponent(id:string):string{if(typeof id!=='string'||!id||id==='.'||id==='..'||id.length>512)throw new Error('INVALID_ROUND_ID');return encodeURIComponent(id);}
export async function readBoundedEvidenceFile(path:string,max:number):Promise<Buffer>{const stat=await lstat(path);if(!stat.isFile()||stat.size>max)throw new Error('INVALID_ARTIFACT_FILE');const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(!(await file.stat()).isFile())throw new Error('INVALID_ARTIFACT_FILE');const b=Buffer.alloc(max+1);let used=0;while(used<b.length){const next=await file.read(b,used,b.length-used,null);if(!next.bytesRead)break;used+=next.bytesRead;}if(used>max)throw new Error('ARTIFACT_BYTES_LIMIT');return b.subarray(0,used);}finally{await file.close();}}
export class ArtifactStore {
  constructor(readonly root:string){}
  async load(roundId:string):Promise<RoundManifest>{
    const file=join(this.root,'rounds',roundComponent(roundId),'manifest.json');if(!(await lstat(file)).isFile())throw new Error('INVALID_MANIFEST');
    const m=JSON.parse((await readBoundedEvidenceFile(file,16*1024*1024)).toString('utf8')) as RoundManifest;
    if(!m||m.hashing?.content!=='sha256-canonical-json/v1'||m.schemaVersion!=='5.1'||!Array.isArray(m.artifacts)||m.artifacts.length>512||m.context?.runId!==roundId)throw new Error('INVALID_MANIFEST');let totalBytes=0;
    for(const a of m.artifacts){if(!/^[a-f0-9]{64}$/.test(a.hash))throw new Error('INVALID_ARTIFACT_HASH');const target=join(this.root,'objects',`${a.hash}.json`);if(!(await lstat(target)).isFile())throw new Error('INVALID_ARTIFACT');const b=await readBoundedEvidenceFile(target,4*1024*1024);totalBytes+=b.length;if(totalBytes>16*1024*1024)throw new Error('ARTIFACT_BYTES_LIMIT');if(hashBytes(b)!==a.hash||!b.equals(evidenceBytes(a.value)))throw new Error('ARTIFACT_HASH_MISMATCH');}
    return m;
  }
  async publish(inputs:ArtifactInput[],ctx:IntegrityContext,options:{previous?:RoundManifest;checks?:LessonCheck[];recalled?:RecalledLesson[];journal?:AttemptJournal;amendmentOf?:string;approvedOwnerRefs?:ReadonlySet<string>}={}):Promise<RoundManifest>{
    if(inputs.length>512)throw new Error('ARTIFACT_COUNT_LIMIT');
    const frozen=structuredClone(inputs),integrity=inspectRound(frozen,ctx,options.previous,await options.journal?.latest()??[]);
    const recall=evaluateLessonChecks(options.checks??[],frozen,integrity,options.previous,options.recalled,options.approvedOwnerRefs);
    const manifest:RoundManifest={schemaVersion:'5.1',context:ctx,artifacts:[],integrity,recall,hashing:{content:'sha256-canonical-json/v1',plan:'sha256-canonical-json-omit-planHash/v1',policy:'sha256-canonical-json-omit-policyHash-runId/v1',payload:'sha256-exact-bytes/v1'}};
    if(integrity.verdict==='BLOCK'||recall.blocked){await writeEvidence(join(this.root,'rejections',`${roundComponent(ctx.runId)}-${randomUUID()}.json`),{integrity,recall});return {...manifest,artifacts:[]};}
    let totalBytes=0;manifest.artifacts=frozen.map(a=>{const b=evidenceBytes(a.value);totalBytes+=b.length;if(b.length>4*1024*1024||totalBytes>16*1024*1024)throw new Error('ARTIFACT_BYTES_LIMIT');return {...a,hash:hashBytes(b)};});
    const dir=join(this.root,'rounds',roundComponent(ctx.runId));
    await mkdir(join(this.root,'locks'),{recursive:true});
    await new ExecutionLock(join(this.root,'locks',`${roundComponent(ctx.runId)}.lock`)).runExclusive(async()=>{
      let prior:Buffer|undefined;try{prior=await readBoundedEvidenceFile(join(dir,'manifest.json'),16*1024*1024);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      if(prior){if(!options.amendmentOf||hashBytes(prior)!==options.amendmentOf)throw new Error('ROUND_ALREADY_PUBLISHED');manifest.previousManifestHash=options.amendmentOf;}
      else if(options.amendmentOf)throw new Error('AMENDMENT_PARENT_MISSING');
      await mkdir(join(dir,'versions'),{recursive:true});
      for(const a of manifest.artifacts){const target=join(this.root,'objects',`${a.hash}.json`);try{if(!(await lstat(target)).isFile()||!(await readBoundedEvidenceFile(target,4*1024*1024)).equals(evidenceBytes(a.value)))throw new Error('ARTIFACT_COLLISION');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await writeEvidence(target,a.value);}}
      for(const audit of [integrity,recall])await writeEvidence(join(this.root,'objects',`${hashBytes(evidenceBytes(audit))}.json`),audit);
      if(prior)await writeEvidence(join(dir,'versions',`${hashBytes(prior)}.json`),JSON.parse(prior.toString('utf8')));
      await writeEvidence(join(dir,'manifest.json'),manifest);
    });
    return manifest;
  }
}
export async function checkRoundIntegrity(store:ArtifactStore,runId:string,previousId?:string):Promise<Integrity>{const round=await store.load(runId),previous=previousId?await store.load(previousId):undefined;return inspectRound(round.artifacts,round.context,previous);}

/** Historical bytes remain historical. Unknown legacy wire records are never relabeled as v5 proof. */
export async function loadRawArtifact(path:string):Promise<ArtifactInput>{
  const stat=await lstat(path);if(!stat.isFile()||stat.size>4*1024*1024)throw new Error('INVALID_ARTIFACT_FILE');
  const bytes=await readFile(path);let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{return {kind:'legacy-unparsed',definition:bytes.length?'invalid-json':'empty',value:null,rawBytesHex:bytes.toString('hex')};}
  const r=object(value);const lookup:Record<string,[string,string]>={'round-report':['report','Report'],'state-bundle':['canonical-state','StateBundle'],'route-plan':['plan','Plan'],'cashflow-ledger':['ledger','Ledger'],'native-simulation-proof':['native-simulation','NativeProof'],'pool-inventory':['discovery','Inventory']};
  const [kind,definition]=lookup[String(r.recordType)]??['legacy-unparsed','unknown'];return {kind,definition,value,rawBytesHex:bytes.toString('hex')};
}
