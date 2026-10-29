import { encodeAbiParameters, keccak256, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { deriveV4PoolId, type V4PoolKey } from '../state-adapters.js';
import type { AnalyticsPoolConfig } from '../liquidity/sources.js';
import type { LiquiditySnapshot } from '../liquidity/state.js';
import { discoveryTickWindow } from './discovery.js';
import { EVM_PROFILES, type EvmChainId } from '../evm-chains.js';
import { domainHash, IntegrationError, sha256Bytes, validateIntegration, type RoundCounters } from '../evidence/integration.js';

/** SK-01: canonical v4 identity is (chain, PoolManager, poolId, PoolKey); a 32-byte poolId is never an EVM contract address. */
export const ZERO = '0x0000000000000000000000000000000000000000' as const;
export const INITIALIZE_EVENT = parseAbiItem('event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)');
const POOLS_SLOT = 6n;
export const v4PoolStateSlot = (id: Hex, offset = 0n) => `0x${(BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, POOLS_SLOT]))) + offset).toString(16).padStart(64, '0')}` as Hex;

export interface InitializeFact { id: Hex; key: V4PoolKey; tick: number; blockNumber: bigint; blockHash: Hex }
export interface V4Reader {
  block(n?: bigint): Promise<{ number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint }>;
  codeHash(address: Address, block: bigint): Promise<Hex | null>;
  initializeLogs(manager: Address, ids: Hex[] | null, from: bigint, to: bigint): Promise<InitializeFact[]>;
  extsload(manager: Address, slot: Hex, block: bigint): Promise<bigint>;
  decimals(token: Address, block: bigint): Promise<number>;
}
export function viemV4Reader(client: PublicClient): V4Reader {
  const erc20 = parseAbi(['function decimals() view returns(uint8)']), ext = parseAbi(['function extsload(bytes32) view returns(bytes32)']);
  return {
    async block(n) { const b = await client.getBlock(n === undefined ? { blockTag: 'latest' } : { blockNumber: n }); return { number: b.number!, hash: b.hash!, parentHash: b.parentHash, timestamp: b.timestamp }; },
    async codeHash(address, blockNumber) { const code = await client.getCode({ address, blockNumber }); return code && code !== '0x' ? keccak256(code) : null; },
    async initializeLogs(manager, ids, fromBlock, toBlock) {
      const logs = await client.getLogs({ address: manager, event: INITIALIZE_EVENT, args: ids ? { id: ids } : undefined, fromBlock, toBlock, strict: true });
      return logs.map(l => ({ id: l.args.id, tick: l.args.tick, blockNumber: l.blockNumber, blockHash: l.blockHash,
        key: { currency0: l.args.currency0.toLowerCase() as Address, currency1: l.args.currency1.toLowerCase() as Address, fee: l.args.fee, tickSpacing: l.args.tickSpacing, hooks: l.args.hooks.toLowerCase() as Address } }));
    },
    async extsload(address, slot, blockNumber) { return BigInt(await client.readContract({ address, abi: ext, functionName: 'extsload', args: [slot], blockNumber })); },
    async decimals(address, blockNumber) { return Number(await client.readContract({ address, abi: erc20, functionName: 'decimals', blockNumber })); }
  };
}

/** Bounded paged Initialize scan shared with discovery; ids=null scans every pool. Every page charges the round counters. */
export async function readV4Initialize(reader: V4Reader, manager: Address, ids: Hex[] | null, range: { from: bigint; to: bigint; pageSize?: bigint }, counters?: RoundCounters) {
  const found = new Map<Hex, InitializeFact>(), want = ids && new Set(ids.map(i => i.toLowerCase()));
  const page = range.pageSize ?? 250n;
  if (page < 1n || range.from < 0n || range.to < range.from) throw new Error('DISCOVERY_RANGE_LIMIT');
  for (let start = range.from; start <= range.to; start += page) {
    if (want && found.size === want.size) break;
    const end = start + page - 1n < range.to ? start + page - 1n : range.to;
    counters?.charge('rpc');
    let logs;
    try { logs = await reader.initializeLogs(manager, want ? [...want].filter(id => !found.has(id as Hex)) as Hex[] : null, start, end); }
    catch { throw new Error('DISCOVERY_LOG_QUERY_FAILED'); }
    for (const log of logs) { const id = log.id.toLowerCase() as Hex; if ((!want || want.has(id)) && !found.has(id)) found.set(id, { ...log, id }); }
  }
  return found;
}

export interface ManagerMapping { schema: 'v4-manager-mapping/1'; chainId: string; managers: Array<{ provider: string; manager: Address; codeHash: Hex; fromBlock: string }> }
/** knownFacts: cached Initialize facts keyed `${manager}:${poolId}`. They skip the log scan only; key hash, reorg and slot0 are still re-verified every round. */
export interface ResolutionOptions { mappingBytes: Uint8Array; nativeCapability?: boolean; pageSize?: bigint; adapterRevision?: string; now?: () => Date; knownFacts?: ReadonlyMap<string, InitializeFact> }
type Unresolved = { provider: string; providerPoolId: string; reasonCode: string; nextDependency: string };
const nativeId = (chainId: string) => `${chainId}/slip44:60`;
const assetIdOf = (chainId: string, currency: string) => currency === ZERO ? nativeId(chainId) : `${chainId}/erc20:${currency}`;

/** PoolResolutionRequest -> PoolResolutionReport + verified analytics configs. Missing keys yield unresolved rows, never abort unrelated pools. */
export async function resolveV4Pools(requestInput: unknown, reader: V4Reader, counters: RoundCounters, options: ResolutionOptions) {
  const req = validateIntegration<{ roundId: string; chainId: string; references: Array<{ provider: string; providerPoolId: string; assetIds: string[] }>;
    managerMappingRef: { contentHash: string; locator: string }; atBlock: string | null }>('PoolResolutionRequest', requestInput);
  if (sha256Bytes(options.mappingBytes) !== req.managerMappingRef.contentHash) throw new IntegrationError('MANAGER_UNMAPPED', 'mapping bytes do not match managerMappingRef');
  const mapping = JSON.parse(Buffer.from(options.mappingBytes).toString('utf8')) as ManagerMapping;
  if (mapping.schema !== 'v4-manager-mapping/1' || mapping.chainId !== req.chainId) throw new IntegrationError('WRONG_CHAIN', 'manager mapping');
  const now = options.now ?? (() => new Date());
  counters.charge('rpc', 2); // head read + the final reorg check are reserved first, so an exhausted scan still yields typed rows
  const head = await reader.block(req.atBlock === null ? undefined : BigInt(req.atBlock));
  const unresolved: Unresolved[] = [], resolved: unknown[] = [], configs: AnalyticsPoolConfig[] = [], seen = new Set<string>(), verifiedFacts = new Map<string, InitializeFact>();
  const sources = [{ kind: 'configuration' as const, contentHash: req.managerMappingRef.contentHash, issuedAt: now().toISOString().replace(/\.\d+Z$/, 'Z'), expiresAt: null, traceId: req.roundId, locator: req.managerMappingRef.locator }];
  const byManager = new Map<string, { entry: ManagerMapping['managers'][number]; refs: typeof req.references }>();
  for (const ref of req.references) {
    const entry = mapping.managers.find(m => m.provider === ref.provider);
    if (!entry) { unresolved.push({ ...pick(ref), reasonCode: 'MANAGER_MAPPING_REQUIRED', nextDependency: `reviewed v4 manager mapping for provider ${ref.provider}` }); continue; }
    const id = ref.providerPoolId.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) { unresolved.push({ ...pick(ref), reasonCode: 'UNRESOLVED_POOL_KEY', nextDependency: 'canonical 32-byte v4 poolId from provider' }); continue; }
    const dedupe = `${req.chainId}:${entry.manager.toLowerCase()}:${id}`;
    if (seen.has(dedupe)) continue; // (chain,manager,poolId) is the identity; the first provider reference is retained
    seen.add(dedupe);
    const group = byManager.get(entry.manager.toLowerCase()) ?? { entry, refs: [] };
    group.refs.push({ ...ref, providerPoolId: id }); byManager.set(entry.manager.toLowerCase(), group);
  }
  const decimals = new Map<string, number>();
  for (const { entry, refs } of byManager.values()) {
    const manager = entry.manager.toLowerCase() as Address;
    const block = (refs: typeof req.references, reasonCode: string, nextDependency: string) => refs.forEach(r => unresolved.push({ ...pick(r), reasonCode, nextDependency }));
    let facts: Map<Hex, InitializeFact>;
    try {
      counters.charge('rpc');
      if ((await reader.codeHash(manager, head.number)) !== entry.codeHash.toLowerCase()) { block(refs, 'MANAGER_MAPPING_REQUIRED', `manager ${manager} code hash drift; re-review mapping`); continue; }
      facts = new Map();
      for (const r of refs) { const f = options.knownFacts?.get(`${manager}:${r.providerPoolId}`); if (f) facts.set(r.providerPoolId as Hex, f); }
      const unknown = refs.map(r => r.providerPoolId as Hex).filter(id => !facts.has(id));
      if (unknown.length) for (const [id, f] of await readV4Initialize(reader, manager, unknown, { from: BigInt(entry.fromBlock), to: head.number, pageSize: options.pageSize }, counters)) facts.set(id, f);
    } catch (e) {
      if (e instanceof IntegrationError) { block(refs, 'RESOLUTION_BUDGET', `${e.reason}: raise maxRpcCalls/deadline or narrow selection`); continue; }
      throw e;
    }
    for (const ref of refs) {
      const fact = facts.get(ref.providerPoolId as Hex);
      try {
        if (!fact) { block([ref], 'UNRESOLVED_POOL_KEY', `Initialize log for ${ref.providerPoolId} on ${manager} from block ${entry.fromBlock}`); continue; }
        if (safePoolId(fact.key) !== fact.id) { block([ref], 'POOL_ID_MISMATCH', 'Initialize key does not hash to the provider poolId'); continue; }
        const ids = [assetIdOf(req.chainId, fact.key.currency0), assetIdOf(req.chainId, fact.key.currency1)];
        if ([...ref.assetIds].sort().join() !== [...ids].sort().join()) { block([ref], 'POOL_ID_MISMATCH', `provider assets ${ref.assetIds.join(',')} differ from PoolKey currencies`); continue; }
        counters.charge('rpc', 2);
        if ((await reader.block(fact.blockNumber)).hash !== fact.blockHash) { block([ref], 'BLOCK_REORG', `Initialize block ${fact.blockNumber} reorged; re-resolve`); continue; }
        verifiedFacts.set(`${manager}:${fact.id}`, fact);
        const slot0 = await reader.extsload(manager, v4PoolStateSlot(fact.id), head.number);
        if ((slot0 & ((1n << 160n) - 1n)) === 0n) { block([ref], 'UNINITIALIZED_POOL', 'pool state is uninitialized at the pinned block'); continue; }
        let tick = Number((slot0 >> 160n) & 0xffffffn); if (tick >= 0x800000) tick -= 0x1000000;
        const asset = async (currency: Address) => {
          if (currency === ZERO) return { assetId: nativeId(req.chainId), chainId: req.chainId, kind: 'native' as const, address: null, decimals: 18, metadataRef: sourceRef('configuration', { chainId: req.chainId, native: true }) };
          if (!decimals.has(currency)) { counters.charge('rpc'); decimals.set(currency, await reader.decimals(currency, head.number)); }
          const d = decimals.get(currency)!;
          return { assetId: `${req.chainId}/erc20:${currency}`, chainId: req.chainId, kind: 'erc20' as const, address: currency, decimals: d, metadataRef: sourceRef('code', { chainId: req.chainId, currency, decimals: d, block: head.number.toString() }) };
        };
        const hooked = fact.key.hooks !== ZERO, dynamic = (fact.key.fee & 0x800000) !== 0, native = fact.key.currency0 === ZERO;
        const reasonCodes = [...(hooked ? ['UNSUPPORTED_HOOK'] : []), ...(dynamic ? ['UNSUPPORTED_DYNAMIC_FEE'] : []), ...(native && !options.nativeCapability ? ['UNSUPPORTED_NATIVE_CURRENCY'] : [])];
        const quote = !hooked && !dynamic, execute = quote && (!native || options.nativeCapability === true);
        const state = { chainId: req.chainId, blockNumber: head.number.toString(), blockHash: head.hash, parentHash: head.parentHash, observedAt: iso(head.timestamp), finality: 'latest' as const,
          stateDigest: domainHash('flash/v4-resolution-state/1', { manager, poolId: fact.id, slot0: slot0.toString(), block: head.hash }) };
        const pool = { schema: 'resolved-pool/1', chainId: req.chainId, protocol: 'uniswap-v4', provider: ref.provider, providerPoolId: ref.providerPoolId, manager, managerCodeHash: entry.codeHash.toLowerCase(),
          poolId: fact.id, key: fact.key, asset0: await asset(fact.key.currency0), asset1: await asset(fact.key.currency1), state,
          initializationRef: sourceRef('canonical-state', { id: fact.id, block: fact.blockNumber.toString(), hash: fact.blockHash }),
          mappingRef: sources[0], support: { read: true, quote, prepare: execute, simulate: execute, execute, reasonCodes }, sourceRefs: sources };
        resolved.push(validateIntegration('ResolvedPool', pool));
        if (quote) configs.push({ protocol: 'uniswap-v4', address: manager, expectedCodeHash: entry.codeHash.toLowerCase() as Hex, adapterRevision: options.adapterRevision ?? `v4:${entry.codeHash.toLowerCase()}`, key: fact.key, ...discoveryTickWindow(tick, fact.key.tickSpacing) });
      } catch (e) {
        if (e instanceof IntegrationError) { block([ref], 'RESOLUTION_BUDGET', `${e.reason}: raise maxRpcCalls/deadline or narrow selection`); continue; }
        throw e;
      }
    }
  }
  if ((await reader.block(head.number)).hash !== head.hash) throw new IntegrationError('STATE_CHANGED', 'resolution head reorged');
  const report = validateIntegration('PoolResolutionReport', { schema: 'pool-resolution-report/1', roundId: req.roundId, chainId: req.chainId, resolved, unresolved,
    complete: unresolved.length === 0, rpcCallsUsed: counters.rpc, sourceRefs: sources });
  return { report, configs, head, facts: verifiedFacts };

  function sourceRef(kind: 'configuration' | 'canonical-state' | 'code', value: unknown) {
    return { kind, contentHash: domainHash(`flash/v4-resolution-${kind}/1`, value), issuedAt: iso(head.timestamp), expiresAt: null, traceId: req.roundId, locator: `rpc://${req.chainId}/${head.number}` };
  }
}
/** v4-initialize-cache/1: verified Initialize facts keyed `${manager}:${poolId}`; bigints are decimal strings. A tampered entry fails re-verification, never resolves a wrong key. */
export function parseInitializeCache(raw: unknown, chainId: string): Map<string, InitializeFact> {
  const c = raw as { schema?: string; chainId?: string; facts?: Record<string, { id: Hex; key: V4PoolKey; tick: number; blockNumber: string; blockHash: Hex }> } | null;
  if (!c || c.schema !== 'v4-initialize-cache/1' || c.chainId !== chainId || typeof c.facts !== 'object') throw new IntegrationError('VERSION_UNSUPPORTED', 'v4 initialize cache');
  return new Map(Object.entries(c.facts).map(([k, f]) => [k, { ...f, blockNumber: BigInt(f.blockNumber) }]));
}
export function serializeInitializeCache(chainId: string, facts: ReadonlyMap<string, InitializeFact>) {
  const sorted = [...facts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { schema: 'v4-initialize-cache/1', chainId, facts: Object.fromEntries(sorted.map(([k, f]) => [k, { ...f, blockNumber: f.blockNumber.toString() }])) };
}
const safePoolId = (key: V4PoolKey) => { try { return deriveV4PoolId(key); } catch { return null; } };
const pick = (r: { provider: string; providerPoolId: string }) => ({ provider: r.provider, providerPoolId: r.providerPoolId });
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

/** readEvmAnalyticsSnapshot reads <=6 configs per call: batch at one pinned block and merge only on an identical block hash (review A6). */
export async function readPinnedBatches<T extends { snapshot: LiquiditySnapshot }>(configs: readonly AnalyticsPoolConfig[], blockNumber: string, maxPools: number,
  read: (batch: AnalyticsPoolConfig[], blockNumber: string) => Promise<T>, counters?: RoundCounters) {
  const take = configs.slice(0, Math.max(0, maxPools)), deferred = configs.slice(take.length), out: T[] = [];
  for (let i = 0; i < take.length; i += 6) {
    counters?.charge('rpc');
    const batch = await read(take.slice(i, i + 6), blockNumber);
    if (out.length && JSON.stringify(batch.snapshot.identity) !== JSON.stringify(out[0].snapshot.identity)) throw new IntegrationError('STATE_CHANGED', 'snapshot batches disagree on block');
    out.push(batch);
  }
  return { batches: out, deferred };
}

/** Splits v4 rows (manager+poolId) from contract-address rows; the legacy universe keeps receiving only the latter, byte-identical. */
export function partitionV4Inventory(inventory: { pools: Array<{ id: string; reference?: { kind?: string; chainId?: number; network?: string; address?: string; manager?: string; poolId?: string; providerPoolId?: string; provider?: string }; asset_ids?: string[]; labels?: string[]; protocol: string }> }, chainId: number) {
  const chain = `eip155:${chainId}`, references: Array<{ provider: string; providerPoolId: string; assetIds: string[] }> = [], legacy: typeof inventory.pools = [];
  const rejected: Array<{ providerPoolId: string; reasonCode: 'UNRESOLVED_POOL_KEY' | 'WRONG_CHAIN'; nextDependency: string }> = [];
  const assetId = (a: string) => a === ZERO || a === 'native' ? `${chain}/slip44:60` : `${chain}/erc20:${a.toLowerCase()}`;
  const networkKey = Object.hasOwn(EVM_PROFILES, chainId) ? EVM_PROFILES[chainId as EvmChainId].key : null;
  for (const row of inventory.pools) {
    // Live MCP inventory.v2 carries the v4 id in reference.providerPoolId, the chain as reference.network and v4 only in labels.
    const ref = row.reference ?? {}, id = String(ref.poolId ?? ref.providerPoolId ?? row.id).toLowerCase();
    const v4 = ref.kind === 'v4_pool' || /v4/i.test(row.protocol) || (row.labels ?? []).includes('v4') || (ref.kind === 'provider_opaque' && /^0x[0-9a-f]{64}$/.test(id));
    if (!v4) { legacy.push(row); continue; }
    if (ref.chainId !== undefined && ref.chainId !== chainId) { rejected.push({ providerPoolId: id, reasonCode: 'WRONG_CHAIN', nextDependency: `inventory row for chain ${ref.chainId}` }); continue; }
    if (ref.chainId === undefined && ref.network !== undefined && ref.network !== networkKey) { rejected.push({ providerPoolId: id, reasonCode: 'WRONG_CHAIN', nextDependency: `inventory row for network ${ref.network}` }); continue; }
    const assets = (row.asset_ids ?? []).map(a => a.toLowerCase());
    if (!/^0x[0-9a-f]{64}$/.test(id) || assets.length !== 2) { rejected.push({ providerPoolId: id, reasonCode: 'UNRESOLVED_POOL_KEY', nextDependency: 'canonical 32-byte v4 poolId and two asset ids' }); continue; }
    references.push({ provider: ref.provider ?? row.protocol, providerPoolId: id, assetIds: assets.map(assetId) });
  }
  return { references, legacy, rejected };
}
