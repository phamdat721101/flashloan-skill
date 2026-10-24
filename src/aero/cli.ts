import { readFile } from 'node:fs/promises';
import { atomicJson } from '../evm/storage.js';
import { aeroPublicClient,captureAeroSnapshot, type CapturePool } from './capture.js';
import { optimizeAeroSplit } from './solver.js';
import { createAeroEvmHost } from './evm-host.js';
import { simulateAeroExecution, type AeroArtifact } from './execution.js';
import { parseAeroRequest } from './types.js';
import { runAeroLive } from './live.js';

const args=process.argv.slice(2),command=args.shift();
const option=(key:string)=>{const n=args.indexOf(key);if(n<0)return undefined;if(!args[n+1]||args[n+1].startsWith('--'))throw new Error('MISSING_OPTION_VALUE');return args[n+1];};
async function main(){
  const output=option('--output');if(!output)throw new Error('OUTPUT_REQUIRED');
  const rpc=process.env.BASE_RPC_URL??'https://mainnet.base.org';
  if(command==='capture'){
    const registry=option('--registry');if(!registry)throw new Error('REGISTRY_REQUIRED');
    const inputs:CapturePool[]=JSON.parse(await readFile(registry,'utf8'));const block=option('--block');
    const result=await captureAeroSnapshot(aeroPublicClient(rpc),inputs,block?BigInt(block):undefined);await atomicJson(output,result);return {status:'captured',pools:result.pools.length,blockHash:result.identity.blockHash,output};
  }
  if(command==='run'){
    // Live sends: explicit --env-file signer and BASE_SUBMISSION_URL; halts on first revert until --resume.
    const config=option('--config');if(!config)throw new Error('CONFIG_REQUIRED');
    const state=await runAeroLive(config,option('--env-file'),{resume:args.includes('--resume')});
    await atomicJson(output,state);return {status:state.status,reason:state.reason,results:state.results.length,output};
  }
  if(command!=='plan'&&command!=='simulate')throw new Error('USAGE_AERO_CAPTURE_PLAN_SIMULATE_RUN');
  const path=option('--request');if(!path)throw new Error('REQUEST_REQUIRED');
  const request=parseAeroRequest(JSON.parse(await readFile(path,'utf8'))),artifactPath=option('--artifact');
  const artifact:AeroArtifact|undefined=artifactPath?JSON.parse(await readFile(artifactPath,'utf8')):undefined;
  const evm=option('--evm-rpc');if(evm&&!artifact)throw new Error('ARTIFACT_REQUIRED');
  const result=await optimizeAeroSplit(request,evm?createAeroEvmHost(aeroPublicClient(evm),evm,artifact!.address):{});
  if(command==='simulate'&&result.status==='selected'){
    if(!artifact)throw new Error('ARTIFACT_REQUIRED');
    const valuationPath=option('--valuation');
    const valuation=valuationPath?JSON.parse(await readFile(valuationPath,'utf8')):undefined;
    const proof=await simulateAeroExecution(aeroPublicClient(evm??rpc),request,result,artifact,{requireLatest:true,valuation});await atomicJson(output,{result,proof});return {status:'simulated',broadcast:false,output};
  }
  await atomicJson(output,result);return {status:result.status,broadcast:false,output};
}
main().then(result=>console.log(JSON.stringify(result))).catch((error:unknown)=>{
  const message=error instanceof Error?error.message:'';
  const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(message)?message:'AERO_COMMAND_FAILED';
  console.error(JSON.stringify({status:'failed',code,broadcast:false}));process.exitCode=1;
});
