// SPDX-License-Identifier: GPL-2.0-or-later
// Tick conversion constants adapted from Uniswap v3-core TickMath.sol (GPL-2.0-or-later).
// Exact-input arithmetic follows canonical SqrtPriceMath/SwapMath semantics.
import { assertTickWindowCoverage, type V3Snapshot, type V4Snapshot } from '../state-adapters.js';
import { digest, uint } from './state.js';

const Q96 = 1n << 96n, U256_MAX = (1n << 256n) - 1n, PIPS = 1_000_000n;
const MIN_TICK = -887272, MAX_TICK = 887272;
const RATIOS = [
  'fffcb933bd6fad37aa2d162d1a594001', 'fff97272373d413259a46990580e213a',
  'fff2e50f5f656932ef12357cf3c7fdcc', 'ffe5caca7e10e4e61c3624eaa0941cd0',
  'ffcb9843d60f6159c9db58835c926644', 'ff973b41fa98c081472e6896dfb254c0',
  'ff2ea16466c96a3843ec78b326b52861', 'fe5dee046a99a2a811c461f1969c3053',
  'fcbe86c7900a88aedcffc83b479aa3a4', 'f987a7253ac413176f2b074cf7815e54',
  'f3392b0822b70005940c7a398e4b70f3', 'e7159475a2c29b7443b29c7fa6e889d9',
  'd097f3bdfd2022b8845ad8f792aa5825', 'a9f746462d870fdf8a65dc1f90e061e5',
  '70d869a156d2a1b890bb3df62baf32f7', '31be135f97d08fd981231505542fcfa6',
  '9aa508b5b7a84e1c677de54f3e99bc9', '5d6af8dedb81196699c329225ee604',
  '2216e584f5fa1ea926041bedfe98', '48a170391f7dc42444e8fa2'
].map(value => BigInt(`0x${value}`));
const ceil = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;

export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error('CLMM_INVALID_TICK');
  const absolute = Math.abs(tick); let ratio = 1n << 128n;
  for (let bit = 0; bit < RATIOS.length; bit++) if ((absolute & (1 << bit)) !== 0) ratio = ratio * RATIOS[bit] >> 128n;
  if (tick > 0) ratio = U256_MAX / ratio;
  return ceil(ratio, 1n << 32n);
}
function tickAtRatio(ratio: bigint): number {
  let lower = MIN_TICK, upper = MAX_TICK;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (sqrtRatioAtTick(middle) <= ratio) lower = middle; else upper = middle - 1;
  }
  return lower;
}
function delta0(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const numerator = (liquidity << 96n) * (b - a);
  return roundUp ? ceil(ceil(numerator, b), a) : numerator / b / a;
}
function delta1(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const numerator = liquidity * (b - a);
  return roundUp ? ceil(numerator, Q96) : numerator / Q96;
}
function nextPrice(price: bigint, liquidity: bigint, input: bigint, zeroForOne: boolean): bigint {
  if (!input) return price;
  if (!zeroForOne) return price + input * Q96 / liquidity;
  const numerator = liquidity << 96n, product = input * price;
  return product <= U256_MAX && numerator + product <= U256_MAX
    ? ceil(numerator * price, numerator + product)
    : ceil(numerator, numerator / price + input);
}

export interface V3Quote {
  schemaVersion: '3.0'; protocol: 'uniswap-v3' | 'uniswap-v4'; snapshotDigest: string; tokenIn: string; amountIn: string;
  amountOut: string; feeAmount: string; sqrtPriceAfterX96: string;
  liquidityAfter: string; tickAfter: number; crossedTicks: number[]; steps: number;
}

/** Exact-input V3 swap over a proven bounded bitmap horizon. No invented tick coverage.
 * Empty bitmap-word boundaries still take swap steps and their own fee rounding.
 */
export function quoteV3ExactInput(snapshot: V3Snapshot, tokenIn: string, amount: string, lowerTick: number, upperTick: number, maxSteps = 4096): V3Quote {
  if (snapshot.protocol !== 'uniswap-v3' || !snapshot.unlocked || !Number.isInteger(snapshot.feePips) || snapshot.feePips < 0 || snapshot.feePips >= 1_000_000 || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 4096 || snapshot.bitmapWords.length > 256 || snapshot.initializedTicks.length > 10000) throw new Error('CLMM_UNSUPPORTED_STATE');
  assertTickWindowCoverage(snapshot, lowerTick, upperTick);
  const zeroForOne = tokenIn.toLowerCase() === snapshot.token0.toLowerCase();
  if (!zeroForOne && tokenIn.toLowerCase() !== snapshot.token1.toLowerCase()) throw new Error('CLMM_INVALID_TOKEN');
  let remaining = uint(amount), price = uint(snapshot.sqrtPriceX96, 160), liquidity = uint(snapshot.liquidity, 128), tick = snapshot.tick;
  if (!remaining || remaining >= 1n << 255n || !Number.isInteger(tick) || tick < MIN_TICK || tick >= MAX_TICK || price < sqrtRatioAtTick(MIN_TICK) || price >= sqrtRatioAtTick(MAX_TICK) || price < sqrtRatioAtTick(tick) || price > sqrtRatioAtTick(tick + 1)) throw new Error('CLMM_INVALID_STATE');
  // Pool.swap excludes the absolute min/max sqrt ratios as swap limits.
  const limit = zeroForOne ? sqrtRatioAtTick(lowerTick) + (lowerTick === MIN_TICK ? 1n : 0n)
    : sqrtRatioAtTick(upperTick) - (upperTick === MAX_TICK ? 1n : 0n);
  if (zeroForOne ? limit >= price : limit <= price) throw new Error('CLMM_INVALID_LIMIT');
  const words = new Map(snapshot.bitmapWords.map(word => [word.wordPosition, BigInt(word.bitmap)]));
  const ticks = new Map(snapshot.initializedTicks.map(state => [state.tick, state]));
  const crossedTicks: number[] = []; let output = 0n, fees = 0n, steps = 0;
  while (remaining > 0n) {
    if (steps++ >= maxSteps) throw new Error('CLMM_STEP_LIMIT');
    let compressed = Math.floor(tick / snapshot.tickSpacing);
    if (!zeroForOne) compressed++;
    const position = Math.floor(compressed / 256), bit = compressed - position * 256;
    const bitmap = words.get(position);
    if (bitmap === undefined) throw new Error('CLMM_COVERAGE_EXHAUSTED');
    let next = zeroForOne ? compressed - bit : compressed + 255 - bit;
    let initialized = false;
    for (let candidate = bit; zeroForOne ? candidate >= 0 : candidate <= 255; candidate += zeroForOne ? -1 : 1) {
      if ((bitmap & (1n << BigInt(candidate))) !== 0n) { next = position * 256 + candidate; initialized = true; break; }
    }
    const nextTick = Math.min(MAX_TICK, Math.max(MIN_TICK, next * snapshot.tickSpacing));
    const boundary = sqrtRatioAtTick(nextTick);
    const target = zeroForOne ? (boundary < limit ? limit : boundary) : (boundary > limit ? limit : boundary);
    const available = remaining * (PIPS - BigInt(snapshot.feePips)) / PIPS;
    const toTarget = zeroForOne ? delta0(target, price, liquidity, true) : delta1(price, target, liquidity, true);
    const nextRatio = available >= toTarget ? target : nextPrice(price, liquidity, available, zeroForOne);
    const used = zeroForOne ? delta0(nextRatio, price, liquidity, true) : delta1(price, nextRatio, liquidity, true);
    const received = zeroForOne ? delta1(nextRatio, price, liquidity, false) : delta0(price, nextRatio, liquidity, false);
    const fee = nextRatio === target ? ceil(used * BigInt(snapshot.feePips), PIPS - BigInt(snapshot.feePips)) : remaining - used;
    if (used + fee > remaining || received < 0n) throw new Error('CLMM_MATH_INVARIANT');
    remaining -= used + fee; output += received; fees += fee; price = nextRatio;
    if (price === boundary) {
      if (initialized) {
        const state = ticks.get(nextTick);
        if (!state) throw new Error('CLMM_COVERAGE_EXHAUSTED');
        const net = BigInt(state.liquidityNet);
        liquidity += zeroForOne ? -net : net;
        if (liquidity < 0n || liquidity >= 1n << 128n) throw new Error('CLMM_LIQUIDITY_OVERFLOW');
        crossedTicks.push(nextTick);
      }
      tick = zeroForOne ? nextTick - 1 : nextTick;
    } else tick = tickAtRatio(price);
    if (remaining && price === limit) throw new Error('CLMM_COVERAGE_EXHAUSTED');
  }
  if (output > U256_MAX) throw new Error('CLMM_OUTPUT_OVERFLOW');
  return { schemaVersion: '3.0', protocol: 'uniswap-v3', snapshotDigest: digest({ ...snapshot, block: { ...snapshot.block, number: snapshot.block.number.toString(), timestamp: snapshot.block.timestamp.toString() } }), tokenIn, amountIn: amount, amountOut: output.toString(), feeAmount: fees.toString(), sqrtPriceAfterX96: price.toString(), liquidityAfter: liquidity.toString(), tickAfter: tick, crossedTicks, steps };
}

/** Static-fee, ERC-20, no-hook V4 only. Directional protocol fees are packed
 * independently and composed with the LP fee before the shared swap arithmetic.
 */
export function quoteV4ExactInput(snapshot: V4Snapshot, tokenIn: string, amount: string, lowerTick: number, upperTick: number, maxSteps = 4096): V3Quote {
  const { key } = snapshot;
  const zero = '0x0000000000000000000000000000000000000000';
  const packed = snapshot.protocolFeePips;
  if (snapshot.protocol !== 'uniswap-v4' || key.hooks.toLowerCase() !== zero || key.currency0.toLowerCase() === zero || !Number.isInteger(key.fee) || key.fee < 0 || key.fee >= 1_000_000 || snapshot.lpFeePips !== key.fee || !Number.isInteger(packed) || packed < 0 || packed > 0xffffff || (packed & 0xfff) > 1000 || (packed >> 12) > 1000) throw new Error('CLMM_UNSUPPORTED_V4_STATE');
  const protocol = tokenIn.toLowerCase() === key.currency0.toLowerCase() ? packed & 0xfff : packed >> 12;
  const fee = protocol + snapshot.lpFeePips - Math.floor(protocol * snapshot.lpFeePips / 1_000_000);
  const result = quoteV3ExactInput({ protocol: 'uniswap-v3', block: snapshot.block, pool: snapshot.poolManager, runtimeCodeHash: snapshot.runtimeCodeHash, token0: key.currency0, token1: key.currency1, feePips: fee, tickSpacing: key.tickSpacing, sqrtPriceX96: snapshot.sqrtPriceX96, tick: snapshot.tick, liquidity: snapshot.liquidity, unlocked: true, bitmapWords: snapshot.bitmapWords, initializedTicks: snapshot.initializedTicks }, tokenIn, amount, lowerTick, upperTick, maxSteps);
  return { ...result, protocol: 'uniswap-v4', snapshotDigest: digest({ ...snapshot, block: { ...snapshot.block, number: snapshot.block.number.toString(), timestamp: snapshot.block.timestamp.toString() } }) };
}
