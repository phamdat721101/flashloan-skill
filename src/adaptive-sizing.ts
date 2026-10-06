/**
 * Chooses a trade amount from live bounds instead of a fixed list of USD tiers.
 * The caller owns quoting and must use exact route calldata for each observation.
 */
export interface SizingBounds {
  minAmount: bigint;
  maxAmount: bigint;
  maxEvaluations?: number;
  maxPriceImpactBps: number;
}

export interface SizeQuote {
  amountIn: bigint;
  netProfitUsd: number;
  priceImpactBps: number;
  quoteBlock: bigint;
}

export interface AdaptiveSizingResult {
  winner?: SizeQuote;
  evaluated: SizeQuote[];
}

export type SizeQuoter = (amountIn: bigint) => Promise<SizeQuote | undefined>;

function assertBounds(bounds: SizingBounds): void {
  if (bounds.minAmount <= 0n || bounds.maxAmount < bounds.minAmount) throw new Error('sizing bounds are invalid');
  if (!Number.isInteger(bounds.maxPriceImpactBps) || bounds.maxPriceImpactBps < 0 || bounds.maxPriceImpactBps > 10_000) throw new Error('maxPriceImpactBps is invalid');
  if (bounds.maxEvaluations !== undefined && (!Number.isInteger(bounds.maxEvaluations) || bounds.maxEvaluations < 3)) throw new Error('maxEvaluations must be at least 3');
}

function interpolate(lower: bigint, upper: bigint, numerator: bigint, denominator: bigint): bigint {
  return lower + (upper - lower) * numerator / denominator;
}

/**
 * Bounded adaptive search. It samples the full executable range then repeatedly
 * refines the two intervals around the best profitable quote. This does not assume
 * a globally smooth AMM curve, and therefore keeps every valid quote as evidence.
 */
export async function optimizeTradeSize(bounds: SizingBounds, quote: SizeQuoter): Promise<AdaptiveSizingResult> {
  assertBounds(bounds);
  const limit = bounds.maxEvaluations ?? 9;
  const seeds = [
    bounds.minAmount,
    interpolate(bounds.minAmount, bounds.maxAmount, 1n, 4n),
    interpolate(bounds.minAmount, bounds.maxAmount, 1n, 2n),
    interpolate(bounds.minAmount, bounds.maxAmount, 3n, 4n),
    bounds.maxAmount
  ];
  const evaluated: SizeQuote[] = [];

  const observe = async (next: bigint): Promise<void> => {
    const observation = await quote(next);
    if (!observation || observation.amountIn !== next || !Number.isFinite(observation.netProfitUsd)) return;
    evaluated.push(observation);
  };
  for (const amount of seeds) {
    if (evaluated.length >= limit) break;
    await observe(amount);
  }

  while (evaluated.length < limit) {
    const viable = evaluated.filter((item) => item.priceImpactBps <= bounds.maxPriceImpactBps);
    const best = viable.sort((left, right) => right.netProfitUsd - left.netProfitUsd)[0];
    if (!best || evaluated.length >= limit) break;
    const ordered = viable.sort((left, right) => left.amountIn < right.amountIn ? -1 : left.amountIn > right.amountIn ? 1 : 0);
    const index = ordered.findIndex((item) => item.amountIn === best.amountIn);
    const lower = ordered[index - 1]?.amountIn ?? bounds.minAmount;
    const upper = ordered[index + 1]?.amountIn ?? bounds.maxAmount;
    const left = interpolate(lower, best.amountIn, 1n, 2n);
    const right = interpolate(best.amountIn, upper, 1n, 2n);
    const next = upper - best.amountIn >= best.amountIn - lower ? right : left;
    if (next === best.amountIn || evaluated.some((item) => item.amountIn === next)) break;
    await observe(next);
  }

  const winner = evaluated
    .filter((item) => item.netProfitUsd > 0 && item.priceImpactBps <= bounds.maxPriceImpactBps)
    .sort((left, right) => right.netProfitUsd - left.netProfitUsd)[0];
  return { winner, evaluated };
}
