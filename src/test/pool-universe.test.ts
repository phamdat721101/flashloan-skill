import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { buildPoolUniverse, loadPoolUniverse, pairGaps, parseAssetPolicy, parseInventory, validateUniverse, type UniverseReader } from '../evm/pool-universe.js';

const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', USDT = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const WBTC = '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f';
const UNI = '0x1f98431c8ad98523631ae4a59f267346ea31f984', PANCAKE = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865', CAMELOT = '0x1a3c9b1d2f0529d97f2afc5136cc23e58f1fd35b', SUSHI2 = '0xc35dadb65012ec5796536bd9864ed8773abc74c4';
const FEED = '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612';
const NOW = Date.parse('2026-10-28T03:00:00.000Z');
const abi = parseAbi(['function token0() view returns(address)', 'function token1() view returns(address)', 'function factory() view returns(address)', 'function fee() view returns(uint24)',
  'function tickSpacing() view returns(int24)', 'function liquidity() view returns(uint128)', 'function slot0() view returns(uint160)', 'function globalState() view returns(uint160)',
  'function getReserves() view returns(uint112,uint112)', 'function decimals() view returns(uint8)']);
const sel = (name: string) => encodeFunctionData({ abi, functionName: name as never });
const words = (...values: Array<bigint | string>) => `0x${values.map(v => BigInt(v).toString(16).padStart(64, '0')).join('')}` as Hex;
const signed = (value: number) => BigInt.asUintN(256, BigInt(value));
function isqrt(n: bigint) { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }
/** sqrtPriceX96 for `price` token1 per token0 in whole units. */
const sqrtX96 = (price: number, d0: number, d1: number) => isqrt((BigInt(Math.round(price * 1e6)) * 10n ** BigInt(d1) << 192n) / (10n ** BigInt(d0) * 1_000_000n));

type Fake = Record<string, { code?: Hex; calls: Record<string, Hex> }>;
function reader(state: Fake): UniverseReader {
  return {
    async block() { return { number: 1000n, hash: `0x${'ab'.repeat(32)}`, timestamp: BigInt(NOW / 1000) }; },
    async code(address: Address) { return state[address]?.code; },
    async call(to: Address, data: Hex) { return state[to]?.calls[data]; }
  };
}
const token = (decimals: number) => ({ code: '0x60' as Hex, calls: { [sel('decimals')]: words(BigInt(decimals)) } });
function v3(factory: string, t0: string, t1: string, sqrt: bigint, fee = 500, liquidity = 10n ** 18n, extraSlot0: bigint[] = []) {
  return { code: '0x6001' as Hex, calls: { [sel('factory')]: words(factory), [sel('token0')]: words(t0), [sel('token1')]: words(t1), [sel('fee')]: words(BigInt(fee)),
    [sel('tickSpacing')]: words(10n), [sel('liquidity')]: words(liquidity), [sel('slot0')]: words(sqrt, signed(-200000), ...extraSlot0) } };
}
const pool = (address: string, assets: string[], usd = '500000', eligible = true) =>
  ({ id: address.slice(2, 10), reference: { kind: 'evm_contract', chainId: 42161, address }, asset_ids: assets, protocol: 'uniswap', labels: [], liquidity_usd: usd, liquidity_eligible: eligible });
const inventory = (pools: unknown[], network = 'arbitrum', observedAt = '2026-10-28T02:45:48.096Z') =>
  ({ schema_version: 'flashloan.public.v2', ok: true, data: { schema_version: 'flashloan.inventory.v2', network, observed_at: observedAt, outcome: 'SUCCESS', pools,
    coverage: [{ source: 'dexscreener:token-pairs/v1', exhaustive: false }] } });
const policy = parseAssetPolicy({ schemaVersion: 'asset-policy/1', chainId: 42161, maxInventoryAgeSeconds: 3600, universeTtlSeconds: 600, maxPairs: 16, denylist: [],
  assets: { [WETH]: { symbol: 'WETH', usdFeed: FEED, flashLenders: [{ kind: 'BALANCER_V2', address: '0xba12222222228d8ba445958a75a0704d566bf2c8' }] }, [USDC]: { symbol: 'USDC', usdFeed: '0x50834f3163758fcc1df9973b6e91f0f0f0434ad3', flashLenders: [] } },
  factories: { [UNI]: { venue: 'uniswap-v3', adapter: 'UNISWAP_V3' }, [PANCAKE]: { venue: 'pancakeswap-v3', adapter: 'UNISWAP_V3' },
    [CAMELOT]: { venue: 'camelot-v3', adapter: 'ALGEBRA', directionalFee: true }, [SUSHI2]: { venue: 'sushiswap-v2', adapter: 'UNISWAP_V2', feePips: 3000 } } });
const P = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const base: Fake = { [WETH]: token(18), [USDC]: token(6), [USDT]: token(6), [WBTC]: token(8), [FEED]: { code: '0x60', calls: {} } };

test('rejects inventory for a different chain', async () => {
  await assert.rejects(buildPoolUniverse(parseInventory(inventory([], 'base')), policy, reader(base), NOW), /INVENTORY_CHAIN_MISMATCH/);
});

test('EDGE-01 rejects stale, malformed or wrong-chain inventory', async () => {
  await assert.rejects(buildPoolUniverse(parseInventory(inventory([], 'base')), policy, reader(base), NOW), /INVENTORY_CHAIN_MISMATCH/);
  await assert.rejects(buildPoolUniverse(parseInventory(inventory([], 'arbitrum', '2026-10-28T01:00:00.000Z')), policy, reader(base), NOW), /INVENTORY_STALE/);
  assert.throws(() => parseInventory({ data: { schema_version: 'flashloan.inventory.v1' } }), /INVALID_INVENTORY/);
  console.log('universe_inventory_freshness_and_chain_binding_proven');
});

test('EDGE-02 orders tokens by on-chain token0, not asset_ids, and gaps are decimal-correct in both orientations', async () => {
  const fake: Fake = { ...base,
    [P(1)]: v3(UNI, WETH, USDC, sqrtX96(2000, 18, 6)), [P(2)]: v3(PANCAKE, WETH, USDC, sqrtX96(2010, 18, 6), 100, 10n ** 18n, [0n, 0n, 0n, 216272100n, 1n]),
    [P(3)]: v3(UNI, WBTC, WETH, sqrtX96(25, 8, 18)), [P(4)]: v3(UNI, WBTC, WETH, sqrtX96(25.25, 8, 18), 3000) };
  const universe = await buildPoolUniverse(parseInventory(inventory([pool(P(1), [USDC, WETH]), pool(P(2), [WETH, USDC]), pool(P(3), [WETH, WBTC]), pool(P(4), [WETH, WBTC])])), policy, reader(fake), NOW);
  assert.deepEqual(universe.pairs.map(p => [p.token0, p.token1]).sort(), [[WBTC, WETH], [WETH, USDC]].sort());
  assert.equal(universe.pools.find(p => p.address === P(1))!.token0, WETH);
  const gaps = pairGaps(universe);
  const usdc = gaps.find(g => g.token1 === USDC)!, wbtc = gaps.find(g => g.token0 === WBTC)!;
  assert.ok(Math.abs(usdc.gapBps - 50) < 0.05, `18/6 gap ${usdc.gapBps}`);
  assert.equal(usdc.buyPool, `uniswap_v3:${P(1)}`);
  assert.equal(usdc.feeFloorBps, 6);
  assert.ok(Math.abs(wbtc.gapBps - 100) < 0.05, `8/18 gap ${wbtc.gapBps}`);
  assert.equal(validateUniverse(JSON.parse(JSON.stringify(universe))).schemaVersion, 'pool-universe/1');
  console.log('universe_token_order_and_decimal_gap_proven');
});

test('EDGE-03 rejects spoofed factory, token mismatch, zero liquidity, unsupported adapter and duplicates', async () => {
  const fake: Fake = { ...base,
    [P(1)]: v3('0x' + '99'.repeat(20), WETH, USDC, sqrtX96(2000, 18, 6)),
    [P(2)]: v3(UNI, WETH, USDT, sqrtX96(2000, 18, 6)),
    [P(3)]: v3(UNI, WETH, USDC, sqrtX96(2000, 18, 6), 500, 0n),
    [P(4)]: { code: '0x60', calls: { ...v3(UNI, WETH, USDC, 1n).calls, [sel('slot0')]: '0x' } },
    [P(5)]: v3(UNI, WETH, USDC, sqrtX96(2000, 18, 6)) };
  const universe = await buildPoolUniverse(parseInventory(inventory([pool(P(1), [WETH, USDC]), pool(P(2), [WETH, USDC]), pool(P(3), [WETH, USDC]), pool(P(4), [WETH, USDC]),
    pool(P(5), [WETH, USDC]), pool(P(5), [USDC, WETH]), pool(P(6), [WETH, USDC]), pool(P(7), [WETH, USDC], '1', false)])), policy, reader(fake), NOW);
  const reasons = Object.fromEntries(universe.rejected.map(r => [r.address, r.reason]));
  assert.deepEqual(reasons, { [P(1)]: 'FACTORY_UNKNOWN', [P(2)]: 'TOKEN_MISMATCH', [P(3)]: 'ZERO_LIQUIDITY', [P(4)]: 'UNSUPPORTED_ADAPTER', [P(5)]: 'SINGLE_POOL_PAIR', [P(6)]: 'NO_CODE', [P(7)]: 'NOT_ELIGIBLE' });
  assert.ok(universe.rejected.some(r => r.address === P(5) && r.reason === 'DUPLICATE'), 'duplicate listing is reported too');
  assert.equal(universe.pairs.length, 0, 'a single verified pool is not a pair');
  assert.equal(universe.candidatePairs[0].token0, WETH);
  console.log('universe_factory_spoof_and_silent_drop_rejection_proven');
});

test('uses the larger Camelot directional fee and the factory fee for V2 forks', async () => {
  const camelot = { code: '0x60' as Hex, calls: { ...v3(CAMELOT, WETH, USDC, 0n).calls, [sel('globalState')]: words(sqrtX96(2000, 18, 6), signed(-200000), 100n, 300n, 5n) } };
  const sushi = { code: '0x60' as Hex, calls: { [sel('factory')]: words(SUSHI2), [sel('token0')]: words(WETH), [sel('token1')]: words(USDC), [sel('getReserves')]: words(10n ** 20n, 2n * 10n ** 11n, 0n) } };
  const universe = await buildPoolUniverse(parseInventory(inventory([pool(P(1), [WETH, USDC]), pool(P(2), [WETH, USDC])])), policy, reader({ ...base, [P(1)]: camelot, [P(2)]: sushi }), NOW);
  assert.deepEqual(universe.pools.map(p => [p.venue, p.feePips]), [['camelot-v3', 300], ['sushiswap-v2', 3000]]);
  const gap = pairGaps(universe)[0];
  assert.ok(gap.gapBps < 0.05, 'V2 reserves 100 WETH / 200000 USDC price matches 2000');
  assert.equal(gap.feeFloorBps, 33);
});

test('drops a feed without code and keeps assets without feeds as targets only', async () => {
  const fake: Fake = { ...base, [FEED]: { code: '0x', calls: {} }, [P(1)]: v3(UNI, WETH, USDC, sqrtX96(2000, 18, 6)), [P(2)]: v3(UNI, WETH, USDC, sqrtX96(2001, 18, 6), 3000) };
  const universe = await buildPoolUniverse(parseInventory(inventory([pool(P(1), [WETH, USDC]), pool(P(2), [WETH, USDC])])), policy, reader(fake), NOW);
  assert.equal(universe.assets.find(a => a.address === WETH)!.usdFeed, null);
  assert.equal(universe.assets.find(a => a.address === USDC)!.decimals, 6);
});

test('consumers fail closed on expired or wrong-chain universes', async () => {
  const universe = await buildPoolUniverse(parseInventory(inventory([])), policy, reader(base), NOW);
  const path = join(await mkdtemp(join(tmpdir(), 'pool-universe-')), 'u.json');
  await writeFile(path, JSON.stringify(universe));
  assert.equal((await loadPoolUniverse(path, 42161, NOW)).chainId, 42161);
  await assert.rejects(loadPoolUniverse(path, 8453, NOW), /UNIVERSE_CHAIN_MISMATCH/);
  await assert.rejects(loadPoolUniverse(path, 42161, NOW + 601_000), /UNIVERSE_EXPIRED/);
  await writeFile(path, JSON.stringify({ ...universe, pools: [{ address: 'x' }] }));
  await assert.rejects(loadPoolUniverse(path, 42161, NOW), /INVALID_POOL_UNIVERSE/);
});
