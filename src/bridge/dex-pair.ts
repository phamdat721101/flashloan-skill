import type { Address, Hex } from '../types.js';

export type DexVenue = 'camelot-v3' | 'uniswap-v3' | 'pancakeswap-v3';
export const DEX_VENUE_ID: Record<DexVenue, number> = { 'camelot-v3': 0, 'uniswap-v3': 1, 'pancakeswap-v3': 2 };

export interface DexPairPolicy {
  id: string;
  flashToken: Address;
  targetToken: Address;
  flashTokenDecimals: number;
  uniFee: number;
  buyVenue: DexVenue;
  sellVenue: DexVenue;
  minFlashAmountWei: string;
  maxFlashAmountWei: string;
  maxQuoteEvaluations: number;
  minNetProfitUsd: string;
  minProfitWei: string;
}

export interface DexPairQuote {
  amountOutWei: bigint;
  blockNumber: bigint;
  blockHash: Hex;
}

export interface DexPairQuoteReader {
  quote(input: { venue: DexVenue; tokenIn: Address; tokenOut: Address; amountInWei: bigint; uniFee: number }): Promise<DexPairQuote>;
}

export interface DexPairCandidate {
  id: string;
  chainId: number;
  observedBlock: string;
  observedBlockHash: Hex;
  observedAt: string;
  expiresAt: string;
  protocol: 'dex-pair-arbitrage';
  flashToken: Address;
  targetToken: Address;
  flashAmountWei: string;
  buyVenue: DexVenue;
  sellVenue: DexVenue;
  uniFee: number;
  firstLegOutWei: string;
  finalOutWei: string;
}

function candidateId(policy: DexPairPolicy, amount: bigint, block: bigint): string {
  return `dex-pair:${policy.id}:${block}:${amount}`;
}

/**
 * Evaluates a bounded geometric amount series. Exact two-leg quotes, rather than
 * reserve ratios, decide whether a size is usable.
 */
export async function discoverDexPairCandidates(
  policy: DexPairPolicy,
  chainId: number,
  observedBlock: bigint,
  observedBlockHash: Hex,
  quoteReader: DexPairQuoteReader,
  now = new Date()
): Promise<DexPairCandidate[]> {
  const minimum = BigInt(policy.minFlashAmountWei);
  const maximum = BigInt(policy.maxFlashAmountWei);
  if (!policy.id || minimum <= 0n || maximum < minimum || !Number.isInteger(policy.maxQuoteEvaluations) || policy.maxQuoteEvaluations < 1) throw new Error('DEX pair sizing policy is invalid');
  if (!Number.isInteger(policy.uniFee) || policy.uniFee < 0 || policy.uniFee > 1_000_000 || policy.buyVenue === policy.sellVenue) throw new Error('DEX pair venues or fee are invalid');

  const amounts: bigint[] = [];
  let amount = minimum;
  while (amounts.length < policy.maxQuoteEvaluations && amount <= maximum) {
    amounts.push(amount);
    if (amount === maximum) break;
    const next = amount * 2n;
    amount = next > maximum ? maximum : next;
  }
  const observedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15_000).toISOString();
  const candidates = await Promise.all(amounts.map(async (flashAmountWei) => {
    const first = await quoteReader.quote({ venue: policy.buyVenue, tokenIn: policy.flashToken, tokenOut: policy.targetToken, amountInWei: flashAmountWei, uniFee: policy.uniFee });
    if (first.amountOutWei <= 0n) return undefined;
    const second = await quoteReader.quote({ venue: policy.sellVenue, tokenIn: policy.targetToken, tokenOut: policy.flashToken, amountInWei: first.amountOutWei, uniFee: policy.uniFee });
    if (second.amountOutWei <= 0n || first.blockNumber < observedBlock || second.blockNumber < observedBlock || first.blockHash.toLowerCase() !== observedBlockHash.toLowerCase() || second.blockHash.toLowerCase() !== observedBlockHash.toLowerCase()) return undefined;
    return {
      id: candidateId(policy, flashAmountWei, observedBlock), chainId, observedBlock: observedBlock.toString(), observedBlockHash, observedAt, expiresAt,
      protocol: 'dex-pair-arbitrage' as const, flashToken: policy.flashToken, targetToken: policy.targetToken, flashAmountWei: flashAmountWei.toString(), buyVenue: policy.buyVenue, sellVenue: policy.sellVenue, uniFee: policy.uniFee,
      firstLegOutWei: first.amountOutWei.toString(), finalOutWei: second.amountOutWei.toString()
    };
  }));
  return candidates.filter((candidate): candidate is DexPairCandidate => candidate !== undefined);
}
