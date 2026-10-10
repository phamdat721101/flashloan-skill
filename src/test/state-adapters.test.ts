import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, type Address, type Hex } from 'viem';
import {
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

test('snapshots all V3 tick-walk inputs at one head and drops uninitialized bitmap positions', async () => {
  const snapshot = await snapshotUniswapV3(client(async ({ functionName, args }) => {
    if (functionName === 'token0') return token0;
    if (functionName === 'token1') return token1;
    if (functionName === 'fee') return 500n;
    if (functionName === 'tickSpacing') return 10n;
    if (functionName === 'slot0') return [100n, -20n, 0n, 0n, 0n, 0n, true];
    if (functionName === 'liquidity') return 5000n;
    if (functionName === 'tickBitmap') return 5n;
    if (functionName === 'ticks') return args?.[0] === 0 ? [10n, -3n, 0n, 0n, 0n, 0n, 0n, true] : [0n, 0n, 0n, 0n, 0n, 0n, 0n, false];
    throw new Error(`unexpected ${functionName}`);
  }), pool, [0], policy);
  assert.equal(snapshot.tick, -20);
  assert.equal(snapshot.sqrtPriceX96, '100');
  assert.deepEqual(snapshot.initializedTicks, [{ tick: 0, liquidityGross: '10', liquidityNet: '-3' }]);
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
  const snapshot = await snapshotUniswapV4(client(async ({ functionName }) => {
    assert.equal(functionName, 'extsload');
    return `0x${slot0.toString(16).padStart(64, '0')}` as Hex;
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
