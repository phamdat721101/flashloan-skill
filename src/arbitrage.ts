import { randomUUID } from 'node:crypto';
import { optimizeTradeSize, type SizeQuote, type SizingBounds } from './adaptive-sizing.js';
import type { ExecutorCapability } from './contracts/flash-executor.js';
import type { Address, AllocationPlan, Hex } from './types.js';

export type PoolFamily = 'uniswap-v2' | 'uniswap-v3' | 'uniswap-v4';

export interface FactoryPoolCandidate {
  id: string;
  chainId: number;
  family: PoolFamily;
  observedBlock: bigint;
  expiresAt: string;
  flashAsset: Address;
  flashAssetDecimals: number;
  flashAssetUsd: number;
  pools: Address[];
}

export interface ArbitrageQuote extends SizeQuote {
  amountOut: bigint;
  flashFee: bigint;
  transaction: { to: Address; data: Hex };
}

export interface ArbitrageQuoter {
  quote(candidate: FactoryPoolCandidate, amountIn: bigint): Promise<ArbitrageQuote | undefined>;
}

function capability(family: PoolFamily): ExecutorCapability {
  if (family === 'uniswap-v2') return 'uniswap-v2-arbitrage';
  if (family === 'uniswap-v3') return 'uniswap-v3-arbitrage';
  return 'uniswap-v4-arbitrage';
}

function validate(candidate: FactoryPoolCandidate, bounds: SizingBounds): void {
  if (!candidate.id || candidate.chainId <= 0 || candidate.pools.length === 0) throw new Error('factory pool candidate is invalid');
  if (Date.parse(candidate.expiresAt) <= Date.now()) throw new Error('factory pool candidate has expired');
  if (!Number.isInteger(candidate.flashAssetDecimals) || candidate.flashAssetDecimals < 0 || !Number.isFinite(candidate.flashAssetUsd) || candidate.flashAssetUsd <= 0) throw new Error('flash asset valuation is invalid');
  if (bounds.maxAmount < bounds.minAmount) throw new Error('factory pool bounds are invalid');
}

/** Builds one exact, highest-net proposal after adaptive bounded quote sampling. */
export async function buildAdaptiveArbitragePlan(
  candidate: FactoryPoolCandidate,
  bounds: SizingBounds,
  quoter: ArbitrageQuoter,
  executorAddress: Address
): Promise<AllocationPlan | undefined> {
  validate(candidate, bounds);
  const quotes = new Map<bigint, ArbitrageQuote>();
  const result = await optimizeTradeSize(bounds, async (amountIn) => {
    const quote = await quoter.quote(candidate, amountIn);
    if (!quote || quote.amountIn !== amountIn || quote.amountOut <= amountIn + quote.flashFee) return undefined;
    quotes.set(amountIn, quote);
    return quote;
  });
  const winner = result.winner && quotes.get(result.winner.amountIn);
  if (!winner) return undefined;
  const scale = 10 ** candidate.flashAssetDecimals;
  const quotedNetProfitUsd = Number(winner.amountOut - winner.amountIn - winner.flashFee) / scale * candidate.flashAssetUsd;
  if (!Number.isFinite(quotedNetProfitUsd) || quotedNetProfitUsd <= 0) return undefined;
  return {
    id: `arbitrage-${randomUUID()}`,
    opportunityId: candidate.id,
    chainId: candidate.chainId,
    strategy: `${candidate.family}-factory-arbitrage`,
    borrowTierUsd: 0,
    priceImpactBps: winner.priceImpactBps,
    quotedNetProfitUsd,
    legs: [{ venue: candidate.family, path: [candidate.flashAsset], allocationBps: 10_000, minAmountOut: winner.amountOut }],
    transaction: { to: executorAddress, data: winner.transaction.data },
    sourceBlock: candidate.observedBlock,
    quoteBlock: winner.quoteBlock,
    capability: capability(candidate.family),
    profitTokenUsd: candidate.flashAssetUsd,
    profitTokenDecimals: candidate.flashAssetDecimals,
    expiresAt: candidate.expiresAt
  };
}
