import assert from 'node:assert/strict';
import test from 'node:test';
import { concatHex, keccak256, padHex, toHex, type Address, type Hex } from 'viem';
import {
  assertTickWindowCoverage,
  poolIdFromKey,
  snapshotAlgebraIntegral,
  snapshotUniswapV3,
  snapshotUniswapV4,
  type AdapterPolicy,
  type StateClient,
  type V4PoolKey
} from '../state-adapters.js';

const pool = '0x1111111111111111111111111111111111111111' as Address;
const token0 = '0x2222222222222222222222222222222222222222' as Address;
const token1 = '0x3333333333333333333333333333333333333333' as Address;
const code = '0x6000' as Hex;
const policy: AdapterPolicy = { chainId: 42161, expectedRuntimeCodeHash: keccak256(code), maxBitmapWords: 2 };

function client(readContract: StateClient['readContract']): StateClient {
  return {
    getChainId: async () => 42161,
    getBlock: async () => ({ number: 42n, hash: `0x${'a'.repeat(64)}` as Hex, timestamp: 1000n }),
    getCode: async () => code,
    readContract
  };
}

test('snapshots every initialized V3 bitmap tick at one head', async () => {
  const snapshot = await snapshotUniswapV3(client(async ({ functionName, args }) => {
    if (functionName === 'token0') return token0;
    if (functionName === 'token1') return token1;
    if (functionName === 'fee') return 500n;
    if (functionName === 'tickSpacing') return 10n;
    if (functionName === 'slot0') return [100n, -20n, 0n, 0n, 0n, 0n, true];
    if (functionName === 'liquidity') return 5000n;
    if (functionName === 'tickBitmap') return 5n;
    if (functionName === 'ticks') return args?.[0] === 0 ? [10n, -3n, 0n, 0n, 0n, 0n, 0n, true] : [8n, 1n, 0n, 0n, 0n, 0n, 0n, true];
    throw new Error(`unexpected ${functionName}`);
  }), pool, [0], policy);
  assert.equal(snapshot.tick, -20);
  assert.equal(snapshot.sqrtPriceX96, '100');
  assert.deepEqual(snapshot.initializedTicks, [{ tick: 0, liquidityGross: '10', liquidityNet: '-3' }, { tick: 20, liquidityGross: '8', liquidityNet: '1' }]);
});

test('tick snapshot fan-out is bounded and preserves every bitmap-derived record', async () => {
  let active = 0, peak = 0;
  const fixture = client(async ({ functionName }) => {
    if (functionName === 'token0') return token0;
    if (functionName === 'token1') return token1;
    if (functionName === 'fee') return 500n;
    if (functionName === 'tickSpacing') return 10n;
    if (functionName === 'slot0') return [100n,0n,0n,0n,0n,0n,true];
    if (functionName === 'liquidity') return 5000n;
    if (functionName === 'tickBitmap') return 65535n;
    if (functionName === 'ticks') {
      peak = Math.max(peak,++active);
      await new Promise(resolve => setImmediate(resolve)); active--;
      return [10n,1n,0n,0n,0n,0n,0n,true];
    }
    throw new Error('unexpected call');
  });
  const state = await snapshotUniswapV3(fixture,pool,[0],{ ...policy,readConcurrency: 2 });
  assert.equal(state.initializedTicks.length,16); assert.equal(peak,2);
  assert.deepEqual(state.initializedTicks.map(t => t.tick),Array.from({ length: 16 },(_,i) => i * 10));
  await assert.rejects(snapshotUniswapV3(fixture,pool,[0],{ ...policy,readConcurrency: 0 }),/INVALID_READ_CONCURRENCY/);
});

test('a set V3 or Algebra bitmap bit with missing initialized state rejects the snapshot', async () => {
  const inconsistent = client(async ({ functionName }) => {
    if (functionName === 'token0') return token0;
    if (functionName === 'token1') return token1;
    if (functionName === 'fee') return 500n;
    if (functionName === 'tickSpacing') return 10n;
    if (functionName === 'slot0' || functionName === 'globalState') return [100n, 0n, 500n, 0n, 0n, 0n, true];
    if (functionName === 'liquidity') return 5000n;
    if (functionName === 'tickBitmap' || functionName === 'tickTable') return 1n;
    if (functionName === 'ticks') return [0n, 0n, 0n, 0n, 0n, 0n, 0n, false];
    throw new Error('unexpected call');
  });
  await assert.rejects(() => snapshotUniswapV3(inconsistent, pool, [0], policy), /ADAPTER_BITMAP_TICK_MISMATCH/);
  await assert.rejects(() => snapshotAlgebraIntegral(inconsistent, pool, [0], policy), /ADAPTER_BITMAP_TICK_MISMATCH/);
});

test('uses Algebra dynamic fee and tickTable rather than the V3 ABI', async () => {
  const snapshot = await snapshotAlgebraIntegral(client(async ({ functionName, args }) => {
    if (functionName === 'token0') return token0;
    if (functionName === 'token1') return token1;
    if (functionName === 'globalState') return [200n, 15n, 777n, 0n, 0n, 0n, true];
    if (functionName === 'liquidity') return 7000n;
    if (functionName === 'tickSpacing') return 5n;
    if (functionName === 'tickTable') return 2n;
    if (functionName === 'ticks') return args?.[0] === 5 ? [11n, 4n, 0n, 0n, 0n, 0n, 0n, true] : [0n, 0n, 0n, 0n, 0n, 0n, 0n, false];
    throw new Error(`unexpected ${functionName}`);
  }), pool, [0], policy);
  assert.equal(snapshot.feePips, 777);
  assert.deepEqual(snapshot.initializedTicks, [{ tick: 5, liquidityGross: '11', liquidityNet: '4' }]);
});

test('rejects V4 hooked keys and decodes no-hook StateLibrary slot zero', async () => {
  const key: V4PoolKey = { currency0: token0, currency1: token1, fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' };
  const slot0 = 7n | (5n << 160n) | (9n << 184n) | (500n << 208n);
  const stateSlot = keccak256(concatHex([poolIdFromKey(key), padHex(toHex(6n), { size: 32 })]));
  const snapshot = await snapshotUniswapV4(client(async ({ functionName, args }) => {
    assert.equal(functionName, 'extsload');
    return args?.[0] === stateSlot ? `0x${slot0.toString(16).padStart(64, '0')}` as Hex : padHex('0x0', { size: 32 });
  }), pool, key, [0], policy);
  assert.equal(snapshot.poolId, poolIdFromKey(key));
  assert.equal(snapshot.sqrtPriceX96, '7');
  assert.equal(snapshot.tick, 5);
  assert.equal(snapshot.protocolFeePips, 9);
  assert.equal(snapshot.lpFeePips, 500);
  assert.throws(() => poolIdFromKey({ ...key, hooks: token0 }), /V4_POOL_KEY_REJECTED/);
});

test('rejects a code-hash drift before state is trusted', async () => {
  await assert.rejects(() => snapshotUniswapV3(client(async () => 0n), pool, [0], { ...policy, expectedRuntimeCodeHash: `0x${'b'.repeat(64)}` }), /ADAPTER_CODE_HASH_MISMATCH/);
});

test('a set V4 bitmap bit with zero gross liquidity rejects the snapshot', async () => {
  const key: V4PoolKey = { currency0: token0, currency1: token1, fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' };
  const base = keccak256(concatHex([poolIdFromKey(key), padHex(toHex(6n), { size: 32 })]));
  const bitmapSlot = keccak256(concatHex([padHex('0x0', { size: 32 }), padHex(toHex(BigInt(base) + 5n), { size: 32 })]));
  const inconsistent = client(async ({ args }) => args?.[0] === bitmapSlot ? padHex('0x1', { size: 32 }) : padHex('0x0', { size: 32 }));
  await assert.rejects(() => snapshotUniswapV4(inconsistent, pool, key, [0], policy), /ADAPTER_BITMAP_TICK_MISMATCH/);
});

test('a quote horizon cannot bridge missing bitmap words or omit initialized liquidity boundaries', () => {
  const snapshot = { tick: -1, tickSpacing: 10, bitmapWords: [{ wordPosition: -1, bitmap: '0' }, { wordPosition: 0, bitmap: '1' }], initializedTicks: [{ tick: 0, liquidityGross: '10', liquidityNet: '-3' }] };
  assert.doesNotThrow(() => assertTickWindowCoverage(snapshot, -10, 10));
  assert.throws(() => assertTickWindowCoverage({ ...snapshot, bitmapWords: snapshot.bitmapWords.slice(1) }, -10, 10), /TICK_COVERAGE_INCOMPLETE/);
  assert.throws(() => assertTickWindowCoverage({ ...snapshot, initializedTicks: [] }, -10, 10), /TICK_COVERAGE_INCOMPLETE/);
  assert.throws(() => assertTickWindowCoverage(snapshot, 0, 10), /INVALID_QUOTE_HORIZON/);
  assert.throws(() => assertTickWindowCoverage({ ...snapshot, initializedTicks: [...snapshot.initializedTicks, { tick: 10, liquidityGross: '10', liquidityNet: '1' }] }, -10, 10), /BITMAP_TICK_MISMATCH/);
});
