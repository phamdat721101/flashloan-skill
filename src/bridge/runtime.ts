import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';
import { buildDynamicPlan, type RouteQuote } from '../dynamic.js';
import type { Hex } from '../types.js';
import { discoverDexPairCandidates } from './dex-pair.js';
import type { BridgeConfig } from './config.js';
import { ArbitrumDexQuoteReader } from './quote-reader.js';
import { formatUsdE8, readChainlinkUsdE8 } from './oracles.js';

export interface BridgeDecision {
  id: string;
  candidateId: string;
  channel: 'dex-pair-arbitrage';
  status: 'blocked' | 'rejected' | 'ready';
  reasonCodes: string[];
  sourceBlock: string;
  sourceBlockHash: Hex;
  quotedNetProfitUsd: string;
}

function usdValueE8(amount: bigint, priceUsdE8: bigint, decimals: number): bigint {
  return amount * priceUsdE8 / 10n ** BigInt(decimals);
}

/** Runs exact, head-pinned DEX-pair discovery. It never constructs a wallet or broadcasts. */
export async function runDexBridge(config: BridgeConfig): Promise<BridgeDecision[]> {
  const client = createPublicClient({ chain: arbitrum, transport: http(config.rpcUrl) });
  const head = await client.getBlock({ blockTag: 'latest' });
  if (!head.number || !head.hash) throw new Error('head block is incomplete');
  const reader = new ArbitrumDexQuoteReader(config.rpcUrl, config.quoters, { number: head.number, hash: head.hash });
  const grouped: Array<{ pair: typeof config.pairs[number]; candidates: Awaited<ReturnType<typeof discoverDexPairCandidates>> }> = [];
  for (const pair of config.pairs) {
    const candidates = await discoverDexPairCandidates(pair, config.chainId, head.number!, head.hash!, reader);
    grouped.push({ pair, candidates });
  }
  const decisions: BridgeDecision[] = [];
  for (const { pair, candidates } of grouped) {
    const [flashTokenUsdE8, targetTokenUsdE8] = await Promise.all([
      readChainlinkUsdE8(client, pair.flashTokenUsdOracle, head.number, pair.maxOracleAgeSeconds),
      readChainlinkUsdE8(client, pair.targetTokenUsdOracle, head.number, pair.maxOracleAgeSeconds)
    ]);
    for (const candidate of candidates) {
      const flashAmount = BigInt(candidate.flashAmountWei);
      const firstOut = BigInt(candidate.firstLegOutWei);
      const finalOut = BigInt(candidate.finalOutWei);
      const inputUsd = usdValueE8(flashAmount, flashTokenUsdE8, pair.flashTokenDecimals);
      const firstLegUsd = usdValueE8(firstOut, targetTokenUsdE8, pair.flashTokenDecimals);
      const impactBps = inputUsd === 0n || firstLegUsd >= inputUsd ? 0 : Number((inputUsd - firstLegUsd) * 10_000n / inputUsd);
      if (finalOut <= flashAmount) {
        decisions.push({ id: `decision:${candidate.id}`, candidateId: candidate.id, channel: 'dex-pair-arbitrage', status: 'rejected', reasonCodes: ['NON_POSITIVE_QUOTED_PROFIT'], sourceBlock: candidate.observedBlock, sourceBlockHash: candidate.observedBlockHash, quotedNetProfitUsd: '0.00000000' });
        continue;
      }
      const netUsdE8 = usdValueE8(finalOut - flashAmount, flashTokenUsdE8, pair.flashTokenDecimals);
      const quote: RouteQuote = { venue: `${pair.buyVenue}:${pair.sellVenue}`, router: config.solver.executorAddress, approveTarget: config.solver.executorAddress, path: [pair.flashToken, pair.targetToken, pair.flashToken], amountIn: flashAmount, amountOut: finalOut, minAmountOut: finalOut, priceImpactBps: impactBps, fee: pair.uniFee, quoteBlock: head.number, calldata: '0x' };
      const plan = buildDynamicPlan(candidate, [quote], { ...config.solver, minNetProfitUsd: pair.minNetProfitUsd, minProfitWei: pair.minProfitWei }, formatUsdE8(netUsdE8), formatUsdE8(flashTokenUsdE8), pair.flashTokenDecimals);
      decisions.push({ id: `decision:${candidate.id}`, candidateId: candidate.id, channel: 'dex-pair-arbitrage', status: plan ? 'ready' : 'rejected', reasonCodes: plan ? [] : ['RISK_OR_EXECUTOR_GATE'], sourceBlock: candidate.observedBlock, sourceBlockHash: candidate.observedBlockHash, quotedNetProfitUsd: formatUsdE8(netUsdE8) });
    }
  }
  return decisions;
}
