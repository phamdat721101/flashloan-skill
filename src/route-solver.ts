import type { Address, Hex } from './types.js';
import type { DynamicCandidate, QuoteRequest, QuoteSource, RouteQuote } from './dynamic.js';

export interface QuoterVenue {
  id: string;
  quoter: Address;
  router: Address;
  approveTarget: Address;
  feeTiers: number[];
}

export interface ExactInputQuoteReader {
  quoteExactInputSingle(input: { quoter: Address; tokenIn: Address; tokenOut: Address; amountIn: bigint; fee: number }): Promise<{ amountOut: bigint; quoteBlock: bigint; calldata: Hex }>;
}

function routeTokens(candidate: DynamicCandidate): { tokenIn: Address; tokenOut: Address } | undefined {
  if (candidate.protocol === 'aave-v3') return { tokenIn: candidate.collateralToken, tokenOut: candidate.debtToken };
  if (candidate.protocol === 'morpho-blue') return { tokenIn: candidate.collateralToken, tokenOut: candidate.flashToken };
  return undefined;
}

/** Queries configured venues and returns the best exact-input route per venue. */
export class ConfiguredRouteSolver implements QuoteSource {
  constructor(private readonly venues: QuoterVenue[], private readonly reader: ExactInputQuoteReader, private readonly minOutBps = 9_900) {
    if (!Number.isInteger(minOutBps) || minOutBps <= 0 || minOutBps > 10_000) throw new Error('minOutBps must be between 1 and 10000');
  }

  async quote(request: QuoteRequest): Promise<RouteQuote[]> {
    const tokens = routeTokens(request.candidate);
    if (!tokens || request.repayAmount <= 0n) return [];
    const quotes = await Promise.all(this.venues.flatMap((venue) => venue.feeTiers.map(async (fee) => {
      const result = await this.reader.quoteExactInputSingle({ quoter: venue.quoter, tokenIn: tokens.tokenIn, tokenOut: tokens.tokenOut, amountIn: request.repayAmount, fee });
      return { venue, fee, result };
    })));
    const bestByVenue = new Map<string, typeof quotes[number]>();
    for (const quote of quotes) {
      const prior = bestByVenue.get(quote.venue.id);
      if (!prior || quote.result.amountOut > prior.result.amountOut) bestByVenue.set(quote.venue.id, quote);
    }
    return [...bestByVenue.values()].filter((quote) => quote.result.amountOut > 0n).map(({ venue, fee, result }) => ({
      venue: venue.id,
      router: venue.router,
      approveTarget: venue.approveTarget,
      path: [tokens.tokenIn, tokens.tokenOut],
      amountIn: request.repayAmount,
      amountOut: result.amountOut,
      minAmountOut: result.amountOut * BigInt(this.minOutBps) / 10_000n,
      priceImpactBps: 10_000 - this.minOutBps,
      fee,
      quoteBlock: result.quoteBlock,
      calldata: result.calldata
    }));
  }
}
