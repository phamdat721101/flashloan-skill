import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPublicClient, decodeFunctionData, encodeFunctionResult, http, keccak256, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { allocateCpmm, composeCurves, stationaryInput } from '../evm/cycle-engine.js';
import { classifyPools, quoteV4, type WatchPool } from '../evm/cycle-watch.js';
import { acceptanceThreshold, hookAdmission } from '../evm/acceptance.js';
import { probeTokenBehavior } from '../evm/pool-universe.js';
import { v8Features } from '../evidence/integration.js';
import { V4_STATE_QUOTER_ABI } from '../liquidity/v4-simulation.js';

const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x);
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;

// ---- FLV8_EDGE_09: consolidation parity (R9, §17 D1) ----
test('FLV8_EDGE_09 moved allocation math reproduces the pre-move golden outputs byte for byte', () => {
  // Golden values were produced by running the HEAD (pre-move) src/liquidity/price-gap.ts on these exact inputs.
  const e18 = 10n ** 18n, out: unknown[] = [];
  out.push(composeCurves([{ a: 1200n, b: 1000n, c: 1n }, { a: 1300n, b: 1100n, c: 2n }, { a: 997000n * 5n * e18, b: 1000000n * 3n * e18, c: 997000n }]));
  for (const [n, d] of [[0n, 1n], [5n, 10000n], [3n, 1000n]]) out.push(stationaryInput({ a: 140000n * e18, b: 100000n * e18, c: 1n }, n, d));
  out.push(allocateCpmm([{ a: 182n, b: 35n, c: 5n }, { a: 185n, b: 32n, c: 10n }, { a: 137n, b: 18n, c: 8n }], 6n, 1n));
  out.push(allocateCpmm([{ a: 997000n * 7n * e18, b: 1000000n * 5n * e18, c: 997000n }, { a: 997000n * 3n * e18, b: 1000000n * 2n * e18, c: 997000n }], e18, 10n ** 15n));
  assert.equal(json(out), '[{"a":"64805000000000000000000","b":"27500000000000000000000","c":"87500000000000012961"},"18321595661992320851346","18292026351106499940422","18144511608159810342840",["3","1","2"],["657000000000000000","343000000000000000"]]');
  // One implementation: the legacy module no longer defines its own copies.
  const legacy = readFileSync('src/liquidity/price-gap.ts', 'utf8');
  for (const name of ['composeCurves', 'stationaryInput', 'allocateCpmm']) assert.ok(!legacy.includes(`export function ${name}`), `${name} still defined in price-gap.ts`);
});

// ---- FLV8_EDGE_10: hook policy (D2) ----
test('FLV8_EDGE_10 a hooked pool is quoted for research but refused at live acceptance without an allowlist entry', async () => {
  const hooks = A(0xbeef), codeHash = keccak256('0x6001'), pool = `0x${'ab'.repeat(32)}`;
  assert.deepEqual(hookAdmission([{ pool, hooks, codeHash }], []), { ok: false, reason: 'HOOK_NOT_ALLOWLISTED', pools: [pool] });
  assert.deepEqual(hookAdmission([{ pool, hooks, codeHash }], [{ address: hooks, codeHash: keccak256('0x6002') }]).ok, false, 'a changed hook code hash is refused');
  assert.deepEqual(hookAdmission([{ pool, hooks, codeHash: null }], [{ address: hooks, codeHash }]).ok, false, 'an unreadable hook is refused');
  assert.deepEqual(hookAdmission([{ pool, hooks, codeHash }], [{ address: hooks.toUpperCase().replace('0X', '0x'), codeHash }]), { ok: true });
  assert.deepEqual(hookAdmission([{ pool, hooks: A(0), codeHash: null }], []), { ok: true }, 'hookless pools need no entry');
  // Research path: the quote runs the real hooked swap inside V4StateQuoter and is returned.
  const p: WatchPool = { address: pool as Address, protocol: 'uniswap-v4/hooked', token0: A(1), token1: A(2), kind: 'V4',
    v4: { manager: A(0x4444), id: pool as Hex, key: { currency0: A(1), currency1: A(2), fee: 3000, tickSpacing: 60, hooks }, tick: -120, hookCodeHash: codeHash } };
  const v4Result = (amount0: bigint, amount1: bigint) => encodeFunctionResult({ abi: V4_STATE_QUOTER_ABI, functionName: 'quoteExactInput',
    result: { delta: BigInt.asIntN(256, (BigInt.asUintN(128, amount0) << 128n) | BigInt.asUintN(128, amount1)), price: 1n, tick: 0, liquidity: 1n, protocolFee: 0, lpFee: 3000, bitmap: [0n], tickIndices: [], liquidityGross: [], liquidityNet: [] } } as never);
  let seenWords: readonly number[] = [];
  const client = (data: Hex) => ({ call: async (req: { data: Hex }) => { seenWords = (decodeFunctionData({ abi: V4_STATE_QUOTER_ABI, data: req.data }).args as unknown as [unknown, unknown, unknown, unknown, unknown, unknown, number[]])[6]; return { data }; } }) as unknown as PublicClient;
  assert.equal(await quoteV4(client(v4Result(-1000n, 950n)), '0x00', p, true, 1000n, 1n), 950n);
  assert.deepEqual(seenWords, [-1], 'tick -120 / spacing 60 = compressed -2 lives in word -1');
  assert.equal(await quoteV4(client(v4Result(-900n, 950n)), '0x00', p, true, 1000n, 1n), 0n, 'a partial fill is unfillable, never priced');
  assert.equal(await quoteV4(client(v4Result(-1000n, 0n)), '0x00', p, true, 1000n, 1n), 0n);
});

// ---- R0a / R1 intake: classification with flags off (v7 byte-identical) and on ----
const CL_ABI_RESULTS: Record<string, Record<string, unknown>> = {
  [A(0xa1)]: { token0: A(1), token1: A(2), slot0: 2n ** 96n, liquidity: 0n, fee: 500 },    // phantom: zero active liquidity
  [A(0xa2)]: { token0: A(1), token1: A(2), slot0: 2n ** 96n, liquidity: 10n ** 18n, fee: 500 },
  [A(0xa3)]: { token0: A(1), token1: A(3), slot0: 2n ** 96n, fee: 3000 },                  // liquidity() unreadable
};
const mockPools = () => ({
  getCode: async () => '0x6001',
  readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
    const v = CL_ABI_RESULTS[address.toLowerCase()]?.[functionName]; if (v === undefined) throw new Error('revert'); return v;
  },
}) as unknown as PublicClient;
const inventory = { pools: Object.keys(CL_ABI_RESULTS).map(address => ({ reference: { kind: 'evm_contract', chainId: 8453, address }, liquidity_eligible: true, protocol: 'uniswap', labels: ['v3'], asset_ids: [], price_usd: null })) };

test('FLV8 R0a classification is unchanged with flags off and drops phantom or unreadable CL pools with flags on', async () => {
  const off = await classifyPools(mockPools(), inventory, 8453, 1n);
  assert.deepEqual(off.pools.map(p => p.address), [A(0xa1), A(0xa2), A(0xa3)]);
  assert.equal(off.skipped, 0); assert.ok(off.pools.every(p => p.venue === undefined && p.feePips === undefined), 'no v8 fields when flags are off');
  const on = await classifyPools(mockPools(), inventory, 8453, 1n, undefined, { features: v8Features({}, ['all']) });
  assert.deepEqual(on.pools.map(p => p.address), [A(0xa2)]);
  assert.deepEqual(on.skipReasons, { ZERO_ACTIVE_LIQUIDITY: 1, STATE_UNAVAILABLE: 1 });
  assert.deepEqual([on.pools[0].venue, on.pools[0].feePips], [3, 500]);
});

test('FLV8 R1 V4 intake rejects a pool key that does not hash to the pool id and needs a manager', async () => {
  const key = { currency0: A(1), currency1: A(2), fee: 3000, tickSpacing: 60, hooks: A(0) };
  const entries = [{ reference: { kind: 'provider_opaque', providerPoolId: `0x${'11'.repeat(32)}` }, labels: ['v4'], liquidity_eligible: true, pool_key: key }];
  const withManager = await classifyPools(mockPools(), { pools: entries }, 8453, 1n, undefined, { features: v8Features({}, ['v4Quotes']), v4Manager: A(0x4444) });
  assert.deepEqual(withManager.skipReasons, { POOL_KEY_MISMATCH: 1 });
  const noManager = await classifyPools(mockPools(), { pools: entries }, 8453, 1n, undefined, { features: v8Features({}, ['v4Quotes']) });
  assert.deepEqual(noManager.skipReasons, { V4_MANAGER_UNKNOWN: 1 });
});

// ---- R0b token-behavior/1 ----
test('FLV8 R0b token probe reports taxed, blocked and unknown tokens from one slot search plus two transfers', async () => {
  const probeAbi = parseAbi(['function probeTransfer(address,address,uint256) returns (bool,uint256)']);
  const mock = (slotIndex: number | null, transfer: (to: Address) => [boolean, bigint]) => ({
    readContract: async (req: { stateOverride: { stateDiff: { value: Hex }[] }[] }) => slotIndex === null ? 0n : BigInt(req.stateOverride[0].stateDiff[slotIndex].value),
    call: async (req: { data: Hex }) => { const to = (decodeFunctionData({ abi: probeAbi, data: req.data }).args as [Address, Address, bigint])[1]; return { data: encodeFunctionResult({ abi: probeAbi, functionName: 'probeTransfer', result: transfer(to) }) }; },
  }) as unknown as PublicClient;
  const pool = A(0x9001), run = (c: PublicClient) => probeTokenBehavior(c, '0x00', A(0xc0ffee01), A(5), pool, 10_000n, 8453, 7n);
  const taxed = await run(mock(4, to => [true, to === pool ? 9_500n : 10_000n]));
  assert.deepEqual([taxed.status, taxed.transfer_tax_bps, taxed.sell_ok, taxed.blacklist_suspect], ['TAXED', 500, true, false], 'a sell-only tax is caught');
  assert.equal((await run(mock(0, () => [true, 10_000n]))).status, 'OK');
  const blocked = await run(mock(1, to => [to !== pool, to !== pool ? 10_000n : 0n]));
  assert.deepEqual([blocked.status, blocked.sell_ok], ['BLOCKED', false]);
  const unknown = await run(mock(null, () => [true, 10_000n]));
  assert.deepEqual([unknown.status, unknown.transfer_tax_bps], ['UNKNOWN', null], 'proxy/namespaced storage: no guess');
});

// ---- R0d acceptance threshold and flags ----
test('FLV8 R0d acceptance defaults reproduce the historic $10 floor and new knobs only raise it', () => {
  for (const [decimals, price] of [[6, 100_000_000n], [18, 350_000_000_000n], [8, 9_712_345_678_901n]] as const) {
    const historic = (1000000000n * 10n ** BigInt(decimals) + price - 1n) / price;
    assert.equal(acceptanceThreshold({}, decimals, price, 12345n), historic);
  }
  assert.equal(acceptanceThreshold({ minProfitUsd: 0.05 }, 6, 100_000_000n, 0n), 50_000n);
  assert.equal(acceptanceThreshold({ minProfitUsd: 0, gasSigmaK: 2 }, 6, 100_000_000n, 1_000n), 2_000n);
  assert.equal(acceptanceThreshold({ minProfitUsd: 0, bidShareBps: 5000 }, 6, 100_000_000n, 1_000n), 500n);
  assert.throws(() => acceptanceThreshold({ bidShareBps: 10_001 }, 6, 1n, 0n), /INVALID_ACCEPTANCE_THRESHOLD/);
});

test('FLV8 feature flags default off, accept explicit opt-in and fail closed on unknown keys', () => {
  const config = JSON.parse(readFileSync('config/flashloan-integration-versions.json', 'utf8'));
  assert.ok(Object.values(v8Features(config)).every(v => v === false), 'shipped config keeps every v8 flag off');
  assert.deepEqual(v8Features({}, ['foldSeed']), { activeLiquidity: false, tokenBehavior: false, measuredGas: false, v4Quotes: false, foldSeed: true });
  assert.throws(() => v8Features({ features: { v8: { live: true } } }), /features\.v8\.live/);
  assert.throws(() => v8Features({ features: { v8: { foldSeed: 'yes' } } }), /VERSION_UNSUPPORTED/);
  assert.throws(() => v8Features({}, ['typo']), /--v8 typo/);
});

// ---- FLV8_EDGE_02: V4 quote parity on a live chain (opt-in; never runs without an explicit RPC) ----
const BASE_V4_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b' as Address, BASE_V4_QUOTER = '0x0d5e0f971ed27fbff6c2837bf31316121532048d' as Address;
test('FLV8_EDGE_02 V4StateQuoter override equals the Uniswap V4Quoter to the wei on hookless and hooked Base pools', { skip: !process.env.FLV8_EDGE02_BASE_RPC && 'set FLV8_EDGE02_BASE_RPC to run against Base' }, async () => {
  const client = createPublicClient({ transport: http(process.env.FLV8_EDGE02_BASE_RPC, { timeout: 60_000, retryCount: 3 }) }) as PublicClient;
  const block = await client.getBlockNumber(), v4Code = (JSON.parse(readFileSync('out/V4StateQuoter.sol/V4StateQuoter.json', 'utf8')) as { deployedBytecode: { object: Hex } }).deployedBytecode.object;
  assert.ok((await client.getCode({ address: BASE_V4_QUOTER }))?.length, 'reference V4Quoter has code');
  const init = parseAbiItem('event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)');
  // Candidates: canonical hookless keys (no log scan needed), then best-effort Initialize pages for hooked pools.
  // Providers cap and rate-limit getLogs; a refused page is recorded, not fatal.
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address, ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;
  const { deriveV4PoolId } = await import('../state-adapters.js');
  const canonical = [[500, 10], [3000, 60], [100, 1]].map(([fee, tickSpacing]) => ({ currency0: ZERO_ADDR, currency1: USDC, fee, tickSpacing, hooks: ZERO_ADDR }));
  const logs: { args: { id: Hex; currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address; tick: number } }[] = canonical.map(k => ({ args: { ...k, id: deriveV4PoolId(k), tick: 0 } }));
  let refusedPages = 0;
  for (let page = 0n; page < 15n; page++) {
    const to = block - page * 2_000n;
    try { logs.push(...(await client.getLogs({ address: BASE_V4_MANAGER, event: init, fromBlock: to - 1_999n, toBlock: to, strict: true })).map(l => ({ args: l.args }))); } catch { refusedPages++; }
  }
  console.log(`FLV8_EDGE_02 candidates=${logs.length} refusedLogPages=${refusedPages}`);
  const ext = parseAbi(['function extsload(bytes32) view returns (bytes32)']);
  const { v4PoolStateSlot } = await import('../evm/v4-resolution.js');
  const ref = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)']);
  const checked = { hookless: 0, hooked: 0 };
  for (const l of logs) {
    const hooked = l.args.hooks !== '0x0000000000000000000000000000000000000000', kind = hooked ? 'hooked' : 'hookless';
    if (checked[kind] >= 2) continue;
    const liquidity = BigInt(await client.readContract({ address: BASE_V4_MANAGER, abi: ext, functionName: 'extsload', args: [v4PoolStateSlot(l.args.id, 3n)], blockNumber: block }));
    if (liquidity === 0n) continue;
    const slot0 = BigInt(await client.readContract({ address: BASE_V4_MANAGER, abi: ext, functionName: 'extsload', args: [v4PoolStateSlot(l.args.id, 0n)], blockNumber: block }));
    const rawTick = Number((slot0 >> 160n) & 0xffffffn), tick = rawTick >= 0x800000 ? rawTick - 0x1000000 : rawTick;
    const key = { currency0: l.args.currency0, currency1: l.args.currency1, fee: l.args.fee, tickSpacing: l.args.tickSpacing, hooks: l.args.hooks };
    const pool: WatchPool = { address: l.args.id as Address, protocol: 'v4', token0: key.currency0, token1: key.currency1, kind: 'V4', v4: { manager: BASE_V4_MANAGER, id: l.args.id, key, tick, hookCodeHash: null } };
    for (const amount of [10n ** 6n, 10n ** 12n, 10n ** 15n]) {
      let expected: bigint;
      try { expected = (await client.simulateContract({ address: BASE_V4_QUOTER, abi: ref, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: true, exactAmount: amount, hookData: '0x' }], blockNumber: block })).result[0]; }
      catch { expected = 0n; }
      const ours = await quoteV4(client, v4Code, pool, true, amount, block).catch(() => 0n);
      if (expected === 0n && ours === 0n) continue;
      console.log(`FLV8_EDGE_02 ${kind} ${l.args.id} amount=${amount} reference=${expected} ours=${ours}`);
      assert.equal(ours, expected, `${kind} pool ${l.args.id} at ${amount}`);
    }
    checked[kind]++;
    if (checked.hookless >= 2 && checked.hooked >= 2) break;
  }
  console.log(`FLV8_EDGE_02 checked ${json(checked)} at block ${block}${checked.hooked ? '' : ' (hooked parity NOT proven: no hooked candidates readable)'}`);
  assert.ok(checked.hookless >= 1, 'at least one live hookless pool compared');
});
