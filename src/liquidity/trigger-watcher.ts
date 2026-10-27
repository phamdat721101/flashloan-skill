import { digest } from './state.js';
import { evidenceIdentity, EntryBandCache, type BandInputs } from './entry-band.js';
import type { PoolStateEnvelope } from './projection.js';
import { validateRecord, type Identity, type Policy, type NativeProof } from '../evidence/contracts.js';
import type { RoundManifest } from '../evidence/integrity.js';
export interface TriggerSwap {transactionId:string;logIndex:number;poolId:string;direction:'sell-base'|'buy-base';amountInRaw:string;observedAtNs:string;inclusionToObservationMs:number|null}
export interface TriggerBlock {state:Identity;parentHash:string;pools:PoolStateEnvelope[];swaps:TriggerSwap[];invalidated?:boolean;sourceFailure?:string;liquidityEvents?:string[]}
export interface TriggerObservation extends TriggerSwap {schemaVersion:'5.1';recordType:'trigger-observation';runId:string;state:Identity;bandRef:string|null;sMinRaw:string|null;decision:'QUEUED'|'SOLVE'|'DEFERRED_BELOW_SMIN'|'DEFERRED_NO_BAND'|'STALE_BAND'|'REORGED'|'OUTSIDE_WATCH';solverRunId:string|null;reason:string|null}
export interface WatchEvaluation {manifest:RoundManifest;state:Identity;producedAtHeight:string;solveMs:number;simulationMs:number}
export interface TriggerSurvival {schemaVersion:'5.1';recordType:'trigger-survival';runId:string;triggerRef:string;triggerState:Identity;headState:Identity|null;triggerProofRef:string|null;headProofRef:string|null;observationLatencyMs:number|null;queueMs:number;solveMs:number;simulationMs:number;result:'SURVIVED'|'CLOSED'|'UNKNOWN';reason:string}
export interface WatchHost {
  blocks(signal:AbortSignal):AsyncIterable<TriggerBlock>;
  canonical?(state:Identity,signal:AbortSignal):Promise<boolean>;
  current(signal:AbortSignal):Promise<TriggerBlock>;
  evaluate(block:TriggerBlock,observation:TriggerObservation,signal:AbortSignal):Promise<WatchEvaluation>;
  persist(record:TriggerObservation|TriggerSurvival,signal:AbortSignal):Promise<void>;
  bandInputs?(block:TriggerBlock,signal:AbortSignal):Promise<BandInputs|null>;
}
export interface WatchOptions {runId:string;policy:Policy;maxDurationMs:number;maxObservations:number;signal?:AbortSignal}
interface Job {block:TriggerBlock;observation:TriggerObservation;priority:number;enqueued:number;bytes:number}
function proofOutcome(e:WatchEvaluation):{positive:boolean|null;proof:string|null}{
  const m=e.manifest,report=m.artifacts.find(a=>a.kind==='report')?.value as {outcome?:string;simulationRef?:string|null;solverRef?:string|null}|undefined;
  if(m.integrity.verdict==='BLOCK'||m.recall.blocked)return {positive:null,proof:null};
  const state=m.artifacts.find(a=>a.kind==='canonical-state')?.value as {identity?:Identity;stateDigest?:string}|undefined;
  if(!state||digest(state.identity)!==digest(e.state)||state.stateDigest!==m.context.stateDigest)return {positive:null,proof:null};
  if(report?.outcome==='SIMULATED_OPPORTUNITY'&&m.integrity.evidenceClass==='NATIVE_SIM'){
    const proof=m.artifacts.find(a=>a.kind==='native-simulation')?.value as NativeProof|undefined;
    if(proof?.success&&proof.repaymentProven)return {positive:true,proof:report.simulationRef??null};
  }
  const solver=m.artifacts.find(a=>a.kind==='solver')?.value as {status?:string;search?:{optimality?:string;coverageComplete?:boolean;rejected?:number;inflight?:number}}|undefined;
  if(report?.outcome==='NO_OPPORTUNITY'&&solver?.status==='CERTIFIED_NO_OPPORTUNITY'&&solver.search?.optimality==='domain-certified'&&solver.search.coverageComplete&&solver.search.rejected===0&&solver.search.inflight===0)return {positive:false,proof:report.solverRef??null};
  return {positive:null,proof:report?.simulationRef??null};
}
/** One capture producer and one bounded worker. Economic evaluations never authorize a send. */
export async function runTriggerWatcher(host:WatchHost,options:WatchOptions):Promise<{observations:number;solved:number;deferred:number}> {
  const {policy}=options;validateRecord<Policy>('Policy',policy,policy.schemaVersion);
  if(!['shadow','band'].includes(policy.watchMode??'off')||policy.watchQueueCapacity===undefined||policy.watchMaxSolves===undefined||policy.maxTriggerToSimulationBlocks===undefined||!Number.isSafeInteger(options.maxDurationMs)||options.maxDurationMs<1||options.maxDurationMs>3600000||!Number.isSafeInteger(options.maxObservations)||options.maxObservations<1||options.maxObservations>100000)throw new Error('INPUT_BLOCKED');
  const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)controller.abort();const timer=setTimeout(abort,options.maxDurationMs);
  const cache=new EntryBandCache(),observed=new Map<string,{observation:TriggerObservation;state:Identity}>();
  const queue:Job[]=[],seen=new Set<string>(),invalid=new Set<string>(),counts={observations:0,solved:0,deferred:0};
  let worker:Promise<void>|null=null,failure:unknown,prior:TriggerBlock|undefined,queuedBytes=0;
  let iterator:AsyncIterator<TriggerBlock>|undefined;
  const bounded=async<T>(operation:(signal:AbortSignal)=>Promise<T>,audit=false):Promise<T>=>{
    const local=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;let stop:(()=>void)|undefined;
    try{return await Promise.race([new Promise<never>((_,reject)=>{stop=()=>{local.abort();reject(new Error('WATCH_CANCELLED'));};if(!audit){controller.signal.addEventListener('abort',stop,{once:true});if(controller.signal.aborted)stop();}timeout=setTimeout(()=>{local.abort();reject(new Error('WATCH_OPERATION_DEADLINE'));},policy.deadlineMs);}),Promise.resolve().then(()=>{if(local.signal.aborted)throw new Error('WATCH_CANCELLED');return operation(local.signal);})]);}
    finally{clearTimeout(timeout);if(stop)controller.signal.removeEventListener('abort',stop);local.abort();}
  };
  const emitObservation=async(o:TriggerObservation)=>{validateRecord('TriggerObservation',o);await bounded(signal=>host.persist(o,signal),true);};
  const survival=async(job:Job,detail:Partial<TriggerSurvival>&{reason:string})=>{
    const row:TriggerSurvival={schemaVersion:'5.1',recordType:'trigger-survival',runId:job.observation.runId,triggerRef:digest(job.observation),triggerState:job.block.state,headState:null,triggerProofRef:null,headProofRef:null,observationLatencyMs:job.observation.inclusionToObservationMs,queueMs:Math.max(0,Math.floor(performance.now()-job.enqueued)),solveMs:0,simulationMs:0,result:'UNKNOWN',...detail};
    validateRecord('TriggerSurvival',row);await bounded(signal=>host.persist(row,signal),true);
  };
  const defer=async(job:Job,reason:string)=>{counts.deferred++;job.observation.decision=job.observation.sMinRaw===null?'DEFERRED_NO_BAND':'DEFERRED_BELOW_SMIN';job.observation.reason=reason;await emitObservation(job.observation);await survival(job,{reason});};
  const work=async()=>{
    while(queue.length&&!failure){const job=queue.shift()!;queuedBytes-=job.bytes;
      try{
        if(controller.signal.aborted){await defer(job,'WATCH_CANCELLED');continue;}
        if(invalid.has(job.block.state.stateHashOrDigest)){job.observation.decision='REORGED';job.observation.reason='TRIGGER_REORGED';await emitObservation(job.observation);await survival(job,{reason:'TRIGGER_REORGED'});continue;}
        if(counts.solved>=policy.watchMaxSolves!){await defer(job,'SOLVE_BUDGET_EXHAUSTED');continue;}
        counts.solved++;job.observation.decision='SOLVE';job.observation.solverRunId=`trigger-${digest([job.observation.runId,job.observation.transactionId,job.observation.logIndex]).slice(0,32)}`;
        if(job.observation.bandRef===null)job.observation.reason='BANDLESS_SHADOW_SOLVE';
        await emitObservation(job.observation);const queueMs=Math.max(0,Math.floor(performance.now()-job.enqueued));
        const replay=await bounded(signal=>host.evaluate(structuredClone(job.block),structuredClone(job.observation),signal));
        let head=await bounded(signal=>host.current(signal));
        if(BigInt(head.state.height)-BigInt(job.block.state.height)>BigInt(policy.maxTriggerToSimulationBlocks!)){await survival(job,{queueMs,solveMs:replay.solveMs,simulationMs:replay.simulationMs,reason:'TRIGGER_DEADLINE_EXCEEDED'});continue;}
        const live=await bounded(signal=>host.evaluate(structuredClone(head),structuredClone(job.observation),signal));
        const produced=await bounded(signal=>host.current(signal));
        if(digest(replay.state)!==digest(job.block.state)||digest(live.state)!==digest(head.state)||BigInt(replay.producedAtHeight)<BigInt(job.block.state.height)||BigInt(live.producedAtHeight)<BigInt(head.state.height))throw new Error('SURVIVAL_STATE_MISMATCH');
        if(head.state.networkId!==job.block.state.networkId||head.state.namespace!==job.block.state.namespace||produced.state.networkId!==head.state.networkId)throw new Error('SURVIVAL_CHAIN_MISMATCH');
        const canonical=async(earlier:TriggerBlock,later:TriggerBlock)=>{
          const delta=BigInt(later.state.height)-BigInt(earlier.state.height);
          if(delta===0n)return earlier.state.stateHashOrDigest===later.state.stateHashOrDigest;
          if(delta===1n)return later.parentHash===earlier.state.stateHashOrDigest;
          return delta>1n&&!!host.canonical&&await bounded(signal=>host.canonical!(earlier.state,signal));
        };
        if(!await canonical(job.block,head)||!await canonical(head,produced))throw new Error('SURVIVAL_ANCESTRY_UNVERIFIED');
        const before=proofOutcome(replay),after=proofOutcome(live);
        const stale=head.state.finality==='provisional'||produced.state.finality==='provisional'||BigInt(produced.state.height)<BigInt(head.state.height)||BigInt(produced.state.height)-BigInt(job.block.state.height)>BigInt(policy.maxTriggerToSimulationBlocks!)||produced.state.height===head.state.height&&produced.state.stateHashOrDigest!==head.state.stateHashOrDigest;
        const reorged=invalid.has(job.block.state.stateHashOrDigest);
        const result=!stale&&!reorged&&before.positive===true&&after.proof!==null?(after.positive===true?'SURVIVED':after.positive===false?'CLOSED':'UNKNOWN'):'UNKNOWN';
        await survival(job,{queueMs,headState:live.state,triggerProofRef:before.proof,headProofRef:after.proof,solveMs:replay.solveMs+live.solveMs,simulationMs:replay.simulationMs+live.simulationMs,result,reason:reorged?'TRIGGER_REORGED':stale?'TRIGGER_DEADLINE_EXCEEDED':result==='UNKNOWN'?'INSUFFICIENT_SURVIVAL_EVIDENCE':result==='SURVIVED'?'QUALIFYING_NATIVE_HEAD_RECHECK':'EDGE_CLOSED_AT_HEAD'});
      }catch(e){await survival(job,{reason:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'WATCH_EVALUATION_FAILED'});}
    }
  };
  const start=()=>{if(!worker)worker=work().catch(e=>{failure=e;}).finally(()=>{worker=null;});};
  try{
    iterator=host.blocks(controller.signal)[Symbol.asyncIterator]();
    while(!controller.signal.aborted){
      let next:IteratorResult<TriggerBlock>;try{next=await bounded(()=>iterator!.next());}catch(error){const code=error instanceof Error?error.message:'';if(!prior||!['SOURCE_GAP_OR_DIVERGENCE','SOURCE_HEAD_REGRESSION','SOURCE_BACKFILL_LIMIT','L2_BLOCK_DIVERGENCE'].includes(code))throw error;next={done:false,value:{...prior,swaps:[],invalidated:true,sourceFailure:code}};}
      if(next.done)break;const block=structuredClone(next.value);const blockBytes=Buffer.byteLength(JSON.stringify(block));if(blockBytes>4*1024*1024)throw new Error('WATCH_CAPTURE_TOO_LARGE');
      if(controller.signal.aborted||failure)break;
      const hash=block.state.stateHashOrDigest;
      const changed=block.invalidated||prior&&(block.state.height===prior.state.height&&hash!==prior.state.stateHashOrDigest||BigInt(block.state.height)===BigInt(prior.state.height)+1n&&block.parentHash!==prior.state.stateHashOrDigest);
      if(changed){
        cache.clear();if(block.sourceFailure)for(const saved of observed.values())invalid.add(saved.state.stateHashOrDigest);if(prior)invalid.add(prior.state.stateHashOrDigest);if(block.invalidated)invalid.add(hash);
        for(const saved of observed.values())if(invalid.has(saved.state.stateHashOrDigest)){
          const oldHash=digest(saved.observation),invalidated:TriggerObservation={...saved.observation,decision:'REORGED',reason:`TRIGGER_REORGED:${oldHash}`};
          await emitObservation(invalidated);
          const row:TriggerSurvival={schemaVersion:'5.1',recordType:'trigger-survival',runId:invalidated.runId,triggerRef:oldHash,triggerState:saved.state,headState:null,triggerProofRef:null,headProofRef:null,observationLatencyMs:invalidated.inclusionToObservationMs,queueMs:0,solveMs:0,simulationMs:0,result:'UNKNOWN',reason:'TRIGGER_REORGED'};
          await bounded(signal=>host.persist(row,signal),true);
        }
      }
      const gap=prior&&BigInt(block.state.height)>BigInt(prior.state.height)+1n;if(gap)cache.clear();
      const bandInput=policy.watchMode==='band'&&host.bandInputs?await bounded(signal=>host.bandInputs!(block,signal)):null;
      const band=bandInput?cache.get(bandInput,block.liquidityEvents??[]):null;
      for(const swap of block.swaps){
        const key=digest([hash,swap.transactionId,swap.logIndex]);if(seen.has(key))continue;seen.add(key);counts.observations++;
        const threshold=band?.sMin.find(r=>r.triggerPoolId===swap.poolId&&r.triggerDirection===swap.direction)?.minimumTriggerRaw??null;
        const observation:TriggerObservation={...swap,schemaVersion:'5.1',recordType:'trigger-observation',runId:`${options.runId}-${key.slice(0,16)}`,state:block.state,bandRef:band?digest(band):null,sMinRaw:threshold,decision:'QUEUED',solverRunId:null,reason:band?null:'BANDLESS_SHADOW_SOLVE'};
        const job:Job={block,observation,priority:threshold!==null&&BigInt(swap.amountInRaw)>=BigInt(threshold)?1:0,enqueued:performance.now(),bytes:blockBytes};
        if(gap||block.invalidated){observation.decision=block.invalidated?'REORGED':'STALE_BAND';observation.reason=gap?'SOURCE_GAP':'TRIGGER_REORGED';await emitObservation(observation);await survival(job,{reason:observation.reason});}
        else if(band&&BigInt(block.state.height)>BigInt(band.validThroughHeight)){observation.decision='STALE_BAND';observation.reason='BAND_EXPIRED';await emitObservation(observation);await survival(job,{reason:'BAND_EXPIRED'});}
        else{observed.set(key,{observation,state:block.state});await emitObservation(observation);queue.push(job);queuedBytes+=job.bytes;queue.sort((a,b)=>b.priority-a.priority||a.enqueued-b.enqueued);while(queue.length>policy.watchQueueCapacity!||queuedBytes>16*1024*1024){const dropped=queue.pop()!;queuedBytes-=dropped.bytes;await defer(dropped,'QUEUE_CAPACITY_EXCEEDED');}}
        if(counts.observations>=options.maxObservations)break;
      }
      start();prior=block;if(block.sourceFailure)throw new Error(block.sourceFailure);if(counts.observations>=options.maxObservations)break;
    }
    if(worker)await worker;if(failure)throw failure;return counts;
  }finally{clearTimeout(timer);controller.abort();if(worker)await worker;for(const job of queue.splice(0))await survival(job,{reason:'WATCH_CANCELLED'});if(iterator?.return){let closeTimer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([iterator.return(),new Promise(resolve=>{closeTimer=setTimeout(resolve,policy.deadlineMs);})]);}finally{clearTimeout(closeTimer);}}options.signal?.removeEventListener('abort',abort);}
}
export function watcherState(pools:PoolStateEnvelope[]):Identity{if(!pools.length)throw new Error('EMPTY_WATCH_STATE');return evidenceIdentity(pools[0]);}
