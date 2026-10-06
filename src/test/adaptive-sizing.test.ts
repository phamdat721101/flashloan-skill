import assert from 'node:assert/strict';
import test from 'node:test';
import { optimizeTradeSize } from '../adaptive-sizing.js';

test('EDGE-09 selects the highest net-profit live quote without fixed tiers', async () => {
  const result = await optimizeTradeSize({ minAmount: 1n, maxAmount: 1_000n, maxEvaluations: 9, maxPriceImpactBps: 200 }, async (amountIn) => ({
    amountIn,
    netProfitUsd: 100 - Math.abs(Number(amountIn) - 625) / 10,
    priceImpactBps: 50,
    quoteBlock: 100n
  }));
  assert.ok(result.winner);
  assert.equal(result.winner!.amountIn > 500n && result.winner!.amountIn < 750n, true);
  assert.equal(result.evaluated.some((quote) => quote.amountIn === 50n || quote.amountIn === 150n || quote.amountIn === 400n), false);
});

test('rejects profitable quotes beyond the configured price-impact bound', async () => {
  const result = await optimizeTradeSize({ minAmount: 1n, maxAmount: 100n, maxPriceImpactBps: 100 }, async (amountIn) => ({
    amountIn,
    netProfitUsd: Number(amountIn),
    priceImpactBps: amountIn > 50n ? 101 : 50,
    quoteBlock: 100n
  }));
  assert.ok(result.winner);
  assert.equal(result.winner!.amountIn <= 50n, true);
});
