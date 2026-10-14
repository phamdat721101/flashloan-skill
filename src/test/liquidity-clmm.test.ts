import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveV4PoolId, type StateClient, type V3Snapshot, type V4Snapshot } from '../state-adapters.js';
import { quoteV3ExactInput, quoteV4ExactInput, sqrtRatioAtTick } from '../liquidity/clmm.js';
import { simulateV4Projection } from '../liquidity/v4-simulation.js';
import { digest } from '../liquidity/state.js';
import { keccak256 } from 'viem';
import type { PoolStateEnvelope } from '../liquidity/projection.js';

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
test('VM-backed V4 projection preserves post-hook bitmap/ticks, exact delta, code pins and sender semantics', async () => {
  const hash = `0x${'a'.repeat(64)}` as const, key = { currency0: token0,currency1: token1,fee: 0x800000,tickSpacing: 1,hooks: `0x${'3'.repeat(40)}` as const };
  const pool: PoolStateEnvelope = { schemaVersion: '4.0',identity: { chain: 'arbitrum',network: '42161',height: '1',blockHash: hash },poolId: 'arbitrum:42161:fixture-v4',poolAddress: token0,adapterRevision: 'fixture-v4-state-quoter',revisionHash: keccak256('0x6000'),token0,token1,decimals0: 18,decimals1: 18,stateClass: 'canonical',appliedOperations: [],state: { protocol: 'uniswap-v4',sqrtPriceX96: sqrtRatioAtTick(0).toString(),tick: 0,liquidity: '1000000',tickSpacing: 1,lowerTick: -200,upperTick: 200,bitmapWords: [{ wordPosition: -1,bitmap: '0' },{ wordPosition: 0,bitmap: '0' }],initializedTicks: [],key,poolId: deriveV4PoolId(key),protocolFeePips: 0,lpFeePips: 3000 } };
  const request = { schemaVersion: '4.0',snapshotDigest: digest(pool),operationId: 'fixture-swap',operationClass: 'hypothetical',tokenIn: token0,amountIn: '1000' };
  let drift = false, reorg = false, reads = 0; const pinned: bigint[] = [];
  const client: StateClient = { getChainId: async () => 42161,getBlock: async () => ({ number: 1n,timestamp: 1000n,hash: reorg && ++reads > 1 ? `0x${'b'.repeat(64)}` : hash }),getCode: async args => { pinned.push(args.blockNumber); return drift ? '0x6001' : '0x6000'; },readContract: async args => {
    pinned.push(args.blockNumber); assert.equal(args.functionName,'quoteExactInput'); assert.deepEqual(args.args!.at(-1),[-1,0]);
    return { delta: (-1000n << 128n) | 996n,price: sqrtRatioAtTick(0) - 1n,tick: -1,liquidity: 1500000n,protocolFee: 0,lpFee: 3000,bitmap: [0n,1n << 60n],tickIndices: [60],liquidityGross: [500000n],liquidityNet: [500000n] };
  } };
  const binding = { quoter: `0x${'4'.repeat(40)}` as const,quoterCodeHash: keccak256('0x6000'),hookCodeHash: keccak256('0x6000'),hookData: '0x' as const }, result = await simulateV4Projection(client,pool,request,binding);
  assert.equal(result.amountOut,'996'); assert.equal(result.consumedInput,'1000'); assert.equal(result.semantics,'quoter-sender'); assert.equal(result.eligibility,'simulation-required'); assert.equal(result.projectedState.stateClass,'projected');
  assert.equal(result.projectedState.state.protocol,'uniswap-v4');
  if (result.projectedState.state.protocol === 'uniswap-v4') { assert.equal(result.projectedState.state.liquidity,'1500000'); assert.equal(result.projectedState.state.initializedTicks[0].tick,60); }
  assert.ok(pinned.every(block => block === 1n)); assert.equal(pool.appliedOperations.length,0);
  drift = true; await assert.rejects(simulateV4Projection(client,pool,request,binding),/CODE_CHANGED/);
  drift = false; reorg = true; reads = 0; await assert.rejects(simulateV4Projection(client,pool,request,binding),/BLOCK_REORG/);
  await assert.rejects(simulateV4Projection(client,result.projectedState,{ ...request,snapshotDigest: result.projectedStateDigest },binding),/UNSUPPORTED_V4_SIMULATION_STATE/);
});
