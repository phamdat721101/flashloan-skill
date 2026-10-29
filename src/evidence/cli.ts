import {digest} from '../liquidity/state.js';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {resolve,dirname,basename,join} from 'node:path';
import {ArtifactStore,inspectRound,loadRawArtifact,readBoundedEvidenceFile,type ArtifactInput,type IntegrityContext} from './integrity.js';
import {runEvidence,loadLessonMapping,type CapturedMarket,type EvidenceHost} from './runtime.js';
import type {ApprovedProfile} from './economics.js';
import type {RunRequest} from './contracts.js';
export async function readEvidenceJson(path:string):Promise<unknown>{const bytes=await readBoundedEvidenceFile(path,4*1024*1024);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('INVALID_EVIDENCE_JSON');}}
export async function runEvidenceCli(command:string,args:string[]):Promise<void>{
  const [path,...rest]=args;if(!path)throw new Error('EVIDENCE_INPUT_REQUIRED');
  if(command==='evidence-gap-run'){
    const request=await readEvidenceJson(path),v6=(request as {schema?:unknown})?.schema==='flash-run-request/1';
    if(rest.length&&!(v6&&rest.length===2&&rest[0]==='--movers'))throw new Error('UNKNOWN_EVIDENCE_ARGUMENT');
    const {runGapEvidence}=await import('./gap-runtime.js');
    const configured=process.env.FLASHLOAN_EVIDENCE_HOST_FILE;if(!configured)throw new Error('HANDOFF_REQUIRED');
    const c=await readEvidenceJson(configured) as {schemaVersion:string;kind:string;inventory:unknown[];options:Array<{option:import('./gap-runtime.js').FundingOption;market:CapturedMarket;profile:ApprovedProfile}>};
    if(c.schemaVersion!=='gap-host/1.0'||c.kind!=='funding-snapshot-file'||Object.keys(c).some(k=>!['schemaVersion','kind','inventory','options'].includes(k))||!Array.isArray(c.options)||c.options.length>256||!Array.isArray(c.inventory))throw new Error('UNSUPPORTED_HOST_CONFIG');
    const host:import('./gap-runtime.js').GapHost={funding:async()=>c.options.map(o=>o.option),captureFunding:async(_r,o)=>{const found=c.options.find(v=>v.option.optionId===o.optionId);if(!found)throw new Error('FUNDING_OPTION_MISSING');return structuredClone({market:found.market,profile:found.profile});},inventory:async()=>structuredClone(c.inventory),capture:async()=>{throw new Error('FUNDING_OPTION_REQUIRED');},profile:async()=>{throw new Error('FUNDING_OPTION_REQUIRED');}};
    const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    const root=process.env.FLASHLOAN_EVIDENCE_ROOT??'.nim/evidence';
    if(v6){try{
      // v6: one approved profile for every option, version map + prompt hash checked before any capture.
      const {runFlashRound}=await import('./gap-runtime.js'),{createHash}=await import('node:crypto'),{writeFile,mkdir}=await import('node:fs/promises');
      const first=c.options[0];if(!first||c.options.some(o=>digest(o.profile)!==digest(first.profile)))throw new Error('UNSUPPORTED_HOST_CONFIG');
      const prompt=await readFile('skills/flashloan-agent/prompt-v6.md'),movers=rest[1]?await readEvidenceJson(rest[1]):undefined;
      const round=await runFlashRound(request,{host,store:new ArtifactStore(root),signal:controller.signal,maxDurationMs:60000,fundingOptions:c.options.map(o=>o.option),profile:first.profile,
        refs:{valuation:first.market.valuation.ref,networkCost:first.market.networkCost.evidence},versions:await readEvidenceJson('config/flashloan-versions.json'),promptSha256:createHash('sha256').update(prompt).digest('hex'),movers});
      const ledgerPath=join(root,`${encodeURIComponent(round.ledger.round_id)}.candidate-ledger.json`);await mkdir(root,{recursive:true});await writeFile(ledgerPath,JSON.stringify(round.ledger,null,2));
      console.log(JSON.stringify({...round.gap,rounds:round.gap.rounds.map(r=>({runId:r.context.runId,integrity:r.integrity.verdict})),candidates:round.ledger.counts,coverage:round.ledger.source_state.coverage,ledgerPath}));
    }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}return;}
    try{const result=await runGapEvidence(request,{host,store:new ArtifactStore(root),signal:controller.signal,maxDurationMs:60000});console.log(JSON.stringify({...result,rounds:result.rounds.map(r=>({runId:r.context.runId,integrity:r.integrity.verdict}))}));}
    finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}return;
  }
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
