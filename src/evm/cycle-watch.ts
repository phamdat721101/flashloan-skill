import { readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { evmProfile } from '../evm-chains.js';
import { atomicJson } from './storage.js';
import { clVirtualReserves, findCycles, foldCycle, hopCurve, maximizeConcave, pricedOut, refineBracket, seedPrincipal, splitAmount, TokenBandit,
  type BanditState, type Cycle, type Edge, type HopCurve, type SeedMethod } from './cycle-engine.js';
import type { V8Features } from '../evidence/integration.js';
import { deriveV4PoolId, type V4PoolKey } from '../state-adapters.js';
import { readV4Initialize, v4PoolStateSlot, viemV4Reader } from './v4-resolution.js';
import { V4_STATE_QUOTER_ABI } from '../liquidity/v4-simulation.js';
import { measureCycleGas, probeTokenBehavior, type GasLeg, type TokenBehavior } from './pool-universe.js';
import { hookAdmission } from './acceptance.js';

/** Read-only. MCP inventory -> exact per-block quotes -> cycle search -> size and split optimization. Never signs.
 * USD values come from MCP price hints refined by exact quotes; they rank and report, they never admit a trade.
 * v8 PR2 behavior sits behind `features` (PRD §8, §17); with every flag off the reads and output are the v7 ones. */
export type PoolKind = 'CL' | 'SOLIDLY' | 'V2_APPROX' | 'V4';
export interface V4Binding { manager: Address; id: Hex; key: V4PoolKey; tick: number; hookCodeHash: Hex | null }
export interface WatchPool { address: Address; protocol: string; token0: Address; token1: Address; kind: PoolKind
  /** v8 only: executor venue version (2 V2, 3 V3/Pancake, 5 Algebra, 4 V4) and the static fee used by the fold seed. */
  venue?: 2 | 3 | 4 | 5; feePips?: number | null; v4?: V4Binding }
export interface WatchOptions { chainId: number; inventory: unknown; minutes: number; out: string; flash?: Address[]; banditPath?: string; top?: number; maxHops?: number;
  probeUsd?: number; flashFeeBps?: number; nearBreakEvenBps?: number; concurrency?: number; sizeFloorBps?: number
  features?: V8Features; v4Manager?: Address; v4ScanFrom?: bigint; hookAllowlist?: { address: string; codeHash: string }[]
  executor?: Address; operator?: Address; lender?: { kind: 1 | 2; address: Address } }
interface Split { pool: string; amount_in_raw: string; quoted_out_raw: string; executor_min_out_raw: string; priced_out_raw: string }
interface AllocationPlan { start_asset: string; lender: { id: string; fee_bps: number }; principal_raw: string;
  seed: { method: SeedMethod; d_star_raw: string; cpmm_hops: number; non_cpmm_hops: number; curve?: { a: string; b: string; c: string } };
  legs: { hop: number; splits: Split[] }[]; refine: { method: 'golden_section'; evaluations: number; skipped_reason?: string }; min_out_raw: string; deadline_block: string }
interface GasReport { units: string; source: 'executor_eth_call' | 'model'; priority_fee_wei: string; gas_fallback_reason?: string }
interface CycleResult { hops: number; start: Address; route: string[]; edgeBps: number; sizeUsd: number; split: string[][]; grossUsd: number; gasUsd: number; netUsd: number; evaluations: number
  allocation?: AllocationPlan; gas?: GasReport; live?: { eligible: boolean; reasons: string[] } }

const QUOTER = '0x00000000000000000000000000000000c0ffee01' as Address, V4_QUOTER = '0x00000000000000000000000000000000c0ffee02' as Address;
const QUOTER_ABI = parseAbi(['function quote(address,bool,uint256) returns (uint256)']);
const POOL_ABI = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)', 'function slot0() view returns (uint160)', 'function globalState() view returns (uint160)',
  'function getReserves() view returns (uint256,uint256)', 'function getAmountOut(uint256,address) view returns (uint256)', 'function decimals() view returns (uint8)',
  'function liquidity() view returns (uint128)', 'function fee() view returns (uint24)', 'function factory() view returns (address)']);
const EXT_ABI = parseAbi(['function extsload(bytes32) view returns (bytes32)']);
const L1_ABI = parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)']);
const MIN_SQRT = 4295128740n, MAX_SQRT = 1461446703485210103287273052203988822378723970341n, ZERO = '0x0000000000000000000000000000000000000000' as Address;
/** Bounds in-flight RPC calls: public endpoints throttle bursts, and a throttled read must not look like an unsupported pool. */
export type Gate = <T>(task: () => Promise<T>) => Promise<T>;
export function limiter(concurrency: number): Gate {
  let active = 0; const queue: (() => void)[] = [];
  return async task => {
    if (active >= concurrency) await new Promise<void>(r => queue.push(r));
    active++;
    try { return await task(); } finally { active--; queue.shift()?.(); }
  };
}
/** Model gas (labelled `source:'model'` in v8 output); R0c replaces it with an executor estimate when one is possible. */
const GAS_BASE = 90_000n, GAS_PER_LEG = 110_000n, CALLDATA_BASE = 200n, CALLDATA_PER_LEG = 250n;

/** Decodes a V4 slot0 word: sqrtPriceX96 (160 bits) then a signed 24-bit tick. */
function v4Slot0(word: bigint) { const sqrtPriceX96 = word & ((1n << 160n) - 1n), raw = Number((word >> 160n) & 0xffffffn); return { sqrtPriceX96, tick: raw >= 0x800000 ? raw - 0x1000000 : raw }; }

export function createExactQuoter(client: PublicClient, code: Hex, pools: ReadonlyMap<string, WatchPool>, blockNumber: bigint, gate: Gate = limiter(8), v4Code?: Hex, failures?: Record<string, number>) {
  const cache = new Map<string, Promise<bigint>>();
  const run = async (p: WatchPool, tokenIn: Address, amount: bigint): Promise<bigint> => {
    try {
      if (p.kind === 'SOLIDLY') return await client.readContract({ address: p.address, abi: POOL_ABI, functionName: 'getAmountOut', args: [amount, tokenIn], blockNumber });
      if (p.kind === 'V2_APPROX') {
        const [r0, r1] = await client.readContract({ address: p.address, abi: POOL_ABI, functionName: 'getReserves', blockNumber });
        const [ri, ro] = tokenIn === p.token0 ? [r0, r1] : [r1, r0]; return amount * 997n * ro / (ri * 1000n + amount * 997n);
      }
      if (p.kind === 'V4') return await quoteV4(client, v4Code!, p, tokenIn === p.token0, amount, blockNumber);
      const r = await client.call({ to: QUOTER, data: encodeFunctionData({ abi: QUOTER_ABI, functionName: 'quote', args: [p.address, tokenIn === p.token0, amount] }), stateOverride: [{ address: QUOTER, code }], blockNumber });
      return r.data ? decodeFunctionResult({ abi: QUOTER_ABI, functionName: 'quote', data: r.data }) : 0n;
    } catch { if (failures) failures[p.kind] = (failures[p.kind] ?? 0) + 1; return 0n; }
  };
  return (pool: string, tokenIn: string, amount: bigint) => {
    const key = `${pool}:${tokenIn}:${amount}`;
    if (!cache.has(key)) cache.set(key, amount > 0n ? gate(() => run(pools.get(pool)!, tokenIn as Address, amount)) : Promise.resolve(0n));
    return cache.get(key)!;
  };
}

/** R1: the real PoolManager swap runs inside V4StateQuoter (code override), so hook fees and hook reverts count.
 * The bitmap words only feed the quoter's report (V4StateQuoter.sol unlockCallback), so one word is enough (A11).
 * A partial fill, revert or non-negative input delta is unfillable (0), never a zero-cost output. */
export async function quoteV4(client: PublicClient, v4Code: Hex, p: WatchPool, zeroForOne: boolean, amount: bigint, blockNumber: bigint): Promise<bigint> {
  const v4 = p.v4!, word = Math.floor(Math.floor(v4.tick / v4.key.tickSpacing) / 256);
  const r = await client.call({ to: V4_QUOTER, blockNumber, stateOverride: [{ address: V4_QUOTER, code: v4Code }],
    data: encodeFunctionData({ abi: V4_STATE_QUOTER_ABI, functionName: 'quoteExactInput', args: [v4.manager, v4.key, zeroForOne, amount, zeroForOne ? MIN_SQRT : MAX_SQRT, '0x', [word]] }) });
  if (!r.data) return 0n;
  const { delta } = decodeFunctionResult({ abi: V4_STATE_QUOTER_ABI, functionName: 'quoteExactInput', data: r.data }) as { delta: bigint };
  const d0 = BigInt.asIntN(128, delta >> 128n), d1 = BigInt.asIntN(128, delta), input = zeroForOne ? d0 : d1, output = zeroForOne ? d1 : d0;
  return input < 0n && -input === amount && output > 0n ? output : 0n;
}

interface InventoryEntry { reference?: { kind?: string; chainId?: number; address?: string; manager?: string; poolId?: string; providerPoolId?: string }; asset_ids?: string[]; protocol?: string; labels?: string[];
  liquidity_eligible?: boolean; price_usd?: string | null; pool_key?: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string } }
export interface ClassifyOptions { features?: V8Features; wrappedNative?: Address; v4Manager?: Address; v4ScanFrom?: bigint }
/** Classifies by runtime shape, not by protocol label: CL pools expose slot0/globalState, Solidly pools quote themselves.
 * v8: zero active liquidity is a phantom price (R0a); V4 pools need a verified key and live state (R1). */
export async function classifyPools(client: PublicClient, inventory: unknown, chainId: number, blockNumber: bigint, gate: Gate = limiter(8), opts: ClassifyOptions = {}):
  Promise<{ pools: WatchPool[]; hints: Record<string, number>; skipped: number; skipReasons: Record<string, number> }> {
  const raw = inventory as { data?: { pools?: unknown[] }; pools?: unknown[] }, f = opts.features;
  const entries = (raw.data?.pools ?? raw.pools ?? []) as InventoryEntry[];
  const read = async (address: Address, functionName: 'token0' | 'token1' | 'slot0' | 'globalState' | 'getReserves' | 'getAmountOut' | 'liquidity' | 'fee', args: readonly unknown[] = []) => {
    try { return await gate(() => client.readContract({ address, abi: POOL_ABI, functionName, args, blockNumber } as never)); } catch { return undefined; }
  };
  const pools: WatchPool[] = [], hints: Record<string, number> = {}, seen = new Set<string>(), skipReasons: Record<string, number> = {}; let skipped = 0;
  const skip = (reason: string) => { skipped++; skipReasons[reason] = (skipReasons[reason] ?? 0) + 1; };
  const hint = (e: InventoryEntry) => { const base = e.asset_ids?.[0]?.toLowerCase(), price = Number(e.price_usd); if (base && price > 0 && hints[base] === undefined) hints[base] = price; };
  await Promise.all(entries.filter(e => e.liquidity_eligible === true && e.reference?.kind === 'evm_contract' && e.reference.chainId === chainId).map(async e => {
    const address = e.reference!.address!.toLowerCase() as Address; if (seen.has(address)) return; seen.add(address);
    const [t0, t1] = await Promise.all([read(address, 'token0'), read(address, 'token1')]) as [string | undefined, string | undefined];
    if (!t0 || !t1) { skip('NO_TOKENS'); return; }
    const token0 = t0.toLowerCase() as Address, token1 = t1.toLowerCase() as Address;
    const v3 = (await read(address, 'slot0')) !== undefined, algebra = !v3 && (await read(address, 'globalState')) !== undefined;
    const kind: PoolKind | null = v3 || algebra ? 'CL'
      : (await read(address, 'getAmountOut', [1000n, token0])) !== undefined ? 'SOLIDLY' : (await read(address, 'getReserves')) !== undefined ? 'V2_APPROX' : null;
    if (!kind) { skip('UNSUPPORTED_SHAPE'); return; }
    if (f?.activeLiquidity && kind === 'CL') {
      const liquidity = await read(address, 'liquidity') as bigint | undefined;
      if (liquidity === undefined) { skip('STATE_UNAVAILABLE'); return; }
      if (liquidity === 0n) { skip('ZERO_ACTIVE_LIQUIDITY'); return; }
    }
    const pool: WatchPool = { address, protocol: [e.protocol, ...(e.labels ?? [])].filter(Boolean).join('/'), token0, token1, kind };
    if (f?.foldSeed || f?.measuredGas) {
      pool.venue = kind === 'CL' ? (v3 ? 3 : 5) : kind === 'V2_APPROX' ? 2 : undefined;
      pool.feePips = kind === 'V2_APPROX' ? 3000 : kind === 'CL' ? (await read(address, 'fee') as number | undefined) ?? null : null;
    }
    pools.push(pool); hint(e);
  }));
  if (f?.v4Quotes) await classifyV4(client, entries, chainId, blockNumber, gate, opts, { pools, seen, skip, hint });
  return { pools: pools.sort((a, b) => a.address.localeCompare(b.address)), hints, skipped, skipReasons };
}

/** R1 V4 intake. Accepts `evm_v4` refs and provider-opaque V4 ids; a key comes from `pool_key` (checked against the id)
 * or a bounded Initialize scan. Native ETH (currency 0) is aliased to the wrapped native token for the cycle graph. */
async function classifyV4(client: PublicClient, entries: InventoryEntry[], chainId: number, blockNumber: bigint, gate: Gate, opts: ClassifyOptions,
  acc: { pools: WatchPool[]; seen: Set<string>; skip: (r: string) => void; hint: (e: InventoryEntry) => void }) {
  const candidates = entries.filter(e => e.liquidity_eligible === true).map(e => {
    const r = e.reference;
    if (r?.kind === 'evm_v4' && r.chainId === chainId) return { e, id: r.poolId?.toLowerCase(), manager: (r.manager ?? opts.v4Manager)?.toLowerCase() };
    if (r?.kind === 'provider_opaque' && (e.labels ?? []).includes('v4')) return { e, id: r.providerPoolId?.toLowerCase(), manager: opts.v4Manager?.toLowerCase() };
    return null;
  }).filter((c): c is { e: InventoryEntry; id: string | undefined; manager: string | undefined } => c !== null);
  const valid = candidates.filter(c => { if (!c.id || !/^0x[0-9a-f]{64}$/.test(c.id)) { acc.skip('INVALID_POOL_ID'); return false; } if (!c.manager) { acc.skip('V4_MANAGER_UNKNOWN'); return false; } return !acc.seen.has(c.id) && !!acc.seen.add(c.id); });
  const keys = new Map<string, V4PoolKey>();
  for (const c of valid) if (c.e.pool_key) {
    const k = c.e.pool_key, key: V4PoolKey = { currency0: k.currency0.toLowerCase() as Address, currency1: k.currency1.toLowerCase() as Address, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks.toLowerCase() as Address };
    try { if (deriveV4PoolId(key).toLowerCase() === c.id) keys.set(c.id!, key); } catch { /* mismatch reported below */ }
  }
  const missing = valid.filter(c => !keys.has(c.id!) && !c.e.pool_key);
  if (missing.length && opts.v4ScanFrom !== undefined) {
    for (const manager of new Set(missing.map(c => c.manager!))) {
      try {
        const found = await readV4Initialize(viemV4Reader(client), manager as Address, missing.filter(c => c.manager === manager).map(c => c.id as Hex), { from: opts.v4ScanFrom, to: blockNumber, pageSize: 10_000n });
        for (const [id, fact] of found) keys.set(id, fact.key);
      } catch { /* unresolved below */ }
    }
  }
  const wrapped = opts.wrappedNative?.toLowerCase() as Address | undefined;
  await Promise.all(valid.map(async c => {
    const key = keys.get(c.id!);
    if (!key) { acc.skip(c.e.pool_key ? 'POOL_KEY_MISMATCH' : 'UNRESOLVED_POOL_KEY'); return; }
    const manager = c.manager as Address;
    let word: bigint, liquidity: bigint;
    try {
      [word, liquidity] = await Promise.all([0n, 3n].map(o => gate(() => client.readContract({ address: manager, abi: EXT_ABI, functionName: 'extsload', args: [v4PoolStateSlot(c.id as Hex, o)], blockNumber })).then(BigInt)));
    } catch { acc.skip('STATE_UNAVAILABLE'); return; }
    const { sqrtPriceX96, tick } = v4Slot0(word);
    if (sqrtPriceX96 === 0n) { acc.skip('STATE_UNAVAILABLE'); return; }
    if (opts.features?.activeLiquidity && liquidity === 0n) { acc.skip('ZERO_ACTIVE_LIQUIDITY'); return; }
    const alias = (t: Address) => t === ZERO && wrapped ? wrapped : t, token0 = alias(key.currency0), token1 = alias(key.currency1);
    if (token0 === token1) { acc.skip('SELF_PAIR'); return; }
    let hookCodeHash: Hex | null = null;
    if (key.hooks !== ZERO) { try { const code = await gate(() => client.getCode({ address: key.hooks, blockNumber })); hookCodeHash = code && code !== '0x' ? keccak256(code) : null; } catch { acc.skip('STATE_UNAVAILABLE'); return; } }
    // A dynamic-fee flag (0x800000) has no static fee: the fold seed treats that hop as non-CPMM.
    acc.pools.push({ address: c.id as Address, protocol: ['uniswap-v4', ...(c.e.labels ?? []), ...(key.hooks !== ZERO ? ['hooked'] : [])].join('/'), token0, token1, kind: 'V4', venue: 4,
      feePips: key.fee & 0x800000 ? null : key.fee, v4: { manager, id: c.id as Hex, key, tick, hookCodeHash } });
    acc.hint(c.e);
  }));
}

export async function runCycleWatch(client: PublicClient, options: WatchOptions): Promise<{ scans: number; positiveNetScans: number; bestNetUsd: number | null; nextSeeds: string[] }> {
  const profile = evmProfile(options.chainId), features = options.features, v8 = !!features && Object.values(features).some(Boolean);
  if (await client.getChainId() !== options.chainId) throw new Error('CHAIN_MISMATCH');
  const artifact = async (name: string) => (JSON.parse(await readFile(resolve('out', `${name}.sol`, `${name}.json`), 'utf8')) as { deployedBytecode: { object: Hex } }).deployedBytecode.object;
  const code = await artifact('ExactSwapQuoter'), v4Code = features?.v4Quotes ? await artifact('V4StateQuoter') : undefined;
  const gate = limiter(options.concurrency ?? 8);
  const { pools, hints, skipped, skipReasons } = await classifyPools(client, options.inventory, options.chainId, await client.getBlockNumber(), gate,
    { features, wrappedNative: profile.wrappedNative as Address, v4Manager: options.v4Manager, v4ScanFrom: options.v4ScanFrom });
  const byAddress = new Map(pools.map(p => [p.address as string, p]));
  const decimals: Record<string, number> = {};
  for (const t of new Set(pools.flatMap(p => [p.token0, p.token1]))) {
    try { decimals[t] = Number(await gate(() => client.readContract({ address: t, abi: POOL_ABI, functionName: 'decimals' }))); } catch { /* unpriceable token stays out of the graph */ }
  }
  const usdAmount = (token: string, usd: number) => {
    const price = hints[token], d = decimals[token]; if (!(price > 0) || d === undefined) return 0n;
    const scale = Math.min(d, 12); return BigInt(Math.floor(usd / price * 10 ** scale)) * 10n ** BigInt(d - scale);
  };
  const toUsd = (token: string, raw: bigint) => Number(raw) / 10 ** decimals[token] * (hints[token] ?? 0);
  const probeUsd = options.probeUsd ?? 100, flashFeeBps = BigInt(Math.round((options.flashFeeBps ?? 0) * 100));
  const bandit = new TokenBandit(options.banditPath ? await readFile(options.banditPath, 'utf8').then(s => JSON.parse(s) as BanditState).catch(() => undefined) : undefined);
  const deadline = Date.now() + options.minutes * 60_000;
  let scans = 0, positiveNetScans = 0, bestNetUsd: number | null = null;
  // Refine missing USD hints once from exact $probe quotes against an already priced neighbour (sizing/reporting only).
  const priceQuote = createExactQuoter(client, code, byAddress, await client.getBlockNumber(), gate, v4Code);
  for (let pass = 0; pass < 3; pass++) for (const p of pools) for (const [a, b] of [[p.token0, p.token1], [p.token1, p.token0]] as const) {
    if (hints[a] && !hints[b] && decimals[b] !== undefined) { const out = await priceQuote(p.address, a, usdAmount(a, probeUsd)); if (out > 0n) hints[b] = probeUsd / (Number(out) / 10 ** decimals[b]); }
  }
  const starts = (options.flash ?? [profile.wrappedNative as Address]).map(a => a.toLowerCase());
  const behavior = features?.tokenBehavior ? await tokenBehaviors(client, code, pools, starts, options.chainId, await client.getBlockNumber(), gate, t => usdAmount(t, probeUsd) || (decimals[t] !== undefined ? 10n ** BigInt(decimals[t]) : 0n)) : {};
  const excluded = new Set(Object.values(behavior).filter(b => b.status === 'TAXED' || b.status === 'BLOCKED').map(b => b.token as string));
  do {
    const scanStarted = Date.now(), blockNumber = await client.getBlockNumber(), failures: Record<string, number> = {};
    const quote = createExactQuoter(client, code, byAddress, blockNumber, gate, v4Code, v8 ? failures : undefined);
    const edges: Edge[] = (await Promise.all(pools.flatMap(p => ([[p.token0, p.token1], [p.token1, p.token0]] as const).map(async ([tokenIn, tokenOut]) => {
      if (excluded.has(tokenIn) || excluded.has(tokenOut)) return null;
      const amount = usdAmount(tokenIn, probeUsd); if (!amount) return null;
      const out = await quote(p.address, tokenIn, amount);
      const e: Edge | null = out > 0n ? { pool: p.address, tokenIn, tokenOut, logRate: Math.log(Number(out) / Number(amount)) } : null; return e;
    })))).filter((e): e is Edge => e !== null);
    const found = { found: 0 }, cycles = findCycles(edges, starts, options.maxHops ?? 4, 2_000, found);
    const [gasPrice, l1PerLeg] = await Promise.all([client.getGasPrice(), profile.feeModel === 'op-stack' ? l1Fee(client, blockNumber) : Promise.resolve(() => 0n)]);
    const gasUsdFor = (legs: number) => toUsd(profile.wrappedNative, gasPrice * (GAS_BASE + GAS_PER_LEG * BigInt(legs)) + l1PerLeg(legs));
    // Profit is concave in size and probe-size impact is negligible, so a cycle with no positive edge at the probe loses at every size.
    const sizable = cycles.slice(0, options.top ?? 8).filter(c => c.edgeBps > (options.sizeFloorBps ?? 0));
    const ctx: EvalContext = { usdAmount, toUsd, flashFeeBps, gasUsdFor, probeUsd, features, client, byAddress, blockNumber, gate };
    const results = await Promise.all(sizable.map(cycle => evaluateCycle(cycle, edges, quote, ctx)));
    const best = results.reduce<CycleResult | null>((m, r) => !m || r.netUsd > m.netUsd ? r : m, null);
    if (v8) for (const r of results) {
      r.gas = { units: (GAS_BASE + GAS_PER_LEG * BigInt(r.split.reduce((n, h) => n + h.length, 0))).toString(), source: 'model', priority_fee_wei: '0' };
      if (features?.measuredGas) {
        const measured = r === best && r.netUsd > 0 ? await measuredGas(r, options, ctx) : { reason: r === best ? 'MODEL_NET_NOT_POSITIVE' : 'NOT_BEST_CANDIDATE' };
        if ('units' in measured) { r.gas = { units: measured.units.toString(), source: 'executor_eth_call', priority_fee_wei: '0' }; r.gasUsd = +(toUsd(profile.wrappedNative, gasPrice * measured.units + l1PerLeg(r.split.flat().length))).toFixed(5); r.netUsd = +(r.grossUsd - r.gasUsd).toFixed(5); }
        else r.gas.gas_fallback_reason = measured.reason;
      }
      r.live = liveAdmission(r, byAddress, behavior, starts, options.hookAllowlist ?? []);
    }
    const nearBps = options.nearBreakEvenBps ?? -1;
    for (const c of cycles.slice(0, 200)) for (const e of c.edges) bandit.update(e.tokenOut, c.edgeBps >= nearBps);
    if (best && best.netUsd > 0) positiveNetScans++;
    if (best && (bestNetUsd === null || best.netUsd > bestNetUsd)) bestNetUsd = best.netUsd;
    const row: Record<string, unknown> = { schemaVersion: 'cycle-watch/1', chainId: options.chainId, block: blockNumber.toString(), at: new Date().toISOString(), scanMs: Date.now() - scanStarted,
      pools: pools.length, skippedPools: skipped, edges: edges.length, cycles: found.found, bestEdgeBps: cycles[0] ? +cycles[0].edgeBps.toFixed(3) : null, sized: results.length, positiveEdgeCycles: cycles.filter(c => c.edgeBps > 0).length, results };
    if (v8) Object.assign(row, { features, skipReasons, quoteFailures: failures, v4Pools: pools.filter(p => p.kind === 'V4').length, ...(features?.tokenBehavior ? { tokenBehavior: Object.values(behavior), excludedTokens: [...excluded] } : {}) });
    await appendFile(options.out, JSON.stringify(row) + '\n');
    scans++;
  } while (Date.now() < deadline);
  if (options.banditPath) await atomicJson(options.banditPath, bandit.state);
  const nextSeeds = bandit.rank(Object.keys(bandit.state.arms)).slice(0, 20).map(r => r.token);
  return { scans, positiveNetScans, bestNetUsd, nextSeeds };
}

/** R0b, A9: one probe per non-anchor token per run, sold into a pool that holds it (V4 ids are not transfer targets). */
async function tokenBehaviors(client: PublicClient, code: Hex, pools: readonly WatchPool[], anchors: readonly string[], chainId: number, blockNumber: bigint, gate: Gate, amountFor: (t: string) => bigint) {
  const out: Record<string, TokenBehavior> = {};
  for (const token of new Set(pools.flatMap(p => [p.token0, p.token1]))) {
    if (anchors.includes(token)) continue;
    const pool = pools.find(p => p.kind !== 'V4' && (p.token0 === token || p.token1 === token)) ?? pools.find(p => p.token0 === token || p.token1 === token);
    const target = (pool?.kind === 'V4' ? pool.v4!.manager : pool?.address) as Address;
    out[token] = await gate(() => probeTokenBehavior(client, code, QUOTER, token, target, amountFor(token), chainId, blockNumber));
  }
  return out;
}

/** Live eligibility is reported, never acted on here (this command never signs): hooks need the allowlist (EDGE-10),
 * tokens need a clean token-behavior/1 unless they are configured anchors. */
function liveAdmission(r: CycleResult, pools: ReadonlyMap<string, WatchPool>, behavior: Record<string, TokenBehavior>, anchors: readonly string[], allowlist: { address: string; codeHash: string }[]) {
  const used = r.split.flat().map(a => pools.get(a)).filter((p): p is WatchPool => !!p), reasons: string[] = [];
  const hooks = hookAdmission(used.filter(p => p.v4).map(p => ({ pool: p.address, hooks: p.v4!.key.hooks, codeHash: p.v4!.hookCodeHash })), allowlist);
  if (!hooks.ok) reasons.push(hooks.reason);
  const tokens = new Set(used.flatMap(p => [p.token0, p.token1]).filter(t => !anchors.includes(t)));
  if ([...tokens].some(t => behavior[t]?.status !== 'OK')) reasons.push(Object.keys(behavior).length ? 'TOKEN_BEHAVIOR_UNVERIFIED' : 'TOKEN_BEHAVIOR_NOT_PROBED');
  if (r.gas?.source !== 'executor_eth_call') reasons.push('GAS_NOT_MEASURED');
  return { eligible: reasons.length === 0, reasons };
}

async function measuredGas(r: CycleResult, options: WatchOptions, ctx: EvalContext): Promise<{ units: bigint } | { reason: string }> {
  if (!options.executor || !options.operator || !options.lender) return { reason: 'EXECUTOR_NOT_CONFIGURED' };
  if (r.split.some(h => h.length > 1)) return { reason: 'SPLIT_NOT_MEASURED' };
  if (!r.allocation) return { reason: 'NO_ALLOCATION_PLAN' };
  const legs: GasLeg[] = [];
  for (const [i, hop] of r.allocation.legs.entries()) {
    const s = hop.splits[0], p = ctx.byAddress.get(s.pool)!, tokenIn = (i === 0 ? r.start : legs[i - 1].tokenOut) as Address, tokenOut = (tokenIn === p.token0 ? p.token1 : p.token0) as Address;
    if (!p.venue) return { reason: 'VENUE_UNSUPPORTED' };
    let root: Address;
    try { root = p.venue === 4 ? p.v4!.manager : await ctx.client.readContract({ address: p.address, abi: POOL_ABI, functionName: 'factory', blockNumber: ctx.blockNumber }); } catch { return { reason: 'FACTORY_UNREADABLE' }; }
    if (p.v4 && (p.v4.key.currency0 === ZERO || p.v4.key.currency1 === ZERO)) return { reason: 'NATIVE_V4_NEEDS_NATIVE_EXECUTOR' };
    legs.push({ venueVersion: p.venue, root, pool: p.venue === 4 ? ZERO : p.address, tokenIn, tokenOut, minAmountOut: BigInt(s.executor_min_out_raw),
      fee: p.venue === 4 ? p.v4!.key.fee : p.feePips ?? 0, tickSpacing: p.venue === 4 ? p.v4!.key.tickSpacing : 0, hooks: p.venue === 4 ? p.v4!.key.hooks : ZERO });
  }
  return measureCycleGas(ctx.client, options.executor, options.operator, options.lender, r.start, BigInt(r.allocation.principal_raw), legs, ctx.blockNumber);
}

async function l1Fee(client: PublicClient, blockNumber: bigint) {
  const upper = async (bytes: bigint) => client.readContract({ address: '0x420000000000000000000000000000000000000F', abi: L1_ABI, functionName: 'getL1FeeUpperBound', args: [bytes], blockNumber });
  const [base, perLeg] = await Promise.all([upper(CALLDATA_BASE), upper(CALLDATA_BASE + CALLDATA_PER_LEG)]);
  return (legs: number) => base + (perLeg - base) * BigInt(legs);
}

interface EvalContext { usdAmount: (t: string, usd: number) => bigint; toUsd: (t: string, raw: bigint) => number; flashFeeBps: bigint; gasUsdFor: (legs: number) => number
  probeUsd: number; features?: V8Features; client: PublicClient; byAddress: ReadonlyMap<string, WatchPool>; blockNumber: bigint; gate: Gate }

/** §6 hop curve at the pinned block: V2 actual reserves; CL/V4 in-tick virtual reserves (A1, A8). null = no closed form. */
async function hopState(ctx: EvalContext, pool: WatchPool, tokenIn: string): Promise<HopCurve | null> {
  const zeroForOne = tokenIn === pool.token0, at = { blockNumber: ctx.blockNumber };
  try {
    if (pool.kind === 'V2_APPROX') {
      const [r0, r1] = await ctx.gate(() => ctx.client.readContract({ address: pool.address, abi: POOL_ABI, functionName: 'getReserves', ...at }));
      return hopCurve(zeroForOne ? r0 : r1, zeroForOne ? r1 : r0, 3000);
    }
    if ((pool.kind === 'CL' || pool.kind === 'V4') && typeof pool.feePips === 'number') {
      let sqrtPriceX96: bigint, liquidity: bigint;
      if (pool.kind === 'V4') {
        const [w, l] = await Promise.all([0n, 3n].map(o => ctx.gate(() => ctx.client.readContract({ address: pool.v4!.manager, abi: EXT_ABI, functionName: 'extsload', args: [v4PoolStateSlot(pool.v4!.id, o)], ...at })).then(BigInt)));
        sqrtPriceX96 = v4Slot0(w).sqrtPriceX96; liquidity = l;
      } else {
        [sqrtPriceX96, liquidity] = await Promise.all([ctx.gate(() => ctx.client.readContract({ address: pool.address, abi: POOL_ABI, functionName: pool.venue === 5 ? 'globalState' : 'slot0', ...at })),
          ctx.gate(() => ctx.client.readContract({ address: pool.address, abi: POOL_ABI, functionName: 'liquidity', ...at }))]) as [bigint, bigint];
      }
      const v = clVirtualReserves(liquidity, sqrtPriceX96, zeroForOne);
      return hopCurve(v.reserveIn, v.reserveOut, pool.feePips);
    }
  } catch { /* fall through: no closed form for this hop */ }
  return null;
}

/** Size first on the single-pool path (cheap), then split each hop across parallel pools at that size and resize.
 * v8 `foldSeed`: the closed-form seed brackets an always-run exact refine (A3) instead of a 10 → 1M USD doubling scan. */
async function evaluateCycle(cycle: Cycle, edges: readonly Edge[], quote: (pool: string, tokenIn: string, amount: bigint) => Promise<bigint>, ctx: EvalContext): Promise<CycleResult> {
  const start = cycle.edges[0].tokenIn as Address, used = new Set(cycle.edges.map(e => e.pool));
  const parallel = cycle.edges.map(e => [e.pool, ...edges.filter(x => x.tokenIn === e.tokenIn && x.tokenOut === e.tokenOut && !used.has(x.pool)).map(x => x.pool)]);
  const fee = (x: bigint) => (x * ctx.flashFeeBps + 999_999n) / 1_000_000n;
  const through = async (x: bigint, split: boolean) => {
    let amount = x; const allocation: string[][] = [], legs: { hop: number; splits: Split[] }[] = [];
    for (let i = 0; i < cycle.edges.length; i++) {
      const hop = cycle.edges[i], pools = split ? parallel[i] : [hop.pool];
      if (pools.length === 1) {
        const out = await quote(pools[0], hop.tokenIn, amount);
        legs.push({ hop: i, splits: [splitRow(pools[0], amount, out)] }); amount = out; allocation.push([pools[0]]);
      } else {
        const s = await splitAmount(pools.map(p => (a: bigint) => quote(p, hop.tokenIn, a)), amount, 8, ctx.usdAmount(hop.tokenOut, ctx.gasUsdFor(2) - ctx.gasUsdFor(1)));
        const rows = await Promise.all(pools.map(async (p, j) => s.amounts[j] > 0n ? splitRow(p, s.amounts[j], await quote(p, hop.tokenIn, s.amounts[j])) : null));
        legs.push({ hop: i, splits: rows.filter((r): r is Split => r !== null) }); amount = s.out; allocation.push(pools.filter((_, j) => s.amounts[j] > 0n));
      }
      if (amount === 0n) return { gross: null, allocation, legs };
    }
    return { gross: amount - x - fee(x), allocation, legs };
  };
  let min = ctx.usdAmount(start, 10), max = ctx.usdAmount(start, 1_000_000), iterations = 8;
  let seed: AllocationPlan['seed'] | undefined, refineSkip: string | undefined;
  if (ctx.features?.foldSeed) {
    const hops = await Promise.all(cycle.edges.map(e => hopState(ctx, ctx.byAddress.get(e.pool)!, e.tokenIn)));
    const cpmm = hops.filter(h => h !== null).length, curve = hops.every(h => h !== null) ? foldCycle(hops as HopCurve[]) : null;
    const allCpmm = cycle.edges.every(e => ctx.byAddress.get(e.pool)!.kind === 'V2_APPROX');
    if (curve) {
      const dStar = seedPrincipal(curve, ctx.flashFeeBps, 1_000_000n);
      seed = { method: 'fold_closed_form', d_star_raw: dStar.toString(), cpmm_hops: cpmm, non_cpmm_hops: cycle.edges.length - cpmm, curve: { a: curve.a.toString(), b: curve.b.toString(), c: curve.c.toString() } };
      const bracket = refineBracket({ method: 'fold_closed_form', dStar, allCpmm });
      // The exact probe outranks the seed (A3): a positive exact edge with d* = 0 keeps the full exact search.
      if (bracket) { min = bracket.min; max = bracket.max; iterations = allCpmm ? 4 : 10; }
      else if (cycle.edgeBps > 0) seed.method = 'probe_bracket';
      else { max = min; refineSkip = 'NO_CLOSED_FORM_EDGE'; }
    } else {
      const probe = ctx.usdAmount(start, ctx.probeUsd), first = hops[0];
      const bracket = first ? refineBracket({ method: 'probe_bracket', probe, shallowDepth: first.curve.b / 1_000_000n }) : null;
      seed = { method: 'probe_bracket', d_star_raw: probe.toString(), cpmm_hops: cpmm, non_cpmm_hops: cycle.edges.length - cpmm };
      if (bracket) { min = bracket.min; max = bracket.max; }
    }
  }
  const single = refineSkip ? null : await maximizeConcave(async x => (await through(x, false)).gross, min, max, iterations);
  let x = single?.x ?? min, evaluations = single?.evaluations ?? 1, { gross, allocation, legs } = await through(x, false);
  // Splitting only deepens a route that already pays before gas; a better parallel pool is ranked as its own cycle.
  if (single && single.value > 0n && parallel.some(p => p.length > 1)) {
    const split = await maximizeConcave(async y => (await through(y, true)).gross, x, x * 8n, 8);
    evaluations += split?.evaluations ?? 0;
    // Each extra leg costs gas, so a split must win on net, not gross.
    const count = (a: string[][]) => a.reduce((n, hop) => n + hop.length, 0), net = (g: bigint | null, a: string[][]) => g === null ? -Infinity : ctx.toUsd(start, g) - ctx.gasUsdFor(count(a));
    if (split) { const candidate = await through(split.x, true); if (net(candidate.gross, candidate.allocation) > net(gross, allocation)) { x = split.x; ({ gross, allocation, legs } = candidate); } }
  }
  const grossUsd = gross === null ? -Infinity : ctx.toUsd(start, gross), gasUsd = ctx.gasUsdFor(allocation.reduce((s, a) => s + a.length, 0));
  const result: CycleResult = { hops: cycle.edges.length, start, route: cycle.edges.map(e => e.pool), edgeBps: +cycle.edgeBps.toFixed(3), sizeUsd: +ctx.toUsd(start, x).toFixed(2), split: allocation,
    grossUsd: +grossUsd.toFixed(5), gasUsd: +gasUsd.toFixed(5), netUsd: +(grossUsd - gasUsd).toFixed(5), evaluations };
  if (seed) {
    const last = legs[legs.length - 1]?.splits.reduce((s, r) => s + BigInt(r.priced_out_raw), 0n) ?? 0n;
    result.allocation = { start_asset: start, lender: { id: 'flash', fee_bps: Number(ctx.flashFeeBps) / 100 }, principal_raw: x.toString(), seed, legs,
      refine: { method: 'golden_section', evaluations, ...(refineSkip ? { skipped_reason: refineSkip } : {}) }, min_out_raw: last.toString(), deadline_block: (ctx.blockNumber + 1n).toString() };
  }
  return result;
}
/** §6.6: the executor is encoded with the quoted output as each leg's minimum, so it requests exactly that (V2 legs
 * request `minAmountOut` itself). `priced_out` is the lower of the two and is what net uses. */
function splitRow(pool: string, amountIn: bigint, quoted: bigint): Split {
  const requested = quoted;
  return { pool, amount_in_raw: amountIn.toString(), quoted_out_raw: quoted.toString(), executor_min_out_raw: requested.toString(), priced_out_raw: pricedOut(quoted, requested).toString() };
}
