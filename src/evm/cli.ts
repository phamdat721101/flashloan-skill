import { recoverDeadExecutionLock } from '../execution-lock.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, http, keccak256, parseAbi, type Address } from 'viem';
import { evmProfile } from '../evm-chains.js';
import { atomicJson } from './storage.js';
import { EvmDeployment, loadSigner, parseManifest, verifyRuntime, verifyExecutorManifest, secureEndpoint, type DeploymentState, type ForgeArtifact } from './deployment.js';

const args = process.argv.slice(2), command = args.shift();
function option(name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('MISSING_OPTION_VALUE');
  return args[index + 1];
}
async function main() {
  if (!['deploy', 'deployment-status', 'profiles', 'acceptance', 'acceptance-reconcile', 'recover-lock', 'discover', 'universe', 'universe-probe', 'integration-run'].includes(command ?? '')) throw new Error('usage: evm profiles | integration-run --intent <json> --inventory <json> --mapping <json> [--profile <json>] | universe --inventory <mcp.json> --policy <policy.json> --out <path> [--block <n>] | deploy|deployment-status --manifest <json> [--env-file <local-file>] [--state <json>] | acceptance --config <json>');
  if (command === 'recover-lock') {
    const chainId=Number(option('--chain'));evmProfile(chainId);
    const file=option('--env-file');if(!file)throw new Error('EXPLICIT_SIGNER_ENV_FILE_REQUIRED');
    const account=await loadSigner(file);
    return {chainId,recovered:await recoverDeadExecutionLock(`.nim/signing/${chainId}-${account.address.toLowerCase()}.lock`)};
  }
  if (command === 'integration-run') {
    // v7: read-only identity/policy/ledger round. It never loads signer secrets; execution stays in the admitted acceptance lane.
    const { runIntegrationRound } = await import('../evidence/gap-runtime.js');
    const { viemV4Reader, parseInitializeCache, serializeInitializeCache } = await import('./v4-resolution.js');
    const read = (path: string | undefined, name: string) => { if (!path) throw new Error(`${name}_REQUIRED`); return readFile(path); };
    const intent = JSON.parse((await read(option('--intent'), 'INTENT')).toString());
    const chainId = Number(String(intent.chainId).replace(/^eip155:/, '')), profile = evmProfile(chainId);
    const mappingPath = option('--mapping'), refs = option('--profile') ? JSON.parse((await read(option('--profile'), 'PROFILE')).toString()) : {};
    const client = createPublicClient({ transport: http(secureEndpoint(process.env[profile.rpcEnv] ?? profile.chain.rpcUrls.default.http[0]), { retryCount: 0, timeout: 20000 }) });
    if (await client.getChainId() !== chainId) throw new Error('CHAIN_MISMATCH');
    // Initialize facts are immutable: cache them so a round scans logs only for pool ids it has never verified.
    const cachePath = option('--resolution-cache') ?? `.nim/v4-resolution-cache/${chainId}.json`, pageSize = option('--page-size');
    if (pageSize !== undefined && !/^[1-9]\d*$/.test(pageSize)) throw new Error('PAGE_SIZE_INVALID');
    const knownFacts = await readFile(cachePath, 'utf8').then(t => parseInitializeCache(JSON.parse(t), intent.chainId), (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return new Map(); throw e; });
    const out = await runIntegrationRound({ intent, knownFacts, pageSize: pageSize === undefined ? undefined : BigInt(pageSize), inventory: JSON.parse((await read(option('--inventory'), 'INVENTORY')).toString()), mappingBytes: await read(mappingPath, 'MAPPING'), mappingLocator: mappingPath!,
      versions: JSON.parse(await readFile('config/flashloan-integration-versions.json', 'utf8')),
      release: { baseVersionsBytes: await readFile('config/flashloan-versions.json'), promptBytes: await readFile('skills/flashloan-agent/prompt-v7.md'), contractBytes: await readFile('schemas/flashloan-integration-v1.schema.json'), producersBytes: await readFile('config/admission-producers.json') },
      refs, nowNs: BigInt(Date.now()) * 1_000_000n }, viemV4Reader(client as never));
    if (out.facts.size) await atomicJson(cachePath, serializeInitializeCache(intent.chainId, new Map([...knownFacts, ...out.facts])));
    const { facts: _facts, ...result } = out;
    return result;
  }
  if (command === 'profiles') return [42161,8453,4663].map(id => { const p = evmProfile(id); return { chainId:id, key:p.key, rpcEnv:p.rpcEnv, feeModel:p.feeModel, wrappedNative:p.wrappedNative }; });
  if (command === 'acceptance' || command === 'acceptance-reconcile') {
    const path = option('--config'); if (!path) throw new Error('ACCEPTANCE_CONFIG_REQUIRED');
    return (await import('./acceptance.js')).runAcceptance(path, option('--env-file'), command === 'acceptance-reconcile');
  }
  if (command === 'universe') {
    const inventoryPath = option('--inventory'), policyPath = option('--policy'), out = option('--out'), block = option('--block');
    if (!inventoryPath || !policyPath || !out || (block !== undefined && !/^\d+$/.test(block))) throw new Error('UNIVERSE_INPUT_REQUIRED');
    const u = await import('./pool-universe.js');
    const policy = u.parseAssetPolicy(JSON.parse(await readFile(policyPath,'utf8'))), profile = evmProfile(policy.chainId);
    const client = createPublicClient({ transport: http(secureEndpoint(process.env[profile.rpcEnv] ?? profile.chain.rpcUrls.default.http[0]),{ retryCount:2 }) });
    if (await client.getChainId() !== policy.chainId) throw new Error('CHAIN_MISMATCH');
    const universe = u.validateUniverse(await u.buildPoolUniverse(u.parseInventory(JSON.parse(await readFile(inventoryPath,'utf8'))), policy, u.viemUniverseReader(client as never, block === undefined ? undefined : BigInt(block)), Date.now(), {retainCycleEdges: process.argv.includes('--cycles')}));
    await atomicJson(out, universe);
    return { out, blockNumber: universe.identity.blockNumber, pairs: universe.pairs.length, pools: universe.pools.length, candidatePairs: universe.candidatePairs.length,
      rejected: universe.rejected.reduce<Record<string, number>>((counts, r) => ({ ...counts, [r.reason]: (counts[r.reason] ?? 0) + 1 }), {}), topGaps: u.pairGaps(universe).slice(0, 5) };
  }
  if (command === 'universe-probe') {
    const universePath = option('--universe') ?? process.env.UNIVERSE_PATH, executor = option('--executor') ?? process.env.MULTI_VENUE_EXECUTOR_ADDRESS, lender = option('--lender'), kind = Number(option('--lender-kind') ?? '2'), sizeUsd = Number(option('--size-usd') ?? '1000');
    if (!universePath || !executor || !lender || ![1, 2].includes(kind) || !(sizeUsd > 0)) throw new Error('UNIVERSE_PROBE_INPUT_REQUIRED');
    const u = await import('./pool-universe.js'), { priceUsdE8 } = await import('../evm-fees.js');
    const raw = JSON.parse(await readFile(universePath, 'utf8')), profile = evmProfile(raw.chainId);
    const universe = await u.loadPoolUniverse(universePath, raw.chainId);
    const client = createPublicClient({ transport: http(secureEndpoint(process.env[profile.rpcEnv] ?? profile.chain.rpcUrls.default.http[0]),{ retryCount:2, timeout:120_000 }) });
    if (await client.getChainId() !== universe.chainId) throw new Error('CHAIN_MISMATCH');
    const block = await client.getBlockNumber(), amounts: Record<string, bigint> = {};
    for (const asset of universe.assets.filter(a => a.usdFeed && a.flashLenders.length)) amounts[asset.address] = BigInt(Math.round(sizeUsd * 1e8)) * 10n ** BigInt(asset.decimals) / await priceUsdE8(client as never, asset.usdFeed!, block, 86400);
    const probes = await u.probeUniverseRoutes(client as never, universe, executor.toLowerCase() as `0x${string}`, { kind: kind as 1 | 2, address: lender.toLowerCase() as `0x${string}` }, amounts);
    return { blockNumber: block.toString(), sizeUsd, outcomes: probes.reduce<Record<string, number>>((c, p) => ({ ...c, [p.outcome]: (c[p.outcome] ?? 0) + 1 }), {}), probes };
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
  const executorManifest = option('--executor-manifest');
  if (executorManifest) {
    // v7 SK-03: the stored historical artifact is authoritative; an out/ rebuild is only a diagnostic.
    const record = JSON.parse(await readFile(executorManifest,'utf8')) as { address: Address; allowedWrapper: Address | null };
    const client = createPublicClient({ transport: http(secureEndpoint(rpc),{ retryCount:0 }) });
    if (await client.getChainId() !== manifest.chainId) throw new Error('CHAIN_MISMATCH');
    const code = await client.getCode({ address:record.address }); if (!code) throw new Error('DEPLOYED_CODE_MISSING');
    const owner = await client.readContract({ address:record.address,abi:parseAbi(['function owner() view returns(address)']),functionName:'owner' });
    const rebuild = option('--rebuild');
    const wrapperCode = record.allowedWrapper ? await client.getCode({ address:record.allowedWrapper }) : undefined;
    return { ...(await verifyExecutorManifest(record,{ code,owner,...(wrapperCode ? { wrapperCodeHash:keccak256(wrapperCode) } : {}) },undefined,rebuild ? await readFile(rebuild) : undefined)),tradingAdmission:'not-admitted' };
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
