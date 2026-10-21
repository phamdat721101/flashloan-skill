import { createPublicClient, http, keccak256, parseAbi, type Address } from 'viem';
import { GrpcTypes, SuiGrpcClient } from '@mysten/sui/grpc';
import { evmProfile } from '../evm-chains.js';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { SuiVersionedRef } from './sui-state.js';
import { decodeCetusCheckpoint, type CheckpointObjectSet, type CetusDecodeConfig, type PinnedSuiObject } from '../sui/cetus.js';
import { snapshotUniswapV3, snapshotUniswapV4, type StateClient, type V4PoolKey } from '../state-adapters.js';
import { parsePoolState, type PoolStateEnvelope } from './projection.js';
import { digest, isSuiDigest, parseSnapshot, parseStateIdentity, uint, type LiquiditySnapshot } from './state.js';

export interface V2SourcePool { address: Address; expectedCodeHash: `0x${string}` }
export interface V2PoolObservation { poolId: string; token0: Address; token1: Address; reserve0: string; reserve1: string; runtimeCodeHash: string }
export type AnalyticsPoolConfig = { address: Address; expectedCodeHash: `0x${string}`; adapterRevision: string } & (
  | { protocol: 'uniswap-v2'; feeNumerator: string; feeDenominator: string }
  | { protocol: 'uniswap-v3'; bitmapWordPositions: number[]; lowerTick: number; upperTick: number }
  | { protocol: 'uniswap-v4'; bitmapWordPositions: number[]; lowerTick: number; upperTick: number; key: V4PoolKey }
);
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
  try { evmProfile(Number(network)); } catch { throw new Error('UNSUPPORTED_NETWORK'); }
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
  const profile = evmProfile(chainId);
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
    observed.push({ poolId: `${profile.key}:${chainId}:${pool.address.toLowerCase()}`, token0, token1, reserve0: reserves[0].toString(), reserve1: reserves[1].toString(), runtimeCodeHash: pool.expectedCodeHash });
  }
  const final = await client.getBlock({ blockNumber: head.number });
  if (final.hash !== head.hash) throw new Error('BLOCK_REORG');
  return { snapshot: parseSnapshot({ schemaVersion: '3.0', identity: { chain: profile.key, network: String(chainId), height: head.number.toString(), blockHash: head.hash }, sourceId, cursor, complete: true, observedAtMs: Date.now(), poolIds: observed.map(p => p.poolId), stateDigest: digest(observed) }), pools: observed, parentHash: head.parentHash };
}

/** Common-head analytics capture. V2 fee profiles must be revision-admitted by the operator;
 * V3/V4 fees are read from their own protocol state. This capture never signs or admits a route.
 */
export async function readArbitrumAnalyticsSnapshot(url: string, sourceId: string, cursor: string, configs: readonly AnalyticsPoolConfig[], blockNumber?: string): Promise<{ snapshot: LiquiditySnapshot; pools: PoolStateEnvelope[] }> {
  uint(cursor,64); if (blockNumber !== undefined) uint(blockNumber,64);
  if (!Array.isArray(configs) || !configs.length || configs.length > 6 || typeof sourceId !== 'string' || !sourceId || sourceId.length > 128) throw new Error('INVALID_ANALYTICS_CAPTURE');
  for (const config of configs) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('INVALID_ANALYTICS_CAPTURE');
    const expected = ['address','expectedCodeHash','adapterRevision','protocol',...(config.protocol === 'uniswap-v2' ? ['feeNumerator','feeDenominator'] : config.protocol === 'uniswap-v3' ? ['bitmapWordPositions','lowerTick','upperTick'] : config.protocol === 'uniswap-v4' ? ['bitmapWordPositions','lowerTick','upperTick','key'] : [])];
    if (!config || !['uniswap-v2','uniswap-v3','uniswap-v4'].includes(config.protocol) || Object.keys(config).sort().join(',') !== expected.sort().join(',') || !/^0x[0-9a-fA-F]{40}$/.test(config.address) || !/^0x[0-9a-f]{64}$/.test(config.expectedCodeHash) || typeof config.adapterRevision !== 'string' || !config.adapterRevision || config.adapterRevision.length > 128) throw new Error('INVALID_ANALYTICS_CAPTURE');
    if (config.protocol === 'uniswap-v2') { if (!uint(config.feeNumerator,32) || uint(config.feeNumerator,32) > uint(config.feeDenominator,32)) throw new Error('V2_INVALID_STATE'); }
    else if (!Array.isArray(config.bitmapWordPositions) || config.bitmapWordPositions.length > 256) throw new Error('INVALID_ANALYTICS_CAPTURE');
  }
  const transport = http(endpoint(url), { timeout: 15000,retryCount: 0 });
  const probe = createPublicClient({ transport });
  const chainId = await probe.getChainId(); const profile = evmProfile(chainId);
  // Use viem's existing Multicall3 batching for view-only CLMM reads. Tick workers
  // stay bounded, but no longer require one provider HTTP request per tick.
  const client = createPublicClient({ chain: profile.chain,transport,batch: { multicall: { batchSize: 4096,wait: 10 } } });
  const head = await client.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber: uint(blockNumber,64) });
  if (head.number === null || !head.hash) throw new Error('INCOMPLETE_BLOCK');
  const identity = parseStateIdentity({ chain: profile.key,network: String(chainId),height: head.number.toString(),blockHash: head.hash });
  const pinned = { getChainId: () => Promise.resolve(chainId),getBlock: (args?: { blockNumber?: bigint }) => client.getBlock({ blockNumber: args?.blockNumber ?? head.number! }),getCode: client.getCode,readContract: client.readContract } as unknown as StateClient;
  const pools: PoolStateEnvelope[] = [];
  for (const config of configs) {
    const policy = { chainId,expectedRuntimeCodeHash: config.expectedCodeHash,maxBitmapWords: 256 };
    let token0: Address, token1: Address, state: PoolStateEnvelope['state'];
    if (config.protocol === 'uniswap-v2') {
      const captured = await readArbitrumV2Snapshot(url,sourceId,[{ address: config.address,expectedCodeHash: config.expectedCodeHash }],cursor,head.number.toString());
      if (digest(captured.snapshot.identity) !== digest(identity)) throw new Error('BLOCK_REORG');
      const pool = captured.pools[0]; token0 = pool.token0; token1 = pool.token1;
      state = { protocol: 'uniswap-v2',reserve0: pool.reserve0,reserve1: pool.reserve1,feeNumerator: config.feeNumerator,feeDenominator: config.feeDenominator };
    } else if (config.protocol === 'uniswap-v3') {
      const pool = await snapshotUniswapV3(pinned,config.address,config.bitmapWordPositions,policy); token0 = pool.token0; token1 = pool.token1;
      state = { protocol: 'uniswap-v3',sqrtPriceX96: pool.sqrtPriceX96,tick: pool.tick,liquidity: pool.liquidity,feePips: pool.feePips,tickSpacing: pool.tickSpacing,unlocked: pool.unlocked,bitmapWords: pool.bitmapWords,initializedTicks: pool.initializedTicks,lowerTick: config.lowerTick,upperTick: config.upperTick };
    } else {
      const pool = await snapshotUniswapV4(pinned,config.address,config.key,config.bitmapWordPositions,policy,true); token0 = config.key.currency0; token1 = config.key.currency1;
      state = { protocol: 'uniswap-v4',sqrtPriceX96: pool.sqrtPriceX96,tick: pool.tick,liquidity: pool.liquidity,tickSpacing: pool.key.tickSpacing,bitmapWords: pool.bitmapWords,initializedTicks: pool.initializedTicks,lowerTick: config.lowerTick,upperTick: config.upperTick,key: pool.key,poolId: pool.poolId,protocolFeePips: pool.protocolFeePips,lpFeePips: pool.lpFeePips };
    }
    const decimalsAbi = parseAbi(['function decimals() view returns(uint8)']);
    const tokenClient = config.protocol === 'uniswap-v2' ? probe : client;
    const [decimals0,decimals1] = await Promise.all([token0,token1].map(address => address === '0x0000000000000000000000000000000000000000' ? Promise.resolve(18) : tokenClient.readContract({ address,abi: decimalsAbi,functionName: 'decimals',blockNumber: head.number! })));
    pools.push(parsePoolState({ schemaVersion: '4.0',identity,poolId: `${profile.key}:${chainId}:${config.address.toLowerCase()}${state.protocol === 'uniswap-v4' ? `:${state.poolId}` : ''}`,poolAddress: config.address,adapterRevision: config.adapterRevision,revisionHash: config.expectedCodeHash,token0,token1,decimals0,decimals1,stateClass: 'canonical',appliedOperations: [],state }));
  }
  if (new Set(pools.map(pool => pool.poolId)).size !== pools.length) throw new Error('DUPLICATE_ANALYTICS_POOL');
  if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('BLOCK_REORG');
  return { snapshot: parseSnapshot({ schemaVersion: '3.0',identity,sourceId,cursor,observedAtMs: Date.now(),complete: true,poolIds: pools.map(pool => pool.poolId),stateDigest: digest(pools) }),pools };
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
  const client = await pinnedSuiClient(url, network, expectedChainIdentifier), output = []; let totalBytes = 0;
  for (const ref of refs) {
    const result = await client.ledgerService.getObject({ objectId: ref.objectId, version: uint(ref.version, 64), readMask: { paths: ['object_id', 'version', 'digest', 'object_type', 'bcs'] } }, { timeout: 15000 }).response;
    const object = result.object;
    if (!object?.objectId || normalizeSuiAddress(object.objectId) !== ref.objectId || object.version?.toString() !== ref.version || object.digest !== ref.digest || !object.objectType || !object.bcs?.value?.length || object.bcs.value.length > 4 * 1024 * 1024) throw new Error('PINNED_OBJECT_MISMATCH_OR_INCOMPLETE');
    totalBytes += object.bcs.value.length; if (totalBytes > 16 * 1024 * 1024) throw new Error('PINNED_OBJECT_BYTE_LIMIT');
    output.push({ ...ref, objectType: object.objectType, objectBcsBase64: Buffer.from(object.bcs.value).toString('base64') });
  }
  return output;
}

/** Explicit test/capture entry point: all object versions come from the recovered checkpoint set. */
export async function readSuiCetusAnalyticsSnapshot(url: string, sourceId: string, checkpoint: CheckpointObjectSet, configs: CetusDecodeConfig[]): Promise<{ snapshot: LiquiditySnapshot; pools: PoolStateEnvelope[]; stateRefs: SuiVersionedRef[] }> {
  const identity = parseStateIdentity(checkpoint.identity);
  if (identity.chain !== 'sui' || !Array.isArray(configs) || !configs.length || configs.length > 3 || !Array.isArray(checkpoint.objects) || checkpoint.objects.length > 1000 || checkpoint.completeForDeclaredObjectSet !== true || typeof sourceId !== 'string' || !sourceId || sourceId.length > 128) throw new Error('INVALID_CETUS_CAPTURE');
  const canonical = await readSuiCheckpoint(url,identity.network,identity.height,checkpoint.chainIdentifier);
  if (canonical.checkpointDigest !== identity.checkpointDigest) throw new Error('CHECKPOINT_RECORD_IDENTITY_MISMATCH');
  const client = await pinnedSuiClient(url,identity.network,checkpoint.chainIdentifier);
  await assertSuiReferencesAtCheckpoint(checkpoint.objects,identity.height,{
    latest: async objectId => {
      const response = await client.ledgerService.getObject({ objectId,readMask: { paths: ['object_id','version','digest','previous_transaction'] } },{ timeout: 15000 }).response;
      const value = response.object;
      if (!value?.objectId || value.version === undefined || !value.digest || !value.previousTransaction) throw new Error('CHECKPOINT_VERSION_PROOF_UNAVAILABLE');
      return { objectId: normalizeSuiAddress(value.objectId),version: value.version.toString(),digest: value.digest,previousTransaction: value.previousTransaction };
    },
    committedAt: async transactionDigest => {
      const response = await client.ledgerService.getTransaction({ digest: transactionDigest,readMask: { paths: ['digest','checkpoint'] } },{ timeout: 15000 }).response;
      if (response.transaction?.digest !== transactionDigest || response.transaction.checkpoint === undefined) throw new Error('CHECKPOINT_VERSION_PROOF_UNAVAILABLE');
      return response.transaction.checkpoint.toString();
    }
  });
  const objects: PinnedSuiObject[] = [];
  for (let offset = 0; offset < checkpoint.objects.length; offset += 100) {
    objects.push(...await readSuiPinnedObjects(url,identity.network,checkpoint.chainIdentifier,checkpoint.objects.slice(offset,offset + 100)));
    if (objects.reduce((bytes,object) => bytes + object.objectBcsBase64.length,0) > 24 * 1024 * 1024) throw new Error('CETUS_CAPTURE_BYTE_LIMIT');
  }
  const pools = configs.map(config => decodeCetusCheckpoint(checkpoint,objects,config).pool);
  if (new Set(pools.map(pool => pool.poolId)).size !== pools.length) throw new Error('DUPLICATE_ANALYTICS_POOL');
  return { snapshot: parseSnapshot({ schemaVersion: '3.0',identity,sourceId,cursor: identity.height,observedAtMs: Date.now(),complete: true,poolIds: pools.map(pool => pool.poolId),stateDigest: digest(pools) }),pools,stateRefs: structuredClone(checkpoint.objects) };
}

export interface SuiReferenceProofReader {
  latest(objectId: string): Promise<SuiVersionedRef & { previousTransaction: string }>;
  committedAt(transactionDigest: string): Promise<string>;
}
/** Conservative proof: latest must equal the supplied version, whose last mutation
 * was committed by the target checkpoint. Changed historical objects need an archive proof.
 * Latest is used only as an upper bound, never as a substitute for historical bytes.
 */
export async function assertSuiReferencesAtCheckpoint(refs: readonly SuiVersionedRef[],height: string,reader: SuiReferenceProofReader): Promise<void> {
  const checkpoint = uint(height,64), transactions = new Map<string,string>();
  if (!refs.length || refs.length > 1000 || new Set(refs.map(ref => ref.objectId)).size !== refs.length) throw new Error('INVALID_PINNED_OBJECT_SET');
  for (const ref of refs) {
    const latest = await reader.latest(ref.objectId);
    if (latest.objectId !== ref.objectId || latest.version !== ref.version || latest.digest !== ref.digest || !isSuiDigest(latest.previousTransaction)) throw new Error('CHECKPOINT_VERSION_PROOF_UNAVAILABLE');
    let committed = transactions.get(latest.previousTransaction);
    if (committed === undefined) { committed = await reader.committedAt(latest.previousTransaction); transactions.set(latest.previousTransaction,committed); }
    if (uint(committed,64) > checkpoint) throw new Error('CHECKPOINT_VERSION_PROOF_UNAVAILABLE');
  }
}

/** Unfiltered native gRPC cursor stream. Treat cursors as scheduling hints, then reconcile exact checkpoints. */
export async function* readSuiNativeCheckpoints(url: string,network: 'mainnet' | 'testnet' | 'localnet',expectedChainIdentifier: string,signal?: AbortSignal): AsyncGenerator<{ height: string; digest: string }> {
  const client = await pinnedSuiClient(url,network,expectedChainIdentifier), controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort',abort,{ once: true });
  if (signal?.aborted) controller.abort();
  try {
    const stream = client.subscriptionService.subscribeCheckpoints({ readMask: { paths: ['sequence_number','digest'] } },{ abort: controller.signal });
    for await (const frame of stream.responses) {
      if (signal?.aborted) return;
      if (frame.cursor === undefined || !frame.checkpoint || frame.checkpoint.sequenceNumber !== frame.cursor || !isSuiDigest(frame.checkpoint.digest)) throw new Error('INCOMPLETE_NATIVE_CHECKPOINT');
      yield { height: uint(frame.cursor.toString(),64).toString(),digest: frame.checkpoint.digest };
    }
    if (!signal?.aborted) throw new Error('NATIVE_CHECKPOINT_STREAM_CLOSED');
  } finally { controller.abort(); signal?.removeEventListener('abort',abort); }
}

export const readEvmHead = readArbitrumHead;
export const readEvmV2Snapshot = readArbitrumV2Snapshot;
export const readEvmAnalyticsSnapshot = readArbitrumAnalyticsSnapshot;
