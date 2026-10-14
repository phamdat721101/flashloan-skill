import { uint } from './state.js';

export interface V2State { reserve0: string; reserve1: string; feeNumerator: string; feeDenominator: string }
export interface Rational { numerator: string; denominator: string }
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new Error('INVALID_DIVISION');
  return a / b + (a % b === 0n ? 0n : 1n);
}
export function integerSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('INVALID_SQUARE_ROOT');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) { const next = (x + n / x) >> 1n; if (next >= x) return x; x = next; }
}
export function rational(n: bigint, d: bigint): Rational {
  if (n < 0n || d <= 0n) throw new Error('INVALID_PRICE');
  let a = n, b = d;
  while (b) [a, b] = [b, a % b];
  return { numerator: (n / a).toString(), denominator: (d / a).toString() };
}
export function priceWithDecimals(n: bigint, d: bigint, decimals0: number, decimals1: number): Rational {
  if (![decimals0, decimals1].every(v => Number.isInteger(v) && v >= 0 && v <= 255)) throw new Error('INVALID_DECIMALS');
  return rational(n * 10n ** BigInt(decimals0), d * 10n ** BigInt(decimals1));
}
export function validateV2(state: V2State): void {
  const x = uint(state.reserve0, 112), y = uint(state.reserve1, 112);
  const f = uint(state.feeNumerator, 32), d = uint(state.feeDenominator, 32);
  if (!x || !y || !f || f > d) throw new Error('V2_INVALID_STATE');
}
/** Fee numerator is the retained input multiplier, not the charged fee. */
export function projectV2(state: V2State, zeroForOne: boolean, amount: string) {
  validateV2(state);
  const input = uint(amount), x = uint(zeroForOne ? state.reserve0 : state.reserve1, 112), y = uint(zeroForOne ? state.reserve1 : state.reserve0, 112);
  const f = uint(state.feeNumerator, 32), d = uint(state.feeDenominator, 32);
  const output = input * f * y / (x * d + input * f);
  const nextIn = x + input, nextOut = y - output;
  if (nextIn >= 1n << 112n) throw new Error('V2_RESERVE_OVERFLOW');
  return { amountOut: output.toString(), feeAmount: ceilDiv(input * (d - f), d).toString(),
    state: { ...state, reserve0: (zeroForOne ? nextIn : nextOut).toString(), reserve1: (zeroForOne ? nextOut : nextIn).toString() } };
}
/** Smallest native input reaching a raw token1/token0 target; integer quote is authoritative. */
export function v2InputForPrice(state: V2State, zeroForOne: boolean, target: Rational, maximum: string): string {
  validateV2(state);
  const n = uint(target.numerator), d = uint(target.denominator);
  if (!n || !d) throw new Error('INVALID_PRICE');
  const reaches = (amount: bigint) => {
    const next = projectV2(state, zeroForOne, amount.toString()).state;
    const left = uint(next.reserve1) * d, right = uint(next.reserve0) * n;
    return zeroForOne ? left <= right : left >= right;
  };
  let lower = 0n, upper = uint(maximum);
  const inputReserve = uint(zeroForOne ? state.reserve0 : state.reserve1,112);
  const capacity = (1n << 112n) - 1n - inputReserve;
  if (upper > capacity) upper = capacity;
  if (reaches(0n)) return '0';
  if (!reaches(upper)) throw new Error('TARGET_PRICE_UNREACHABLE');
  while (lower < upper) { const middle = (lower + upper) >> 1n; if (reaches(middle)) upper = middle; else lower = middle + 1n; }
  return lower.toString();
}
/** Continuous stationary point seed; never a certificate for rounded quotes. */
export function v2StationarySeed(first: V2State, second: V2State, firstZeroForOne: boolean, secondZeroForOne: boolean, flashNumerator: bigint, flashDenominator: bigint): bigint {
  validateV2(first); validateV2(second);
  if (flashNumerator < 0n || flashDenominator <= 0n) throw new Error('INVALID_LENDER_FEE');
  const x = uint(firstZeroForOne ? first.reserve0 : first.reserve1), y = uint(firstZeroForOne ? first.reserve1 : first.reserve0);
  const u = uint(secondZeroForOne ? second.reserve0 : second.reserve1), v = uint(secondZeroForOne ? second.reserve1 : second.reserve0);
  const f = uint(first.feeNumerator), d = uint(first.feeDenominator), g = uint(second.feeNumerator), e = uint(second.feeDenominator);
  const a = f * g * y * v, b = x * u * d * e, c = f * (u * e + g * y);
  const root = integerSqrt(a * b * flashDenominator / (flashDenominator + flashNumerator));
  return root > b ? (root - b) / c : 0n;
}
