/** Exact decimal and token-unit helpers for economic safety boundaries. */
export function parseDecimal(value: string, scale: number, field: string): bigint {
  if (!Number.isInteger(scale) || scale < 0) throw new Error(`${field} scale is invalid`);
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`${field} must be a positive decimal string`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new Error(`${field} has more than ${scale} decimal places`);
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0');
}

/** Divides positive integers upward so a configured floor can never be rounded down. */
export function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('ceil division requires non-negative numerator and positive denominator');
  return (numerator + denominator - 1n) / denominator;
}

/** Converts a USD floor (1e8) to native token units from a USD/token price (1e8). */
export function usdFloorToTokenWei(usdFloorE8: bigint, tokenUsdE8: bigint, tokenDecimals: number): bigint {
  if (usdFloorE8 <= 0n || tokenUsdE8 <= 0n || !Number.isInteger(tokenDecimals) || tokenDecimals < 0) throw new Error('profit valuation is invalid');
  return divCeil(usdFloorE8 * 10n ** BigInt(tokenDecimals), tokenUsdE8);
}
