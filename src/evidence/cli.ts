import {readFile,readdir,lstat} from 'node:fs/promises';
import {resolve,dirname,basename,join} from 'node:path';
import {ArtifactStore,inspectRound,loadRawArtifact,readBoundedEvidenceFile,type ArtifactInput,type IntegrityContext} from './integrity.js';
import {runEvidence,loadLessonMapping,type CapturedMarket,type EvidenceHost} from './runtime.js';
import type {ApprovedProfile} from './economics.js';
import type {RunRequest} from './contracts.js';
export async function readEvidenceJson(path:string):Promise<unknown>{const bytes=await readBoundedEvidenceFile(path,4*1024*1024);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('INVALID_EVIDENCE_JSON');}}
export async function runEvidenceCli(command:string,args:string[]):Promise<void>{
  const [path,...rest]=args;if(!path)throw new Error('EVIDENCE_INPUT_REQUIRED');
  if(command==='evidence-run'){
    if(rest.length)throw new Error('UNKNOWN_EVIDENCE_ARGUMENT');
    const request=await readEvidenceJson(path);let host:EvidenceHost|undefined;
    const configured=process.env.FLASHLOAN_EVIDENCE_HOST_FILE;
    if(configured){
      const c=await readEvidenceJson(configured) as {schemaVersion:string;kind:string;profile:ApprovedProfile;market:CapturedMarket;inventory:unknown[]};
      if(!c||c.schemaVersion!=='evidence-host/1.0'||c.kind!=='snapshot-file'||Object.keys(c).some(k=>!['schemaVersion','kind','profile','market','inventory'].includes(k))||!Array.isArray(c.inventory))throw new Error('UNSUPPORTED_HOST_CONFIG');
      host={profile:async()=>structuredClone(c.profile),inventory:async()=>structuredClone(c.inventory),capture:async()=>structuredClone(c.market)};
    }
    const root=process.env.FLASHLOAN_EVIDENCE_ROOT??'.nim/evidence',runId=(request as RunRequest).runId;
    const checks=await loadLessonMapping('config/lesson-checks.json',runId);
    const store=new ArtifactStore(root),previousId=(request as RunRequest).previousRoundRef;
    const previous=previousId?await store.load(previousId):undefined;
    const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{const manifest=await runEvidence(request,{host,store,checks,previous,signal:controller.signal,maxDurationMs:60000});console.log(JSON.stringify({runId:manifest.context.runId,integrity:manifest.integrity,recall:manifest.recall,report:manifest.artifacts.find(a=>a.kind==='report')?.value??null}));if(manifest.integrity.verdict==='BLOCK'||manifest.recall.blocked)process.exitCode=1;}
    finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}return;
  }
  if(command==='evidence-integrity'){
    if(rest.length&&!(rest.length===2&&rest[0]==='--previous'))throw new Error('UNKNOWN_EVIDENCE_ARGUMENT');
    const absolute=resolve(path),store=new ArtifactStore(dirname(dirname(absolute))),runId=decodeURIComponent(basename(absolute));
    let managed=false;try{await lstat(join(absolute,'manifest.json'));managed=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(managed){const round=await store.load(runId),prior=rest[1]?resolve(rest[1]):null,previous=prior?await new ArtifactStore(dirname(dirname(prior))).load(decodeURIComponent(basename(prior))):undefined;console.log(JSON.stringify(inspectRound(round.artifacts,round.context,previous)));}
    else{
      const entries=(await readdir(absolute)).filter(n=>!n.startsWith('.')&&n.endsWith('.json')).sort();if(entries.length>512)throw new Error('ARTIFACT_COUNT_LIMIT');
      const artifacts:ArtifactInput[]=[];let bytes=0;for(const name of entries){const file=join(absolute,name),stat=await lstat(file);if(!stat.isFile()||stat.size>4*1024*1024)throw new Error('INVALID_ARTIFACT_FILE');bytes+=stat.size;if(bytes>16*1024*1024)throw new Error('ARTIFACT_BYTES_LIMIT');artifacts.push(await loadRawArtifact(file));}
      const context:IntegrityContext={runId,roundId:runId,stateDigest:null,policyHash:null,candidateHash:null,executionContextHash:null,payloadHash:null,executorCodeOrPackageHash:null,adapterRevision:null,nowNs:(BigInt(Date.now())*1000000n).toString()};
      console.log(JSON.stringify(inspectRound(artifacts,context)));
    }return;
  }
  throw new Error('UNSUPPORTED_EVIDENCE_COMMAND');
}
