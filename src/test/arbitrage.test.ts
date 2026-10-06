import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdaptiveArbitragePlan, type FactoryPoolCandidate } from '../arbitrage.js';

const address = '0x1111111111111111111111111111111111111111' as const;
const candidate: FactoryPoolCandidate = {
  id: 'factory-pool', chainId: 42161, family: 'uniswap-v3', observedBlock: 100n,
  expiresAt: '2099-01-01T00:00:00.000Z', flashAsset: address, flashAssetDecimals: 0, flashAssetUsd: 1, pools: [address]
};

test('builds a block-bound V3 plan at the adaptive highest-net amount', async () => {
  const plan = await buildAdaptiveArbitragePlan(candidate, { minAmount: 100n, maxAmount: 1_000n, maxEvaluations: 9, maxPriceImpactBps: 200 }, {
    quote: async (_candidate, amountIn) => {
      const grossProfit = 100n - (amountIn > 550n ? amountIn - 550n : 550n - amountIn) / 10n;
      return { amountIn, amountOut: amountIn + grossProfit, flashFee: 1n, netProfitUsd: Number(grossProfit - 1n), priceImpactBps: 50, quoteBlock: 101n, transaction: { to: address, data: '0x1234' } };
    }
  }, address);
  assert.equal(plan?.capability, 'uniswap-v3-arbitrage');
  assert.equal(plan?.borrowTierUsd, 0);
  assert.equal(plan?.quoteBlock, 101n);
});
