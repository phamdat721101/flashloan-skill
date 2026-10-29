import {digest,uint} from '../liquidity/state.js';
import {sameAsset,validateRecord,type Asset,type EvidenceRef,type Identity,type RunRequest,type Plan,type Report} from './contracts.js';
import {runEvidence,type EvidenceHost,type EvidenceOptions,type CapturedMarket} from './runtime.js';
import {verifyFundingMarket,type ApprovedProfile} from './economics.js';
import type {RoundManifest} from './integrity.js';
import {mergeLocalOutcomes,validateCandidateLedger,readMovers,fromRouteStats,type CandidateLedger,type LocalCandidate,type EvaluatedRoute} from './candidate-ledger.js';
export interface FundingOption {
  optionId:string;lenderId:string;lenderAddress:string;callbackMode:string;asset:Asset;repaymentAsset:Asset;
  identity:Identity;capacityRaw:string;feeNumerator:string;feeDenominator:string;
  evidence:EvidenceRef;executorCapabilityRef:EvidenceRef;
}
export interface GapRunRequest {
  schemaVersion:'5.2';recordType:'gap-run-request';runId:string;request:RunRequest;
  allowedAssets:Asset[];allowedLenderIds:string[];principalCapsRaw:Record<string,string>;
  maxFundingOptions:number;maxAttemptsTotal:number;deadlineMs:number;
}
export interface GapHost extends EvidenceHost {
  compileFunding?:(option:FundingOption,...args:Parameters<NonNullable<EvidenceHost['compile']>>)=>ReturnType<NonNullable<EvidenceHost['compile']>>;
  simulateFunding?:(option:FundingOption,...args:Parameters<NonNullable<EvidenceHost['simulate']>>)=>ReturnType<NonNullable<EvidenceHost['simulate']>>;
  funding(request:GapRunRequest,signal:AbortSignal):Promise<FundingOption[]>;
  captureFunding(request:RunRequest,option:FundingOption,signal:AbortSignal):Promise<{market:CapturedMarket;profile:ApprovedProfile}>;
}
export interface GapRound {
  runId:string;status:'CANDIDATE_FOUND'|'INCONCLUSIVE'|'CERTIFIED_NO_OPPORTUNITY';selectedOptionId:string|null;
  attempts:Array<{optionId:string;runId:string;status:string;attempted:number;netUsd:{numerator:string;denominator:string}|null;error:string|null}>;
  rounds:RoundManifest[];omittedOptions:number;
}
/** Explicit host capture per option. Never signs or loads a request-selected host module. */
export async function runGapEvidence(raw:unknown,options:EvidenceOptions&{host:GapHost}):Promise<GapRound>{
  const r=validateRecord<GapRunRequest>('GapRunRequest',raw,'5.2');
  if(r.request.schemaVersion!=='5.2'||r.request.runId!==r.runId||!r.allowedAssets.length||!r.allowedLenderIds.length)throw new Error('INPUT_BLOCKED');
  const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  if(!Number.isSafeInteger(options.maxDurationMs)||options.maxDurationMs<1||options.maxDurationMs>3600000)throw new Error('INVALID_RUN_DEADLINE');
  const duration=Math.min(options.maxDurationMs,r.deadlineMs);
  const deadline=performance.now()+duration,timer=setTimeout(abort,duration),now=options.nowNs??(()=>BigInt(Date.now())*1000000n);
  const bounded=async<T>(fn:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    let stop:()=>void=()=>{};try{return await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw new Error('GAP_CANCELLED');return fn(controller.signal);}),new Promise<never>((_,reject)=>{stop=()=>reject(new Error('GAP_CANCELLED'));controller.signal.addEventListener('abort',stop,{once:true});if(controller.signal.aborted)stop();})]);}finally{controller.signal.removeEventListener('abort',stop);}
  };
  const result:GapRound={runId:r.runId,status:'INCONCLUSIVE',selectedOptionId:null,attempts:[],rounds:[],omittedOptions:0};
  try{
    const discovered=await bounded(s=>options.host.funding(r,s));if(!Array.isArray(discovered)||discovered.length>256)throw new Error('FUNDING_OPTION_LIMIT');
    const valid=discovered.map(o=>validateRecord<FundingOption>('FundingOption',o,'5.2'));
    if(new Set(valid.map(o=>o.optionId)).size!==valid.length)throw new Error('DUPLICATE_FUNDING_OPTION');
    const eligible=valid.filter(o=>r.allowedAssets.some(a=>sameAsset(a,o.asset)&&a.decimals===o.asset.decimals)&&r.allowedLenderIds.includes(o.lenderId)).sort((a,b)=>a.optionId.localeCompare(b.optionId));
    const selected=eligible.slice(0,Math.min(r.maxFundingOptions,r.maxAttemptsTotal));result.omittedOptions=eligible.length-selected.length;
    const quota=Math.floor(r.maxAttemptsTotal/Math.max(1,selected.length));
    let best:{n:bigint;d:bigint;exposureN:bigint;exposureD:bigint;id:string}|undefined;
    let identity:string|undefined;
    for(const [optionIndex,option] of selected.entries()){
      if(controller.signal.aborted||performance.now()>=deadline)break;
      const row:GapRound['attempts'][number]={optionId:option.optionId,runId:`${r.runId}-${digest(option.optionId).slice(0,16)}`,status:'INCONCLUSIVE',attempted:0,netUsd:null,error:null};result.attempts.push(row);
      const optionController=new AbortController(),cancelOption=()=>optionController.abort();controller.signal.addEventListener('abort',cancelOption,{once:true});
      const slice=Math.max(1,Math.floor((deadline-performance.now())/(selected.length-optionIndex))),optionTimer=setTimeout(cancelOption,slice),optionDeadline=performance.now()+slice;
      try{
        if(!sameAsset(option.asset,option.repaymentAsset)||option.asset.decimals!==option.repaymentAsset.decimals||option.asset.networkId!==r.request.networkId||option.identity.networkId!==r.request.networkId||option.identity.namespace!==option.asset.namespace||option.identity.finality==='provisional'||!uint(option.capacityRaw)||!uint(option.feeDenominator))throw new Error('FUNDING_EVIDENCE_MISMATCH');
        const {decimals,...locator}=option.asset;
        const base={...r.request,runId:row.runId,borrowAsset:locator};
        const captured=await bounded(async()=>{let stop:()=>void=()=>{};try{return await Promise.race([options.host.captureFunding(base,option,optionController.signal),new Promise<never>((_,reject)=>{stop=()=>reject(new Error('FUNDING_OPTION_DEADLINE'));optionController.signal.addEventListener('abort',stop,{once:true});if(optionController.signal.aborted)stop();})]);}finally{optionController.signal.removeEventListener('abort',stop);}});
        const {market:capturedMarket,profile}=captured;
        const market={...capturedMarket,fundingOption:option};
        verifyFundingMarket(option,market,now(),uint(profile.body.maxStateAgeNs));
        if(identity&&identity!==digest(market.identity))throw new Error('INCOHERENT_FUNDING_STATE');identity=digest(market.identity);
        const optionCap=r.principalCapsRaw[option.optionId];if(!optionCap||!uint(optionCap)||!r.request.principalCapRaw)throw new Error('MISSING_FUNDING_CAP');
        if(!r.request.riskProfileRef||digest(r.request.riskProfileRef)!==digest(profile.ref))throw new Error('FUNDING_PROFILE_MISMATCH');
        const cap=(uint(optionCap)<uint(r.request.principalCapRaw)?uint(optionCap):uint(r.request.principalCapRaw)).toString();
        // Derive the attempt budget without changing owner approval of the captured profile.
        const request:RunRequest={...base,principalCapRaw:cap,riskProfileRef:profile.ref,networkCostEvidenceRef:market.networkCost.evidence,valuationEvidenceRef:market.valuation.ref,fundingOptionRef:{...option.evidence,contentHash:digest(option)}};
        const source=options.host;
        const host:EvidenceHost={profile:async()=>profile,capture:async()=>structuredClone(market),inventory:source.inventory.bind(source),...(source.compileFunding?{compile:(...args)=>source.compileFunding!(option,...args)}:{}),...(source.simulateFunding?{simulate:(...args)=>source.simulateFunding!(option,...args)}:{}),...(source.readiness?{readiness:source.readiness.bind(source)}:{}),...(source.memory?{memory:source.memory.bind(source)}:{})};
        const round=await runEvidence(request,{...options,host,previous:undefined,signal:optionController.signal,maxDurationMs:Math.max(1,Math.floor(optionDeadline-performance.now())),solveBudget:quota});
        result.rounds.push(round);
        const report=round.artifacts.find(a=>a.kind==='report')?.value as Report|undefined;
        const plan=round.artifacts.find(a=>a.kind==='plan')?.value as Plan|undefined;
        const search=round.artifacts.find(a=>a.kind==='solver')?.value as {search?:{attempted:number;coverageComplete:boolean}}|undefined;
        row.attempted=search?.search?.attempted??0;row.status=report?.outcome??'INCONCLUSIVE';
        if(round.integrity.verdict==='BLOCK'||round.recall.blocked){row.status='EVIDENCE_BLOCKED';continue;}
        if(!plan||plan.netProfitRaw.value===null)continue;
        const n=BigInt(plan.netProfitRaw.value)*BigInt(market.valuation.price.numerator),d=10n**BigInt(market.asset.decimals)*BigInt(market.valuation.price.denominator);
        row.netUsd={numerator:n.toString(),denominator:d.toString()};
        const exposureN=uint(plan.principalRaw)*BigInt(market.valuation.price.numerator);
        if(!best||n*best.d>best.n*d||n*best.d===best.n*d&&(exposureN*best.exposureD<best.exposureN*d||exposureN*best.exposureD===best.exposureN*d&&option.optionId<best.id)){best={n,d,exposureN,exposureD:d,id:option.optionId};result.selectedOptionId=option.optionId;}
      }catch(e){row.status='INCONCLUSIVE';row.error=e instanceof Error?e.message:'TOOL_ERROR';}finally{clearTimeout(optionTimer);optionController.abort();controller.signal.removeEventListener('abort',cancelOption);}
    }
    result.status=result.selectedOptionId?'CANDIDATE_FOUND':result.omittedOptions===0&&selected.length>0&&result.attempts.length===selected.length&&result.attempts.every(a=>a.status==='NO_OPPORTUNITY')?'CERTIFIED_NO_OPPORTUNITY':'INCONCLUSIVE';
    return result;
  }finally{clearTimeout(timer);controller.abort();options.signal?.removeEventListener('abort',abort);}
}
export interface FlashRunRequest {
  schema:'flash-run-request/1';round_id:string;network:string;mode:'research'|'simulate'|'execute';
  selection:{movers:boolean;explicit_assets:string[];anchor_assets:Array<{asset_id:string;role:'funding'|'settlement'}>;min_reported_liquidity_usd:string;max_candidates:number};
  policy_ref:{id:string;version:string;hash:string}|null;limits:{max_rpc_calls:number;max_evaluations:number;deadline_ms:number};
  snapshot_ref:string|null;execution_authorization_ref:null;
}
/**
 * Maps flash-run-request/1 onto the existing 5.2 RunRequest (v6 §3.1). It adds no policy path: the
 * principal cap comes from the approved profile and `compilePolicy` remains the only resolver.
 * `execute` requests unsigned simulation only; authority is never derived from a request.
 */
export function toRunRequest(raw:unknown,profile:ApprovedProfile,refs:{valuation:EvidenceRef;networkCost:EvidenceRef}):RunRequest{
  const req=validateRecord<FlashRunRequest>('FlashRunRequest',raw,'v6');
  if(!req.policy_ref||req.policy_ref.hash!==`sha256:${digest(profile.body)}`||profile.ref.contentHash!==digest(profile.body))throw new Error('INPUT_BLOCKED');
  const funding=req.selection.anchor_assets.find(a=>a.role==='funding');if(!funding)throw new Error('INPUT_BLOCKED');
  const networkId=req.network.split(':')[1],locator=(id:string)=>{const [chain,asset]=id.split('/');if(chain!==req.network)throw new Error('INPUT_BLOCKED');return {namespace:'eip155' as const,networkId,assetId:asset.split(':')[1]};};
  const assets=[...new Map([...req.selection.anchor_assets.map(a=>a.asset_id),...req.selection.explicit_assets].map(id=>[id,locator(id)])).values()];
  return validateRecord<RunRequest>('RunRequest',{schemaVersion:'5.2',recordType:'run-request',runId:req.round_id,mode:req.mode==='research'?'research':'unsigned-simulation',networkId,
    assetLocators:assets,borrowAsset:locator(funding.asset_id),riskProfileRef:profile.ref,principalCapRaw:profile.body.principalCapRaw,requestedMinProfitUsd:null,requestedPriceImpactBps:null,
    networkCostEvidenceRef:refs.networkCost,valuationEvidenceRef:refs.valuation,watchDurationMs:0,caller:null,executor:null,executorMode:'existing',rotationMode:'report-only',
    requestedMinDeploymentBps:null,requestedMinBranchWeightBps:null,requestedMinPrincipalUsd:null,requestedMinBranchUsd:null,inventoryMinLiquidityUsd:null},'5.2');
}
export interface FlashloanVersions {schema:'flashloan-versions/1';prompt:{id:string;sha256:string};runtime:'5.2';schemas:Record<string,string>;mcp:{public_schema:string;inventory:string[];movers:string[];envelope_version:number;required_operations:string[]}}
/** Fails closed (v6 §3.5) on any observed mismatch. MCP fields are checked only when that surface was observed. */
export function checkCapabilities(raw:unknown,observed:{promptSha256:string;publicSchema?:string;inventory?:string;movers?:string;envelopeVersion?:number;operations?:string[]}):FlashloanVersions{
  const v=validateRecord<FlashloanVersions>('FlashloanVersions',raw,'v6'),m=v.mcp;
  if(v.prompt.sha256!==observed.promptSha256||observed.publicSchema!==undefined&&m.public_schema!==observed.publicSchema||observed.inventory!==undefined&&!m.inventory.includes(observed.inventory)||observed.movers!==undefined&&!m.movers.includes(observed.movers)||observed.envelopeVersion!==undefined&&m.envelope_version!==observed.envelopeVersion||observed.operations!==undefined&&m.required_operations.some(o=>!observed.operations!.includes(o)))throw new Error('CAPABILITY_UNSUPPORTED');
  return v;
}

export interface FlashRound {gap:GapRound;ledger:CandidateLedger;versions:FlashloanVersions;request:RunRequest}
/**
 * v6 round over the existing 5.2 funding runtime. Maps flash-run-request/1 through `toRunRequest`, runs
 * `runGapEvidence` unchanged, then builds and strictly validates candidate-ledger/1 from movers, explicit
 * assets, captured pool tokens and per-route evaluation counts. Research and unsigned simulation only.
 */
export async function runFlashRound(raw:unknown,options:EvidenceOptions&{host:GapHost;fundingOptions:FundingOption[];profile:ApprovedProfile;
  refs:{valuation:EvidenceRef;networkCost:EvidenceRef};versions:unknown;promptSha256:string;movers?:unknown}):Promise<FlashRound>{
  const request=toRunRequest(raw,options.profile,options.refs),v6=validateRecord<FlashRunRequest>('FlashRunRequest',raw,'v6'),chainId=Number(request.networkId);
  const movers=v6.selection.movers&&options.movers!==undefined?readMovers(options.movers,chainId):null;
  const versions=checkCapabilities(options.versions,{promptSha256:options.promptSha256,...(movers?{movers:movers.schema}:{})});
  const funding=v6.selection.anchor_assets.filter(a=>a.role==='funding').map(a=>a.asset_id.split(':').at(-1)!);
  const options5=options.fundingOptions.filter(o=>funding.includes(o.asset.assetId.toLowerCase()));
  if(!options5.length)throw new Error('INPUT_BLOCKED');
  const gapRequest:GapRunRequest={schemaVersion:'5.2',recordType:'gap-run-request',runId:request.runId,request,
    allowedAssets:[...new Map(options5.map(o=>[digest(o.asset),o.asset])).values()],allowedLenderIds:[...new Set(options5.map(o=>o.lenderId))],
    principalCapsRaw:Object.fromEntries(options5.map(o=>[o.optionId,options.profile.body.principalCapRaw])),
    maxFundingOptions:Math.min(options5.length,256),maxAttemptsTotal:v6.limits.max_evaluations,deadlineMs:v6.limits.deadline_ms};
  const byRoute=new Map<string,EvaluatedRoute>(),captured=new Set<string>();
  const addRoutes=(list:EvaluatedRoute[])=>{for(const r of list){const prior=byRoute.get(r.id);byRoute.set(r.id,prior?{...prior,evaluations:prior.evaluations+r.evaluations}:r);}};
  const gap=await runGapEvidence(gapRequest,{...options,onRouteStats:(stats,tokens)=>{addRoutes(fromRouteStats(stats));for(const t of tokens)captured.add(t.toLowerCase());options.onRouteStats?.(stats,tokens);}});
  const routes=[...byRoute.values()],asOf=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
  const explicit:LocalCandidate[]=v6.selection.explicit_assets.map(asset_id=>({asset_id,role:'target',sources:['explicit'],first_seen:asOf}));
  const evidence=[{kind:'gap-round',content_hash:`sha256:${digest(gap.attempts)}`,captured_at:asOf,trace_id:request.runId}];
  const ledger=mergeLocalOutcomes({roundId:v6.round_id,chainId:v6.network,asOf:movers?.asOf??asOf,coverage:movers?movers.coverage:v6.selection.movers?'EMPTY_PROVIDER':'BOUNDED',
    providers:movers?['dexscreener']:[],sourceRefs:movers?[{kind:'movers',content_hash:`sha256:${digest(options.movers)}`,captured_at:movers.asOf,trace_id:request.runId}]:[],
    candidates:[...(movers?.candidates??[]),...explicit],maxCandidates:v6.selection.max_candidates,inventoryOutcomes:{},routes,evidence,capturedTokens:[...captured]});
  return {gap,ledger:validateCandidateLedger(ledger,routes,v6.selection.explicit_assets),versions,request};
}
