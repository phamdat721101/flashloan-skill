import { createPublicClient, http, keccak256, parseAbi, type Address } from 'viem';
import { GrpcTypes, SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { SuiVersionedRef } from './sui-state.js';
import { digest, isSuiDigest, parseSnapshot, parseStateIdentity, uint, type LiquiditySnapshot } from './state.js';

export interface V2SourcePool { address: Address; expectedCodeHash: `0x${string}` }
export interface V2PoolObservation { poolId: string; token0: Address; token1: Address; reserve0: string; reserve1: string; runtimeCodeHash: string }
export interface SuiCheckpointObservation {
  schemaVersion: '3.0'; chain: 'sui'; network: 'mainnet' | 'testnet' | 'localnet'; chainIdentifier: string;
  checkpoint: string; checkpointDigest: string; previousCheckpointDigest: string | null;
  contentsDigest: string;
  committedTransactions: Array<{ digest: string; effectsDigest: string }>;
  transactions: Array<{ digest: string; effectsDigest: string; changes: Array<{ objectId: string; outputVersion: string | null; outputDigest: string | null; outputState: 'object-write' | 'package-write' | 'deleted' | 'accumulator-write' | 'unknown' }> }>;
}
export const SOURCE_CAPABILITIES = [
  { id: 'arbitrum-v2-rpc', chain: 'arbitrum', implemented: true, capabilities: ['block-pinned-v2-state'], recovery: 'complete-reread' },
  { id: 'sui-checkpoint-grpc', chain: 'sui', implemented: true, capabilities: ['checkpoint-effects', 'historical-point-lookup'], recovery: 'checkpoint-backfill' },
  { id: 'arbitrum-standard-feed', chain: 'arbitrum', implemented: false, capabilities: ['ordered-block-messages'], recovery: 'node-reconciliation' },
  { id: 'arbitrum-fast-feed', chain: 'arbitrum', implemented: false, capabilities: ['early-executed-transactions'], recovery: 'standard-feed-reconciliation' },
  { id: 'sui-graphql', chain: 'sui', implemented: false, capabilities: ['indexed-discovery'], recovery: 'indexed-watermark' },
  { id: 'sui-archive', chain: 'sui', implemented: false, capabilities: ['historical-backfill'], recovery: 'checkpoint-backfill' }
] as const;
const poolAbi = parseAbi(['function token0() view returns(address)', 'function token1() view returns(address)', 'function getReserves() view returns(uint112,uint112,uint32)']);
function endpoint(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('INSECURE_SOURCE_ENDPOINT');
  return url;
}

/** Heads are scheduling hints only; eligible state is re-read at exact heights. */
export async function readArbitrumHead(url: string, network: string): Promise<string> {
  if (!['42161', '421614'].includes(network)) throw new Error('UNSUPPORTED_NETWORK');
  const client = createPublicClient({ transport: http(endpoint(url), { timeout: 15000, retryCount: 0 }) });
  if (String(await client.getChainId()) !== network) throw new Error('SOURCE_CHAIN_MISMATCH');
  return (await client.getBlockNumber({ cacheTime: 0 })).toString();
}

export async function readSuiHead(url: string, network: 'mainnet' | 'testnet' | 'localnet', expectedChainIdentifier: string): Promise<string> {
  const client = await pinnedSuiClient(url, network, expectedChainIdentifier);
  const info = await client.ledgerService.getServiceInfo({}, { timeout: 15000 }).response;
  if (info.chainId !== expectedChainIdentifier) throw new Error('SOURCE_CHAIN_MISMATCH');
  if (info.checkpointHeight === undefined) throw new Error('INCOMPLETE_SOURCE_HEAD');
  return uint(info.checkpointHeight.toString(), 64).toString();
}

/** Capture every pool at one block and verify that block still has the same hash. No signer. */
export async function readArbitrumV2Snapshot(url: string, sourceId: string, pools: readonly V2SourcePool[], cursor: string, blockNumber?: string): Promise<{ snapshot: LiquiditySnapshot; pools: V2PoolObservation[]; parentHash: string }> {
  uint(cursor, 64);
  if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 128) throw new Error('INVALID_SOURCE_ID');
  if (!Array.isArray(pools) || !pools.length || pools.length > 100) throw new Error('INVALID_SOURCE_POOLS');
  for (const pool of pools) {
    if (!pool || Object.keys(pool).sort().join(',') !== 'address,expectedCodeHash' || typeof pool.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(pool.address) || typeof pool.expectedCodeHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(pool.expectedCodeHash)) throw new Error('INVALID_POOL_PIN');
  }
  if (new Set(pools.map(p => p.address.toLowerCase())).size !== pools.length) throw new Error('INVALID_SOURCE_POOLS');
  if (blockNumber !== undefined) uint(blockNumber, 64);
  const client = createPublicClient({ transport: http(endpoint(url), { timeout: 15000, retryCount: 0 }) });
  const chainId = await client.getChainId();
  if (chainId !== 42161 && chainId !== 421614) throw new Error('UNSUPPORTED_CHAIN');
  const head = await client.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber: uint(blockNumber, 64) });
  if (head.number === null || !head.hash || !/^0x[0-9a-f]{64}$/.test(head.parentHash)) throw new Error('INCOMPLETE_BLOCK');
  const observed: V2PoolObservation[] = [];
  for (const pool of pools) {
    const code = await client.getCode({ address: pool.address, blockNumber: head.number });
    if (!code || keccak256(code) !== pool.expectedCodeHash) throw new Error('POOL_CODE_CHANGED');
    const [token0, token1, reserves] = await Promise.all([
      client.readContract({ address: pool.address, abi: poolAbi, functionName: 'token0', blockNumber: head.number }),
      client.readContract({ address: pool.address, abi: poolAbi, functionName: 'token1', blockNumber: head.number }),
      client.readContract({ address: pool.address, abi: poolAbi, functionName: 'getReserves', blockNumber: head.number })
    ]);
    observed.push({ poolId: `arbitrum:${chainId}:${pool.address.toLowerCase()}`, token0, token1, reserve0: reserves[0].toString(), reserve1: reserves[1].toString(), runtimeCodeHash: pool.expectedCodeHash });
  }
  const final = await client.getBlock({ blockNumber: head.number });
  if (final.hash !== head.hash) throw new Error('BLOCK_REORG');
  return { snapshot: parseSnapshot({ schemaVersion: '3.0', identity: { chain: 'arbitrum', network: String(chainId), height: head.number.toString(), blockHash: head.hash }, sourceId, cursor, complete: true, observedAtMs: Date.now(), poolIds: observed.map(p => p.poolId), stateDigest: digest(observed) }), pools: observed, parentHash: head.parentHash };
}

/** Checkpoint-local effects, never incorrectly pairing latest objects with an unrelated checkpoint. */
export async function readSuiCheckpoint(url: string, network: 'mainnet' | 'testnet' | 'localnet', sequence: string, expectedChainIdentifier: string): Promise<SuiCheckpointObservation> {
  const sequenceNumber = uint(sequence, 64);
  const client = await pinnedSuiClient(url, network, expectedChainIdentifier);
  const result = await client.ledgerService.getCheckpoint({ checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber }, readMask: { paths: ['sequence_number', 'digest', 'summary.previous_digest', 'summary.content_digest', 'contents.digest', 'contents.transactions', 'transactions.digest', 'transactions.effects.digest', 'transactions.effects.changed_objects'] } }, { timeout: 15000 }).response;
  const cp = result.checkpoint;
  if (!cp || cp.sequenceNumber?.toString() !== sequence || !cp.digest) throw new Error('INCOMPLETE_CHECKPOINT');
  parseStateIdentity({ chain: 'sui', network, height: sequence, checkpointDigest: cp.digest });
  const previousCheckpointDigest = cp.summary?.previousDigest ?? null;
  if (sequenceNumber !== 0n && !isSuiDigest(previousCheckpointDigest)) throw new Error('INCOMPLETE_CHECKPOINT_PARENT');
  if (!cp.contents?.digest || cp.contents.digest !== cp.summary?.contentDigest || cp.contents.transactions.length !== cp.transactions.length) throw new Error('INCOMPLETE_CHECKPOINT_CONTENTS');
  const committedTransactions = cp.contents.transactions.map(entry => {
    if (!entry.transaction || !entry.effects) throw new Error('INCOMPLETE_CHECKPOINT_COMMITMENT');
    return { digest: entry.transaction, effectsDigest: entry.effects };
  });
  const committed = new Map(committedTransactions.map(entry => [entry.digest, entry.effectsDigest]));
  if (committed.size !== committedTransactions.length) throw new Error('DUPLICATE_CHECKPOINT_TRANSACTION');
  const returned = new Set<string>();
  const transactions = cp.transactions.map(tx => {
    if (!tx.digest || !tx.effects?.digest || committed.get(tx.digest) !== tx.effects.digest || returned.has(tx.digest)) throw new Error('INCOMPLETE_TRANSACTION_EFFECTS');
    returned.add(tx.digest);
    return { digest: tx.digest, effectsDigest: tx.effects.digest, changes: tx.effects.changedObjects.map(o => {
      if (!o.objectId) throw new Error('INCOMPLETE_OBJECT_CHANGE');
      const states = GrpcTypes.ChangedObject_OutputObjectState;
      const outputState: SuiCheckpointObservation['transactions'][number]['changes'][number]['outputState'] = o.outputState === states.OBJECT_WRITE ? 'object-write' : o.outputState === states.PACKAGE_WRITE ? 'package-write' : o.outputState === states.DOES_NOT_EXIST ? 'deleted' : o.outputState === states.ACCUMULATOR_WRITE ? 'accumulator-write' : 'unknown';
      return { objectId: o.objectId, outputVersion: o.outputVersion?.toString() ?? null, outputDigest: o.outputDigest ?? null, outputState };
    }) };
  });
  return { schemaVersion: '3.0', chain: 'sui', network, chainIdentifier: expectedChainIdentifier, checkpoint: sequence, checkpointDigest: cp.digest, previousCheckpointDigest, contentsDigest: cp.contents.digest, committedTransactions, transactions };
}

async function pinnedSuiClient(url: string, network: 'mainnet' | 'testnet' | 'localnet', expectedChainIdentifier: string): Promise<SuiGrpcClient> {
  if (!['mainnet', 'testnet', 'localnet'].includes(network)) throw new Error('UNSUPPORTED_NETWORK');
  // The current gRPC service returns the full Base58 genesis digest, not the
  // legacy JSON-RPC client's shortened hexadecimal chain identifier.
  if (!isSuiDigest(expectedChainIdentifier)) throw new Error('CHAIN_IDENTIFIER_REQUIRED');
  const client = new SuiGrpcClient({ baseUrl: endpoint(url), network });
  const info = await client.ledgerService.getServiceInfo({}, { timeout: 15000 }).response;
  if (info.chainId !== expectedChainIdentifier) throw new Error('SOURCE_CHAIN_MISMATCH');
  return client;
}

/** Resolve only checkpoint-proven versions. No fallback to a latest object is permitted. */
export async function readSuiPinnedObjects(url: string, network: 'mainnet' | 'testnet' | 'localnet', expectedChainIdentifier: string, refs: readonly SuiVersionedRef[]): Promise<Array<SuiVersionedRef & { objectType: string; objectBcsBase64: string }>> {
  if (!refs.length || refs.length > 100 || new Set(refs.map(ref => ref.objectId)).size !== refs.length) throw new Error('INVALID_PINNED_OBJECT_SET');
  for (const ref of refs) {
    if (!/^0x[0-9a-f]{64}$/.test(ref.objectId) || !isSuiDigest(ref.digest) || uint(ref.version, 64) === 0n) throw new Error('INVALID_PINNED_OBJECT_REF');
  }
  const client = await pinnedSuiClient(url, network, expectedChainIdentifier), output = [];
  for (const ref of refs) {
    const result = await client.ledgerService.getObject({ objectId: ref.objectId, version: uint(ref.version, 64), readMask: { paths: ['object_id', 'version', 'digest', 'object_type', 'bcs'] } }, { timeout: 15000 }).response;
    const object = result.object;
    if (!object?.objectId || normalizeSuiAddress(object.objectId) !== ref.objectId || object.version?.toString() !== ref.version || object.digest !== ref.digest || !object.objectType || !object.bcs?.value?.length || object.bcs.value.length > 4 * 1024 * 1024) throw new Error('PINNED_OBJECT_MISMATCH_OR_INCOMPLETE');
    output.push({ ...ref, objectType: object.objectType, objectBcsBase64: Buffer.from(object.bcs.value).toString('base64') });
  }
  return output;
}
