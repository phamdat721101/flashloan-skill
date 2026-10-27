import { evmProfile } from '../evm-chains.js';
import { open, readFile } from 'node:fs/promises';
import { runLiquidityAnalytics } from './analytics.js';
import { readArbitrumHead, readArbitrumV2Snapshot, readArbitrumAnalyticsSnapshot, readSuiCheckpoint, readSuiHead, readSuiNativeCheckpoints, readSuiCetusAnalyticsSnapshot, SOURCE_CAPABILITIES, type V2SourcePool, type AnalyticsPoolConfig } from './sources.js';
import { parseSnapshot, SnapshotStore } from './state.js';
import { followSource, ingestSourceRange, readSourceLines, reconcileNativeCheckpoints, SourceJournal } from './ingestion.js';
import { recoverSuiCheckpointState } from './sui-state.js';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { readAlgebraLinkedSnapshot } from './algebra.js';
import { simulateV4Projection, type V4SimulationBinding } from './v4-simulation.js';
import type { StateClient } from '../state-adapters.js';
import type { CheckpointObjectSet, CetusDecodeConfig } from '../sui/cetus.js';

async function readAnalyticsJson(path: string): Promise<unknown> {
  const file = await open(path,'r');
  let bytes: Buffer;
  try {
    const limit = 4 * 1024 * 1024;
    if (!(await file.stat()).isFile()) throw new Error('INVALID_ANALYTICS_FILE');
    bytes = Buffer.alloc(limit + 1); let used = 0;
    while (used < bytes.length) { const read = await file.read(bytes,used,bytes.length - used,null); if (!read.bytesRead) break; used += read.bytesRead; }
    if (used > limit) throw new Error('ANALYTICS_INPUT_TOO_LARGE');
    bytes = bytes.subarray(0,used);
  } finally { await file.close(); }
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('INVALID_ANALYTICS_JSON'); }
}

async function main(): Promise<void> {
  const [rawCommand, path] = process.argv.slice(2);
  if (rawCommand?.startsWith('evidence-')) { await (await import('../evidence/cli.js')).runEvidenceCli(rawCommand,process.argv.slice(3)); return; }
  const command = rawCommand?.replace(/-evm$/, '-arbitrum');
  if (command?.startsWith('l2-')) { await (await import('./l2-cli.js')).runL2Cli(command,path); return; }
  if (command === 'sources') { console.log(JSON.stringify(SOURCE_CAPABILITIES)); return; }
  if (['snapshot-algebra-arbitrum','simulate-v4','snapshot-analytics-sui','stream-sui'].includes(command)) {
    if (!path) throw new Error('ANALYTICS_INPUT_REQUIRED');
    const input = await readAnalyticsJson(path) as Record<string,unknown>;
    const fields = command === 'snapshot-algebra-arbitrum' ? ['schemaVersion','rpcUrl','address','expectedCodeHash','lowerTick','upperTick'] : command === 'simulate-v4' ? ['schemaVersion','rpcUrl','pool','request','binding'] : command === 'snapshot-analytics-sui' ? ['schemaVersion','rpcUrl','sourceId','checkpoint','configs'] : ['schemaVersion','rpcUrl','sourceId','network','expectedChainIdentifier','journalPath','start','maxFrames','maxGap'];
    if (!input || input.schemaVersion !== (command === 'stream-sui' ? '3.0' : '4.0') || Object.keys(input).sort().join(',') !== fields.sort().join(',') || typeof input.rpcUrl !== 'string') throw new Error('INVALID_SOURCE_CONFIG_FIELDS');
    const endpoint = new URL(input.rpcUrl);
    if (endpoint.username || endpoint.password || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1','localhost'].includes(endpoint.hostname)))) throw new Error('INSECURE_SOURCE_ENDPOINT');
    if (command === 'snapshot-analytics-sui') {
      console.log(JSON.stringify(await readSuiCetusAnalyticsSnapshot(input.rpcUrl,input.sourceId as string,input.checkpoint as CheckpointObjectSet,input.configs as CetusDecodeConfig[]))); return;
    }
    if (command === 'stream-sui') {
      if (!['mainnet','testnet','localnet'].includes(String(input.network)) || typeof input.expectedChainIdentifier !== 'string' || typeof input.sourceId !== 'string' || typeof input.journalPath !== 'string' || typeof input.start !== 'string') throw new Error('INVALID_SOURCE_CONFIG');
      const network = input.network as 'mainnet' | 'testnet' | 'localnet', journal = new SourceJournal(input.journalPath,{ sourceId: input.sourceId,chain: 'sui',network,chainIdentifier: input.expectedChainIdentifier });
      const controller = new AbortController(), abort = () => controller.abort(); process.once('SIGINT',abort); process.once('SIGTERM',abort);
      try {
        const result = await reconcileNativeCheckpoints(journal,readSuiNativeCheckpoints(input.rpcUrl,network,input.expectedChainIdentifier,controller.signal),async height => {
          const checkpoint = await readSuiCheckpoint(input.rpcUrl as string,network,height,input.expectedChainIdentifier as string);
          return { identity: { chain: 'sui' as const,network,height,checkpointDigest: checkpoint.checkpointDigest },parentDigest: checkpoint.previousCheckpointDigest,payload: checkpoint };
        },{ start: input.start,maxFrames: input.maxFrames as number,maxGap: input.maxGap as number,signal: controller.signal },async frame => { console.log(JSON.stringify({ schemaVersion: '3.0',status: 'source-frame-committed',identity: frame.identity })); });
        console.log(JSON.stringify({ schemaVersion: '3.0',...result }));
      } finally { controller.abort(); process.removeListener('SIGINT',abort); process.removeListener('SIGTERM',abort); }
      return;
    }
    const client = createPublicClient({ transport: http(input.rpcUrl,{ timeout: 15000,retryCount: 0 }) }) as unknown as StateClient;
    console.log(JSON.stringify(command === 'simulate-v4' ? await simulateV4Projection(client,input.pool,input.request,input.binding as V4SimulationBinding) : await readAlgebraLinkedSnapshot(client,input.address as Address,input.expectedCodeHash as Hex,input.lowerTick as number,input.upperTick as number)));
    return;
  }
  if (command === 'snapshot-analytics-arbitrum') {
    if (!path) throw new Error('ANALYTICS_INPUT_REQUIRED');
    const config = await readAnalyticsJson(path) as Record<string,unknown>;
    if (!config || config.schemaVersion !== '4.0' || typeof config.rpcUrl !== 'string' || typeof config.sourceId !== 'string' || typeof config.cursor !== 'string' || !Array.isArray(config.pools) || Object.keys(config).some(key => !['schemaVersion','rpcUrl','sourceId','cursor','pools','blockNumber'].includes(key))) throw new Error('INVALID_ANALYTICS_CAPTURE');
    console.log(JSON.stringify(await readArbitrumAnalyticsSnapshot(config.rpcUrl,config.sourceId,config.cursor,config.pools as AnalyticsPoolConfig[],config.blockNumber as string | undefined)));
    return;
  }
  if (['inspect','project','size','size-conditional','compare','prepare-arbitrum','prepare-sui','decode-cetus','quote-deepbook','quote-algebra','target-price'].includes(command)) {
    if (!path) throw new Error('ANALYTICS_INPUT_REQUIRED');
    console.log(JSON.stringify(await runLiquidityAnalytics(command,await readAnalyticsJson(path))));
    return;
  }
  if (!path) throw new Error('usage: liquidity snapshot-arbitrum|checkpoint-sui|ingest-arbitrum|ingest-sui|follow-arbitrum|follow-sui|state-sui|replay <secret-free-input.json/jsonl>');
  if (command === 'replay') {
    const state = new SnapshotStore(60000);
    for await (const line of readSourceLines(path, 4 * 1024 * 1024)) {
      try {
        const snapshot = parseSnapshot(JSON.parse(line));
        const status = state.apply(snapshot);
        console.log(JSON.stringify({ schemaVersion: '3.0', status, stateDigest: snapshot.stateDigest, identity: snapshot.identity }));
      } catch (e) { console.log(JSON.stringify({ schemaVersion: '3.0', status: 'rejected', code: e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'INVALID_INPUT' })); }
    }
  } else {
    const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== '3.0') throw new Error('INVALID_SOURCE_CONFIG_VERSION');
    const fields = command === 'snapshot-arbitrum' ? ['schemaVersion', 'rpcUrl', 'sourceId', 'cursor', 'pools', 'blockNumber']
      : command === 'ingest-arbitrum' ? ['schemaVersion', 'rpcUrl', 'sourceId', 'network', 'pools', 'fromBlock', 'toBlock', 'maxFrames', 'journalPath']
      : command === 'ingest-sui' ? ['schemaVersion', 'rpcUrl', 'sourceId', 'network', 'expectedChainIdentifier', 'fromCheckpoint', 'toCheckpoint', 'maxFrames', 'journalPath']
      : command === 'follow-arbitrum' || command === 'follow-sui' ? ['schemaVersion', 'rpcUrl', 'sourceId', 'network', 'journalPath', 'start', 'maxFrames', 'maxGap', 'pollIntervalMs', 'maxIdlePolls', ...(command === 'follow-sui' ? ['expectedChainIdentifier'] : ['pools'])]
      : command === 'state-sui' ? ['schemaVersion', 'sourceId', 'network', 'expectedChainIdentifier', 'journalPath', 'trackedObjectIds']
      : ['schemaVersion', 'rpcUrl', 'network', 'expectedChainIdentifier', 'checkpoint'];
    if (Object.keys(config).some(key => !fields.includes(key))) throw new Error('INVALID_SOURCE_CONFIG_FIELDS');
    if (command === 'state-sui') {
      if (typeof config.sourceId !== 'string' || typeof config.journalPath !== 'string' || typeof config.network !== 'string' || typeof config.expectedChainIdentifier !== 'string' || !Array.isArray(config.trackedObjectIds)) throw new Error('INVALID_SOURCE_CONFIG');
      const journal = new SourceJournal(config.journalPath, { sourceId: config.sourceId, chain: 'sui', network: config.network, chainIdentifier: config.expectedChainIdentifier });
      const state = await recoverSuiCheckpointState(journal, config.trackedObjectIds as string[]);
      console.log(JSON.stringify(state.snapshot()));
      return;
    }
    if (typeof config.rpcUrl !== 'string') throw new Error('RPC_URL_REQUIRED');
    if (command === 'snapshot-arbitrum') {
      if (typeof config.sourceId !== 'string' || typeof config.cursor !== 'string' || !Array.isArray(config.pools) || (config.blockNumber !== undefined && typeof config.blockNumber !== 'string')) throw new Error('INVALID_SOURCE_CONFIG');
      console.log(JSON.stringify(await readArbitrumV2Snapshot(config.rpcUrl, config.sourceId, config.pools as V2SourcePool[], config.cursor, config.blockNumber as string | undefined)));
    } else if (['ingest-arbitrum', 'ingest-sui', 'follow-arbitrum', 'follow-sui'].includes(command)) {
      if (typeof config.sourceId !== 'string' || typeof config.journalPath !== 'string' || !config.journalPath || typeof config.network !== 'string' || typeof config.maxFrames !== 'number') throw new Error('INVALID_SOURCE_CONFIG');
      const isSui = command.endsWith('sui'), following = command.startsWith('follow-');
      const from = following ? config.start : isSui ? config.fromCheckpoint : config.fromBlock, to = isSui ? config.toCheckpoint : config.toBlock;
      if (typeof from !== 'string' || (!following && typeof to !== 'string') || (isSui ? typeof config.expectedChainIdentifier !== 'string' : !Array.isArray(config.pools))) throw new Error('INVALID_SOURCE_CONFIG');
      const journal = new SourceJournal(config.journalPath, { sourceId: config.sourceId, chain: isSui ? 'sui' : evmProfile(Number(config.network)).key, network: config.network, chainIdentifier: isSui ? config.expectedChainIdentifier as string : config.network });
      const read = async (height: string) => {
        if (isSui) {
          const checkpoint = await readSuiCheckpoint(config.rpcUrl as string, config.network as 'mainnet' | 'testnet' | 'localnet', height, config.expectedChainIdentifier as string);
          return { identity: { chain: 'sui' as const, network: checkpoint.network, height, checkpointDigest: checkpoint.checkpointDigest }, parentDigest: checkpoint.previousCheckpointDigest, payload: checkpoint };
        }
        const capture = await readArbitrumV2Snapshot(config.rpcUrl as string, config.sourceId as string, config.pools as V2SourcePool[], height, height);
        return { identity: capture.snapshot.identity, parentDigest: height === '0' ? null : capture.parentHash, payload: { pools: capture.pools, stateDigest: capture.snapshot.stateDigest } };
      };
      if (following) {
        if (typeof config.maxGap !== 'number' || typeof config.pollIntervalMs !== 'number' || typeof config.maxIdlePolls !== 'number') throw new Error('INVALID_SOURCE_CONFIG');
        const controller = new AbortController(), stop = () => controller.abort();
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        try {
          const result = await followSource(journal, { start: from, maxFrames: config.maxFrames, maxGap: config.maxGap, pollIntervalMs: config.pollIntervalMs, maxIdlePolls: config.maxIdlePolls, signal: controller.signal },
            () => isSui ? readSuiHead(config.rpcUrl as string, config.network as 'mainnet' | 'testnet' | 'localnet', config.expectedChainIdentifier as string) : readArbitrumHead(config.rpcUrl as string, config.network as string), read,
            async frame => { console.log(JSON.stringify({ schemaVersion: '3.0', status: 'source-frame-committed', identity: frame.identity })); });
          console.log(JSON.stringify({ schemaVersion: '3.0', ...result }));
        } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      } else {
        const result = await ingestSourceRange(journal, from, to as string, config.maxFrames, read);
        console.log(JSON.stringify({ schemaVersion: '3.0', status: 'source-range-committed', ...result }));
      }
    } else if (command === 'checkpoint-sui') {
      if (typeof config.checkpoint !== 'string' || typeof config.expectedChainIdentifier !== 'string' || !['mainnet', 'testnet', 'localnet'].includes(String(config.network))) throw new Error('INVALID_SOURCE_CONFIG');
      console.log(JSON.stringify(await readSuiCheckpoint(config.rpcUrl, config.network as 'mainnet' | 'testnet' | 'localnet', config.checkpoint, config.expectedChainIdentifier)));
    } else throw new Error('UNSUPPORTED_COMMAND');
  }
}
void main().catch(e => { if(e&&typeof e==='object'&&'code' in e&&e.code==='SCHEMA_INVALID_ARTIFACT'){console.error(JSON.stringify({code:e.code,message:'Evidence schema validation failed'}));process.exitCode=1;return;} console.error(e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'SOURCE_READ_FAILED'); process.exitCode = 1; });
