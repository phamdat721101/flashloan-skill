import assert from 'node:assert/strict';
import test from 'node:test';
import type { V3Snapshot, V4Snapshot } from '../state-adapters.js';
import { quoteV3ExactInput, quoteV4ExactInput, sqrtRatioAtTick } from '../liquidity/clmm.js';

const token0 = `0x${'1'.repeat(40)}` as const, token1 = `0x${'2'.repeat(40)}` as const;
function snapshot(ticks: Array<{ tick: number; liquidityNet: string; liquidityGross: string }> = []): V3Snapshot {
  const words = new Map<number, bigint>([[-1, 0n], [0, 0n], [1, 0n]]);
  for (const tick of ticks) {
    const word = Math.floor(tick.tick / 256), bit = tick.tick - word * 256;
    words.set(word, (words.get(word) ?? 0n) | (1n << BigInt(bit)));
  }
  return { protocol: 'uniswap-v3', block: { chainId: 42161, number: 1n, hash: `0x${'a'.repeat(64)}`, timestamp: 1000n }, pool: token0, runtimeCodeHash: `0x${'b'.repeat(64)}`, token0, token1, feePips: 3000, tickSpacing: 1, sqrtPriceX96: '79228162514264337593543950336', tick: 0, liquidity: '1000000000000', unlocked: true, bitmapWords: [...words].map(([wordPosition, bitmap]) => ({ wordPosition, bitmap: bitmap.toString() })), initializedTicks: ticks };
}
test('canonical TickMath endpoints and independent Q96 vectors', () => {
  assert.equal(sqrtRatioAtTick(0), 79228162514264337593543950336n);
  assert.equal(sqrtRatioAtTick(-887272), 4295128739n);
  assert.equal(sqrtRatioAtTick(887272), 1461446703485210103287273052203988822378723970342n);
  assert.equal(sqrtRatioAtTick(1), 79232123823359799118286999568n);
  assert.throws(() => sqrtRatioAtTick(887273), /INVALID_TICK/);
});
test('exact-input quotes respect directional rounding, fee dust and immutable inputs', () => {
  const state = snapshot(), before = structuredClone(state);
  for (const token of [token0, token1]) {
    const result = quoteV3ExactInput(state, token, '1000', -200, 200);
    assert.equal(result.amountOut, '996'); assert.equal(result.feeAmount, '3');
    assert.deepEqual(result.crossedTicks, []);
    const dust = quoteV3ExactInput(state, token, '1', -200, 200);
    assert.equal(dust.amountOut, '0'); assert.equal(dust.feeAmount, '1');
  }
  assert.deepEqual(state, before);
});
test('crosses initialized ticks in both directions with signed liquidity changes', () => {
  for (const direction of [-1, 1]) {
    const boundary = direction * 60;
    const state = snapshot([{ tick: boundary, liquidityGross: '500000000000', liquidityNet: '500000000000' }]);
    const result = quoteV3ExactInput(state, direction === -1 ? token0 : token1, '4000000000', -200, 200);
    assert.deepEqual(result.crossedTicks, [boundary]);
    assert.equal(result.liquidityAfter, direction === -1 ? '500000000000' : '1500000000000');
    assert.ok(BigInt(result.amountOut) > 0n); assert.ok(result.steps >= 2);
  }
});
test('missing bitmap coverage, exceeded horizons and step limits fail closed', () => {
  const state = snapshot();
  assert.throws(() => quoteV3ExactInput({ ...state, bitmapWords: state.bitmapWords.filter(word => word.wordPosition !== -1) }, token0, '1000', -200, 200), /COVERAGE/);
  assert.throws(() => quoteV3ExactInput(state, token1, '1000000000000', -200, 200), /COVERAGE_EXHAUSTED/);
  assert.throws(() => quoteV3ExactInput(state, token0, '1000', -200, 200, 1), /STEP_LIMIT/);
  assert.throws(() => quoteV3ExactInput({ ...state, protocol: 'algebra-integral' } as unknown as V3Snapshot, token0, '1000', -200, 200), /UNSUPPORTED_STATE/);
});

test('static no-hook V4 composes directional protocol and LP fees and rejects hooks or dynamic fees', () => {
  const v3 = snapshot();
  const state: V4Snapshot = { protocol: 'uniswap-v4', block: v3.block, poolManager: token0, poolId: `0x${'c'.repeat(64)}`, runtimeCodeHash: v3.runtimeCodeHash, key: { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 1, hooks: '0x0000000000000000000000000000000000000000' }, sqrtPriceX96: v3.sqrtPriceX96, tick: v3.tick, liquidity: v3.liquidity, bitmapWords: v3.bitmapWords, initializedTicks: v3.initializedTicks, protocolFeePips: 100 + (1000 << 12), lpFeePips: 3000 };
  for (const [token, fee] of [[token0, 3100], [token1, 3997]] as const) {
    const result = quoteV4ExactInput(state, token, '1000000', -200, 200);
    const reference = quoteV3ExactInput({ ...v3, feePips: fee }, token, '1000000', -200, 200);
    assert.equal(result.amountOut, reference.amountOut); assert.equal(result.feeAmount, reference.feeAmount);
    assert.equal(result.protocol, 'uniswap-v4'); assert.notEqual(result.snapshotDigest, reference.snapshotDigest);
  }
  assert.throws(() => quoteV4ExactInput({ ...state, key: { ...state.key, hooks: token0 } }, token0, '1000', -200, 200), /UNSUPPORTED_V4/);
  assert.throws(() => quoteV4ExactInput({ ...state, key: { ...state.key, fee: 0x800000 } }, token0, '1000', -200, 200), /UNSUPPORTED_V4/);
});
