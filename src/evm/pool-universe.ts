import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { encodeFunctionData, keccak256, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { evmProfile } from '../evm-chains.js';
import { digest } from '../liquidity/state.js';
import { poolPrice, type PoolStateEnvelope } from '../liquidity/projection.js';

/** Dynamic pool universe: flashloan MCP inventory (discovery only) → on-chain verification at one pinned block. */
export type PoolAdapter = 'UNISWAP_V3' | 'ALGEBRA' | 'UNISWAP_V2';
export type RejectReason = 'NOT_ELIGIBLE' | 'WRONG_CHAIN' | 'NOT_EVM_CONTRACT' | 'NO_CODE' | 'UNSUPPORTED_ADAPTER' | 'FACTORY_UNKNOWN'
  | 'TOKEN_MISMATCH' | 'DECIMALS_UNREADABLE' | 'ZERO_LIQUIDITY' | 'DENYLISTED' | 'DUPLICATE' | 'PAIR_CAP' | 'SINGLE_POOL_PAIR';
export interface FlashLender { kind: 'BALANCER_V2' | 'AAVE_V3' | 'UNISWAP_V3_FLASH' | 'MORPHO' | 'UNISWAP_V4'; address: Address }
export interface AssetPolicy {
  schemaVersion: 'asset-policy/1'; chainId: number; maxInventoryAgeSeconds: number; universeTtlSeconds: number; maxPairs: number;
  denylist: Address[];
  assets: Record<string, { symbol: string; usdFeed: Address | null; flashLenders: FlashLender[] }>;
  /** Factory allowlist: a pool's own factory() must match, so a provider label can never pick the venue. V2 forks need feePips. */
  factories: Record<string, { venue: string; adapter: PoolAdapter; feePips?: number; directionalFee?: boolean }>;
  /** Venue ids of the deployed DexPair executor; dynamic arb fails closed until verifiedBlock is recorded. */
  executorVenues?: { verifiedBlock: string | null; evidence: string; map: Record<string, number> };
}
export interface InventoryPool {
  id: string; reference: { kind: string; chainId?: number; address?: string }; asset_ids: string[]; protocol: string;
  liquidity_usd: string; liquidity_eligible: boolean;
}
export interface Inventory {
  schema_version: 'flashloan.inventory.v2' | 'flashloan.inventory.v3'; network: string; observed_at: string; pools: InventoryPool[];
  coverage?: Array<{ source: string; exhaustive: boolean }>;
}
export interface UniversePool {
  poolId: string; address: Address; adapter: PoolAdapter; venue: string; factory: Address; token0: Address; token1: Address;
  feePips: number; tickSpacing: number | null; runtimeCodeHash: Hex;
  verifiedState: { blockNumber: string; sqrtPriceX96?: string; liquidity?: string; reserve0?: string; reserve1?: string };
  mcpPoolId: string; liquidityUsdHint: string;
}
export interface UniverseAsset { address: Address; symbol: string | null; decimals: number; usdFeed: Address | null; flashLenders: FlashLender[] }
export interface PoolUniverse {
  schemaVersion: 'pool-universe/1'; chainId: number; network: string;
  identity: { blockNumber: string; blockHash: Hex; timestamp: number };
  source: { inventoryDigest: string; observedAt: string; exhaustive: boolean; providers: string[] };
  expiresAt: string; assets: UniverseAsset[]; pools: UniversePool[];
  pairs: Array<{ token0: Address; token1: Address; poolIds: string[] }>;
  candidatePairs: Array<{ token0: Address; token1: Address; liquidityUsdHint: string }>;
  rejected: Array<{ address: string; reason: RejectReason }>;
}
/** Minimal read port at one pinned block; `call` returns undefined on revert. Injected so tests need no RPC. */
export interface UniverseReader {
  block(): Promise<{ number: bigint; hash: Hex; timestamp: bigint }>;
  code(address: Address): Promise<Hex | undefined>;
  call(to: Address, data: Hex): Promise<Hex | undefined>;
}

const ABI = parseAbi([
  'function token0() view returns(address)', 'function token1() view returns(address)', 'function factory() view returns(address)',
  'function fee() view returns(uint24)', 'function tickSpacing() view returns(int24)', 'function liquidity() view returns(uint128)',
  'function slot0() view returns(uint160)', 'function globalState() view returns(uint160)', 'function getReserves() view returns(uint112,uint112)',
  'function decimals() view returns(uint8)'
]);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const lower = (value: string) => value.toLowerCase() as Address;

/** inventory.v3 is accepted only when the v7 integration gate passes it explicitly; default parsing is unchanged. */
export function parseInventory(input: unknown, accepted: readonly string[] = ['flashloan.inventory.v2']): Inventory {
  const envelope = input as { data?: unknown; ok?: boolean } | null;
  const data = (envelope && typeof envelope === 'object' && 'data' in envelope ? envelope.data : input) as Partial<Inventory> | null;
  if (!data || !accepted.includes(String(data.schema_version)) || typeof data.network !== 'string' || !Array.isArray(data.pools)
    || typeof data.observed_at !== 'string' || Number.isNaN(Date.parse(data.observed_at)) || data.pools.length > 2048) throw new Error('INVALID_INVENTORY');
  return data as Inventory;
}
export function parseAssetPolicy(input: unknown): AssetPolicy {
  const p = input as AssetPolicy;
  if (!p || p.schemaVersion !== 'asset-policy/1' || !Number.isSafeInteger(p.chainId) || !Array.isArray(p.denylist) || typeof p.assets !== 'object' || typeof p.factories !== 'object'
    || ![p.maxInventoryAgeSeconds, p.universeTtlSeconds, p.maxPairs].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('INVALID_ASSET_POLICY');
  for (const [address, f] of Object.entries(p.factories))
    if (!ADDRESS.test(address) || !['UNISWAP_V3', 'ALGEBRA', 'UNISWAP_V2'].includes(f.adapter) || (f.adapter === 'UNISWAP_V2' && !(Number.isInteger(f.feePips) && f.feePips! > 0 && f.feePips! < 1_000_000))) throw new Error('INVALID_ASSET_POLICY');
  for (const address of [...Object.keys(p.assets), ...p.denylist]) if (!ADDRESS.test(address)) throw new Error('INVALID_ASSET_POLICY');
  return p;
}

const word = (data: Hex | undefined, index = 0): bigint | undefined => {
  if (!data || data.length < 2 + 64 * (index + 1)) return undefined;
  return BigInt(`0x${data.slice(2 + 64 * index, 2 + 64 * (index + 1))}`);
};
const asAddress = (value: bigint | undefined) => value === undefined || value >> 160n ? undefined : lower(`0x${value.toString(16).padStart(40, '0')}`);
const read = (reader: UniverseReader, to: Address, functionName: string) => reader.call(to, encodeFunctionData({ abi: ABI, functionName: functionName as never }));

/** Raw first-word reads (F5): fork-specific slot0/globalState tails (e.g. PancakeSwap uint32 feeProtocol) never break decoding. */
async function probe(reader: UniverseReader, address: Address, policy: AssetPolicy, blockNumber: string):
  Promise<{ ok: false; reason: RejectReason } | { ok: true; pool: Omit<UniversePool, 'poolId' | 'address' | 'mcpPoolId' | 'liquidityUsdHint'> }> {
  const code = await reader.code(address);
  if (!code || code === '0x') return { ok: false, reason: 'NO_CODE' };
  const factory = asAddress(word(await read(reader, address, 'factory')));
  const token0 = asAddress(word(await read(reader, address, 'token0'))), token1 = asAddress(word(await read(reader, address, 'token1')));
  if (!token0 || !token1) return { ok: false, reason: 'UNSUPPORTED_ADAPTER' };
  const known = factory ? policy.factories[factory] : undefined;
  if (!factory || !known) return { ok: false, reason: 'FACTORY_UNKNOWN' };
  const base = { factory, token0, token1, venue: known.venue, runtimeCodeHash: keccak256(code) };
  if (known.adapter === 'UNISWAP_V2') {
    const reserves = await read(reader, address, 'getReserves'), r0 = word(reserves, 0), r1 = word(reserves, 1);
    if (r0 === undefined || r1 === undefined) return { ok: false, reason: 'UNSUPPORTED_ADAPTER' };
    if (!r0 || !r1) return { ok: false, reason: 'ZERO_LIQUIDITY' };
    return { ok: true, pool: { ...base, adapter: 'UNISWAP_V2', feePips: known.feePips!, tickSpacing: null, verifiedState: { blockNumber, reserve0: r0.toString(), reserve1: r1.toString() } } };
  }
  const state = await read(reader, address, known.adapter === 'ALGEBRA' ? 'globalState' : 'slot0');
  const sqrt = word(state, 0), liquidity = word(await read(reader, address, 'liquidity')), spacing = word(await read(reader, address, 'tickSpacing'));
  // Algebra keeps its dynamic fee in globalState; Uniswap-V3 forks expose a static fee().
  // Camelot (directionalFee) keeps two fees in words 2/3; the larger one is the conservative gap floor.
  const directional = known.directionalFee ? [word(state, 2), word(state, 3)] : [word(state, 2)];
  const fee = known.adapter === 'ALGEBRA' ? (directional.some(v => v === undefined) ? undefined : directional.reduce((a, b) => a! > b! ? a : b)) : word(await read(reader, address, 'fee'));
  if (sqrt === undefined || liquidity === undefined || fee === undefined || fee >= 1_000_000n || spacing === undefined) return { ok: false, reason: 'UNSUPPORTED_ADAPTER' };
  if (!sqrt || !liquidity) return { ok: false, reason: 'ZERO_LIQUIDITY' };
  const tickSpacing = Number(BigInt.asIntN(24, spacing));
  return { ok: true, pool: { ...base, adapter: known.adapter, feePips: Number(fee), tickSpacing, verifiedState: { blockNumber, sqrtPriceX96: sqrt.toString(), liquidity: liquidity.toString() } } };
}

export async function buildPoolUniverse(inventory: Inventory, policy: AssetPolicy, reader: UniverseReader, now = Date.now(), options: { retainCycleEdges?: boolean } = {}): Promise<PoolUniverse> {
  const profile = evmProfile(policy.chainId);
  if (inventory.network !== profile.key) throw new Error('INVENTORY_CHAIN_MISMATCH');
  if (now - Date.parse(inventory.observed_at) > policy.maxInventoryAgeSeconds * 1000 || Date.parse(inventory.observed_at) > now + 60_000) throw new Error('INVENTORY_STALE');
  const block = await reader.block(), blockNumber = block.number.toString();
  const deny = new Set(policy.denylist.map(lower));
  const rejected: PoolUniverse['rejected'] = [], seen = new Set<string>(), pools: UniversePool[] = [];
  const candidates = new Map<string, { token0: Address; token1: Address; usd: number }>();
  for (const entry of inventory.pools) {
    const address = String(entry.reference?.address ?? entry.id).toLowerCase();
    const assets = (entry.asset_ids ?? []).map(lower);
    if (entry.reference?.kind !== 'evm_contract' || !ADDRESS.test(address) || assets.length !== 2 || !assets.every(a => ADDRESS.test(a))) { rejected.push({ address, reason: 'NOT_EVM_CONTRACT' }); continue; }
    if (entry.reference.chainId !== policy.chainId) { rejected.push({ address, reason: 'WRONG_CHAIN' }); continue; }
    if (seen.has(address)) { rejected.push({ address, reason: 'DUPLICATE' }); continue; }
    seen.add(address);
    if (assets.some(a => deny.has(a))) { rejected.push({ address, reason: 'DENYLISTED' }); continue; }
    if (!entry.liquidity_eligible) { rejected.push({ address, reason: 'NOT_ELIGIBLE' }); continue; }
    const usd = Number(entry.liquidity_usd) || 0, [c0, c1] = [...assets].sort();
    const key = `${c0}:${c1}`, prior = candidates.get(key);
    candidates.set(key, { token0: c0 as Address, token1: c1 as Address, usd: (prior?.usd ?? 0) + usd });
    const result = await probe(reader, address as Address, policy, blockNumber);
    if (!result.ok) { rejected.push({ address, reason: result.reason }); continue; }
    // Token order comes from the pool, never from asset_ids (the queried token is listed first).
    if (new Set([result.pool.token0, result.pool.token1, ...assets]).size !== 2) { rejected.push({ address, reason: 'TOKEN_MISMATCH' }); continue; }
    pools.push({ poolId: `${result.pool.adapter.toLowerCase()}:${address}`, address: address as Address, ...result.pool, mcpPoolId: entry.id, liquidityUsdHint: String(entry.liquidity_usd) });
  }
  const decimals = new Map<Address, number | undefined>();
  const tokens = new Set<Address>([...pools.flatMap(p => [p.token0, p.token1]), ...[...candidates.values()].flatMap(c => [c.token0, c.token1])]);
  for (const token of tokens) {
    const value = word(await read(reader, token, 'decimals'));
    decimals.set(token, value !== undefined && value <= 36n ? Number(value) : undefined);
  }
  const readable = (token: Address) => decimals.get(token) !== undefined;
  const kept = pools.filter(p => readable(p.token0) && readable(p.token1) || (rejected.push({ address: p.address, reason: 'DECIMALS_UNREADABLE' }), false));
  const grouped = new Map<string, UniversePool[]>();
  for (const pool of kept) grouped.set(`${pool.token0}:${pool.token1}`, [...(grouped.get(`${pool.token0}:${pool.token1}`) ?? []), pool]);
  const hint = (list: UniversePool[]) => list.reduce((sum, p) => sum + (Number(p.liquidityUsdHint) || 0), 0);
  const ranked = [...grouped.values()].filter(list => list.length >= 2).sort((a, b) => hint(b) - hint(a));
  for (const list of ranked.slice(policy.maxPairs)) for (const pool of list) rejected.push({ address: pool.address, reason: 'PAIR_CAP' });
  for (const list of grouped.values()) if (list.length < 2 && !options.retainCycleEdges) rejected.push({ address: list[0].address, reason: 'SINGLE_POOL_PAIR' });
  const pairs = ranked.slice(0, policy.maxPairs).map(list => ({ token0: list[0].token0, token1: list[0].token1, poolIds: list.map(p => p.poolId) }));
  const used = new Set([...pairs.flatMap(p => p.poolIds), ...(options.retainCycleEdges ? [...grouped.values()].filter(list=>list.length===1).map(list=>list[0].poolId) : [])]);
  const candidatePairs = [...candidates.values()].filter(c => readable(c.token0) && readable(c.token1)).sort((a, b) => b.usd - a.usd)
    .map(c => ({ token0: c.token0, token1: c.token1, liquidityUsdHint: c.usd.toFixed(2) }));
  const assetSet = new Set<Address>([...kept.filter(p => used.has(p.poolId)).flatMap(p => [p.token0, p.token1]), ...candidatePairs.flatMap(c => [c.token0, c.token1])]);
  const assets: UniverseAsset[] = [];
  for (const address of [...assetSet].sort()) {
    const configured = Object.entries(policy.assets).find(([key]) => lower(key) === address)?.[1];
    const feed = configured?.usdFeed ? lower(configured.usdFeed) : null;
    // A feed without code is dropped rather than trusted; the asset can still be a target but never a flash/profit asset.
    const feedCode = feed ? await reader.code(feed) : undefined;
    assets.push({ address, symbol: configured?.symbol ?? null, decimals: decimals.get(address)!, usdFeed: feed && feedCode && feedCode !== '0x' ? feed : null,
      flashLenders: (configured?.flashLenders ?? []).map(l => ({ kind: l.kind, address: lower(l.address) })) });
  }
  return {
    schemaVersion: 'pool-universe/1', chainId: policy.chainId, network: profile.key,
    identity: { blockNumber, blockHash: block.hash.toLowerCase() as Hex, timestamp: Number(block.timestamp) },
    source: { inventoryDigest: digest(inventory), observedAt: inventory.observed_at, exhaustive: (inventory.coverage ?? []).every(c => c.exhaustive) && (inventory.coverage ?? []).length > 0,
      providers: [...new Set((inventory.coverage ?? []).map(c => c.source))].slice(0, 16) },
    expiresAt: new Date((Number(block.timestamp) + policy.universeTtlSeconds) * 1000).toISOString(),
    assets, pools: kept.filter(p => used.has(p.poolId)), pairs, candidatePairs, rejected
  };
}

/** `screen` marks an infinitesimal necessary condition only: a gap ranks a pair, never evaluates a candidate (v6 P07). */
export interface PairGap { token0: Address; token1: Address; buyPool: string; sellPool: string; gapBps: number; feeFloorBps: number; screen: 'INFINITESIMAL_NECESSARY' }
/** Decimal- and orientation-correct price gaps (token1 per token0) between every pool pair of each verified pair. */
export function pairGaps(universe: PoolUniverse, states: Record<string, UniversePool['verifiedState']> = {}): PairGap[] {
  const decimals = new Map(universe.assets.map(a => [a.address, a.decimals]));
  const byId = new Map(universe.pools.map(p => [p.poolId, p]));
  const price = (pool: UniversePool) => {
    const state = states[pool.poolId] ?? pool.verifiedState;
    const math = pool.adapter === 'UNISWAP_V2' ? { protocol: 'uniswap-v2', reserve0: state.reserve0, reserve1: state.reserve1 } : { protocol: 'uniswap-v3', sqrtPriceX96: state.sqrtPriceX96 };
    const value = poolPrice({ decimals0: decimals.get(pool.token0), decimals1: decimals.get(pool.token1), state: math } as unknown as PoolStateEnvelope);
    return [BigInt(value.numerator), BigInt(value.denominator)] as const;
  };
  const gaps: PairGap[] = [];
  for (const pair of universe.pairs) {
    const list = pair.poolIds.map(id => byId.get(id)!).filter(Boolean);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [na, da] = price(list[i]), [nb, db] = price(list[j]), a = na * db, b = nb * da;
      if (!a || !b) continue;
      const [cheap, rich] = a < b ? [list[i], list[j]] : [list[j], list[i]];
      gaps.push({ token0: pair.token0, token1: pair.token1, buyPool: cheap.poolId, sellPool: rich.poolId,
        gapBps: Number(((a > b ? a - b : b - a) * 1_000_000n) / (a < b ? a : b)) / 100, feeFloorBps: (cheap.feePips + rich.feePips) / 100, screen: 'INFINITESIMAL_NECESSARY' });
    }
  }
  return gaps.sort((x, y) => (y.gapBps - y.feeFloorBps) - (x.gapBps - x.feeFloorBps));
}

let validator: ((value: unknown) => boolean) | undefined;
export function validateUniverse(value: unknown): PoolUniverse {
  if (!validator) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    validator = ajv.compile(JSON.parse(readFileSync(new URL('../../schemas/pool-universe.schema.json', import.meta.url), 'utf8')));
  }
  const u = value as PoolUniverse;
  if (!validator(value) || Number.isNaN(Date.parse(u.expiresAt)) || Number.isNaN(Date.parse(u.source.observedAt))) throw new Error('INVALID_POOL_UNIVERSE');
  return value as PoolUniverse;
}
/** Consumers fail closed on schema, chain or expiry mismatch. */
export async function loadPoolUniverse(path: string, chainId: number, now = Date.now()): Promise<PoolUniverse> {
  const universe = validateUniverse(JSON.parse(await readFile(path, 'utf8')));
  if (universe.chainId !== chainId) throw new Error('UNIVERSE_CHAIN_MISMATCH');
  if (Date.parse(universe.expiresAt) <= now) throw new Error('UNIVERSE_EXPIRED');
  return universe;
}

export function viemUniverseReader(client: PublicClient, blockNumber?: bigint): UniverseReader {
  let pinned: bigint | undefined = blockNumber;
  return {
    async block() { const b = pinned === undefined ? await client.getBlock({ blockTag: 'latest' }) : await client.getBlock({ blockNumber: pinned }); pinned = b.number; return { number: b.number, hash: b.hash, timestamp: b.timestamp }; },
    async code(address) { return client.getCode({ address, blockNumber: pinned }); },
    async call(to, data) { try { return (await client.call({ to, data, blockNumber: pinned })).data; } catch { return undefined; } }
  };
}

export interface RouteProbe { pair: [Address, Address]; flashAsset: Address; buyPool: string; sellPool: string; outcome: string }
const EXECUTOR_ERRORS = parseAbi(['error Unauthorized()', 'error Busy()', 'error InvalidRoute()', 'error Expired()', 'error UntrustedRoot()', 'error CallbackOnly()',
  'error InsufficientOutput()', 'error Unprofitable()', 'error TransferFailed()', 'error HooksDisabled()']);
const VENUE_VERSION: Record<PoolAdapter, number> = { UNISWAP_V2: 2, UNISWAP_V3: 3, ALGEBRA: 5 };
const MIN_SQRT = 4295128740n, MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
/** Read-only dry run of two-leg cycles through a deployed MultiVenueArbitrageExecutor (eth_call from its owner; never signs).
 * `Unprofitable` means both swaps, callbacks and repayment ran and the cycle simply has no edge at this size. */
export async function probeUniverseRoutes(client: PublicClient, universe: PoolUniverse, executor: Address, lender: { kind: 1 | 2; address: Address }, amounts: Record<string, bigint>): Promise<RouteProbe[]> {
  const { MULTI_LENDER_ROUTE_ABI } = await import('../liquidity/arbitrum.js');
  const { decodeErrorResult } = await import('viem');
  const owner = await client.readContract({ address: executor, abi: parseAbi(['function owner() view returns(address)']), functionName: 'owner' });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300), byId = new Map(universe.pools.map(p => [p.poolId, p]));
  const leg = (pool: UniversePool, tokenIn: Address, tokenOut: Address) => ({ venueVersion: VENUE_VERSION[pool.adapter], root: pool.factory, pool: pool.address, tokenIn, tokenOut,
    minAmountOut: 1n, fee: pool.feePips, sqrtPriceLimitX96: tokenIn < tokenOut ? MIN_SQRT : MAX_SQRT, tickSpacing: pool.tickSpacing ?? 0, hooks: '0x0000000000000000000000000000000000000000' as Address, hookData: '0x' as Hex });
  const probes: RouteProbe[] = [];
  for (const pair of universe.pairs) for (const flash of [pair.token0, pair.token1].filter(t => amounts[t] !== undefined)) {
    const other = flash === pair.token0 ? pair.token1 : pair.token0;
    const pools = pair.poolIds.map(id => byId.get(id)!).filter(Boolean);
    for (const buy of pools) for (const sell of pools) {
      if (buy === sell) continue;
      const base = { pair: [pair.token0, pair.token1] as [Address, Address], flashAsset: flash, buyPool: buy.poolId, sellPool: sell.poolId };
      // V2 legs need the exact requested output, which a dry-run probe does not model.
      if (buy.adapter === 'UNISWAP_V2' || sell.adapter === 'UNISWAP_V2') { probes.push({ ...base, outcome: 'SKIPPED_V2_EXACT_OUTPUT' }); continue; }
      const data = encodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI, functionName: 'executeLenderArbitrage', args: [{ kind: lender.kind, lender: lender.address, flashAsset: flash,
        flashAmount: amounts[flash], legs: [leg(buy, flash, other), leg(sell, other, flash)], minProfit: 0n, deadline }] } as never);
      let outcome = 'SIMULATED_PROFITABLE';
      try { await client.call({ account: owner, to: executor, data }); }
      catch (error) {
        const raw = (error as { walk?: (f: (e: unknown) => boolean) => { data?: Hex } | null }).walk?.(e => typeof (e as { data?: unknown })?.data === 'string')?.data;
        try { outcome = raw ? decodeErrorResult({ abi: EXECUTOR_ERRORS, data: raw }).errorName : 'REVERTED'; } catch { outcome = 'REVERTED'; }
      }
      probes.push({ ...base, outcome });
    }
  }
  return probes;
}

/**
 * Per-token inventory outcomes for candidate-ledger/1 (v6 §4.2 R5). A token kept in a verified pair has no
 * outcome here; it must still reach an evaluated route. PAIR_CAP is a budget deferral, not a rejection.
 */
export function universeTokenOutcomes(inventory: Inventory, universe: PoolUniverse): Record<string, { outcome: 'REJECTED' | 'DEFERRED_BUDGET'; stage: 'inventory'; reason_code: RejectReason }> {
  const kept = new Set(universe.pairs.flatMap(p => [p.token0, p.token1]).map(lower)), reasons = new Map(universe.rejected.map(r => [r.address, r.reason]));
  const out: Record<string, { outcome: 'REJECTED' | 'DEFERRED_BUDGET'; stage: 'inventory'; reason_code: RejectReason }> = {};
  for (const entry of inventory.pools) {
    const reason = reasons.get(String(entry.reference?.address ?? entry.id).toLowerCase());
    if (!reason) continue;
    for (const token of (entry.asset_ids ?? []).map(lower)) if (!kept.has(token) && !out[token])
      out[token] = { outcome: reason === 'PAIR_CAP' ? 'DEFERRED_BUDGET' : 'REJECTED', stage: 'inventory', reason_code: reason };
  }
  return out;
}
