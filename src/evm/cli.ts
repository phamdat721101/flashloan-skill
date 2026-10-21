import { recoverDeadExecutionLock } from '../execution-lock.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, http, keccak256, parseAbi } from 'viem';
import { evmProfile } from '../evm-chains.js';
import { EvmDeployment, loadSigner, parseManifest, verifyRuntime, secureEndpoint, type DeploymentState, type ForgeArtifact } from './deployment.js';

const args = process.argv.slice(2), command = args.shift();
function option(name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('MISSING_OPTION_VALUE');
  return args[index + 1];
}
async function main() {
  if (!['deploy', 'deployment-status', 'profiles', 'acceptance', 'acceptance-reconcile', 'recover-lock', 'discover'].includes(command ?? '')) throw new Error('usage: evm profiles | deploy|deployment-status --manifest <json> [--env-file <local-file>] [--state <json>] | acceptance --config <json>');
  if (command === 'recover-lock') {
    const chainId=Number(option('--chain'));evmProfile(chainId);
    const file=option('--env-file');if(!file)throw new Error('EXPLICIT_SIGNER_ENV_FILE_REQUIRED');
    const account=await loadSigner(file);
    return {chainId,recovered:await recoverDeadExecutionLock(`.nim/signing/${chainId}-${account.address.toLowerCase()}.lock`)};
  }
  if (command === 'profiles') return [42161,8453,4663].map(id => { const p = evmProfile(id); return { chainId:id, key:p.key, rpcEnv:p.rpcEnv, feeModel:p.feeModel, wrappedNative:p.wrappedNative }; });
  if (command === 'acceptance' || command === 'acceptance-reconcile') {
    const path = option('--config'); if (!path) throw new Error('ACCEPTANCE_CONFIG_REQUIRED');
    return (await import('./acceptance.js')).runAcceptance(path, option('--env-file'), command === 'acceptance-reconcile');
  }
  const path = option('--manifest'); if (!path) throw new Error('MANIFEST_REQUIRED');
  const manifest = parseManifest(JSON.parse(await readFile(path,'utf8'))), profile = evmProfile(manifest.chainId);
  const rpc = process.env[profile.rpcEnv] ?? profile.chain.rpcUrls.default.http[0];
  const submission = process.env[`${profile.key.toUpperCase()}_SUBMISSION_URL`] ?? rpc;
  if(command==='discover') {
    const from=option('--from-block'),to=option('--to-block');if(!from||!to||!/^\d+$/.test(from)||!/^\d+$/.test(to))throw new Error('EXPLICIT_DISCOVERY_RANGE_REQUIRED');
    return (await import('./discovery.js')).discoverEvmPools(manifest,BigInt(from),BigInt(to),args.includes('--probe-standard-keys'),args.includes('--connected-profit-assets'));
  }
  const statePath = option('--state') ?? `.nim/deployments/${profile.key}.json`;
  if (command === 'deploy') {
    const envFile = option('--env-file'); if (!envFile) throw new Error('EXPLICIT_SIGNER_ENV_FILE_REQUIRED');
    return new EvmDeployment(manifest,rpc,submission,await loadSigner(envFile),statePath).run();
  }
  const state: DeploymentState = JSON.parse(await readFile(statePath,'utf8'));
  if (state.chainId !== manifest.chainId) throw new Error('DEPLOYMENT_STATE_CHAIN_MISMATCH');
  const client = createPublicClient({ transport: http(secureEndpoint(rpc),{ retryCount:0 }) });
  if (await client.getChainId() !== manifest.chainId) throw new Error('CHAIN_MISMATCH');
  const finalized = await client.getBlock({ blockTag:'finalized' });
  const deployments = [];
  for (const entry of state.deployments) {
    const artifact: ForgeArtifact = JSON.parse(await readFile(resolve('out',`${entry.contract}.sol`,`${entry.contract}.json`),'utf8'));
    const code = await client.getCode({ address:entry.address }); if (!code) throw new Error('DEPLOYED_CODE_MISSING');
    verifyRuntime(artifact,code,state.owner);
    if (keccak256(code) !== entry.runtimeCodeHash) throw new Error('DEPLOYED_CODE_CHANGED');
    if (entry.owner && (await client.readContract({ address:entry.address,abi:parseAbi(['function owner() view returns(address)']),functionName:'owner' })).toLowerCase() !== state.owner.toLowerCase()) throw new Error('OWNER_MISMATCH');
    let allFinalized = true;
    for (const tx of [entry.txHash,...entry.configurations.map(c=>c.txHash)]) {
      const receipt = await client.getTransactionReceipt({ hash:tx });
      if (receipt.blockNumber > finalized.number) allFinalized = false;
      if (receipt.status !== 'success' || (await client.getBlock({ blockNumber:receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('INVALID_DEPLOYMENT_RECEIPT');
    }
    deployments.push({ ...entry, finalized: allFinalized });
  }
  return { schemaVersion:'1.0',chainId:manifest.chainId,deployments,exclusions:manifest.exclusions,tradingAdmission:'not-admitted' };
}
main().then(result => console.log(JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v))).catch((error: unknown) => {
  // Provider errors can contain authenticated URLs. Never print raw transport errors.
  const message=error instanceof Error?error.message:'';
  const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(message)?message:'EVM_COMMAND_FAILED';
  const category=error instanceof Error && /^[A-Za-z]{1,60}Error$/.test(error.name)?error.name:'Error';
  console.error(JSON.stringify({ status:'failed',code,category,detail:'Inspect local verification evidence; no raw provider or signer details are emitted.' })); process.exitCode=1;
});
