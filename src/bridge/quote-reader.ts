import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { arbitrum } from 'viem/chains';
import type { Address, Hex } from '../types.js';
import type { DexPairQuote, DexPairQuoteReader, DexVenue } from './dex-pair.js';

const V3_QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
]);
const CAMELOT_QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) external returns (uint256 amountOut, uint16 fee)'
]);

export interface DexQuoterRegistry {
  'uniswap-v3': Address;
  'pancakeswap-v3': Address;
  'camelot-v3': Address;
}

export class ArbitrumDexQuoteReader implements DexPairQuoteReader {
  private readonly client: PublicClient;
  private block: { number: bigint; hash: Hex };

  constructor(rpcUrl: string, private readonly quoters: DexQuoterRegistry, block: { number: bigint; hash: Hex }) {
    this.block = block;
    this.client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl, { retryCount: 5, retryDelay: 1_000 }) });
  }

  async quote(input: { venue: DexVenue; tokenIn: Address; tokenOut: Address; amountInWei: bigint; uniFee: number }): Promise<DexPairQuote> {
    let amountOutWei: bigint;
    if (input.venue === 'camelot-v3') amountOutWei = await this.camelotQuote(input);
    else amountOutWei = await this.v3Quote(input);
    return { amountOutWei, blockNumber: this.block.number, blockHash: this.block.hash };
  }

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        lastError = err;
        const msg = String(err);
        if (msg.includes('layer stale') || msg.includes('missing trie node')) {
          const fresh = await this.client.getBlock({ blockTag: 'latest' });
          if (fresh.number && fresh.hash) {
            this.block = { number: fresh.number, hash: fresh.hash };
          }
          continue;
        }
        if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit')) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1_200));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private async v3Quote(input: { venue: DexVenue; tokenIn: Address; tokenOut: Address; amountInWei: bigint; uniFee: number }): Promise<bigint> {
    try {
      return await this.withRetry(async () => {
        const result = await this.client.simulateContract({
          address: this.quoters[input.venue], abi: V3_QUOTER_ABI, functionName: 'quoteExactInputSingle',
          args: [{ tokenIn: input.tokenIn, tokenOut: input.tokenOut, amountIn: input.amountInWei, fee: input.uniFee, sqrtPriceLimitX96: 0n }], blockNumber: this.block.number
        });
        return result.result[0];
      });
    } catch {
      return 0n;
    }
  }

  private async camelotQuote(input: { tokenIn: Address; tokenOut: Address; amountInWei: bigint }): Promise<bigint> {
    try {
      return await this.withRetry(async () => {
        const result = await this.client.simulateContract({
          address: this.quoters['camelot-v3'], abi: CAMELOT_QUOTER_ABI, functionName: 'quoteExactInputSingle',
          args: [input.tokenIn, input.tokenOut, input.amountInWei, 0n], blockNumber: this.block.number
        });
        return result.result[0];
      });
    } catch {
      return 0n;
    }
  }
}
