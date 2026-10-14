import { readFile } from 'node:fs/promises';
import { readArbitrumHead, readArbitrumV2Snapshot, readSuiCheckpoint, readSuiHead, SOURCE_CAPABILITIES, type V2SourcePool } from './sources.js';
import { parseSnapshot, SnapshotStore } from './state.js';
import { followSource, ingestSourceRange, readSourceLines, SourceJournal } from './ingestion.js';
import { recoverSuiCheckpointState } from './sui-state.js';

async function main(): Promise<void> {
  const [command, path] = process.argv.slice(2);
  if (command === 'sources') { console.log(JSON.stringify(SOURCE_CAPABILITIES)); return; }
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
      const journal = new SourceJournal(config.journalPath, { sourceId: config.sourceId, chain: isSui ? 'sui' : 'arbitrum', network: config.network, chainIdentifier: isSui ? config.expectedChainIdentifier as string : config.network });
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
void main().catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'SOURCE_READ_FAILED'); process.exitCode = 1; });
