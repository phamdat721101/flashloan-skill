import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverDexPairCandidates, type DexPairPolicy } from '../bridge/dex-pair.js';

const flash = '0x1111111111111111111111111111111111111111' as const;
const target = '0x2222222222222222222222222222222222222222' as const;
const hash = `0x${'a'.repeat(64)}` as const;
const policy: DexPairPolicy = { id: 'usdc-weth', flashToken: flash, targetToken: target, flashTokenDecimals: 6, uniFee: 500, buyVenue: 'uniswap-v3', sellVenue: 'camelot-v3', minFlashAmountWei: '10', maxFlashAmountWei: '80', maxQuoteEvaluations: 3, minNetProfitUsd: '1', minProfitWei: '1' };

test('uses bounded exact two-leg quotes for a continuous-size candidate set', async () => {
  const candidates = await discoverDexPairCandidates(policy, 42161, 100n, hash, { quote: async ({ amountInWei }) => ({ amountOutWei: amountInWei * 2n, blockNumber: 100n, blockHash: hash }) });
  assert.deepEqual(candidates.map((item) => item.flashAmountWei), ['10', '20', '40']);
  assert.ok(candidates.every((item) => item.finalOutWei !== '0'));
});

test('rejects a quote observed on a different head hash', async () => {
  const candidates = await discoverDexPairCandidates(policy, 42161, 100n, hash, { quote: async ({ amountInWei }) => ({ amountOutWei: amountInWei, blockNumber: 100n, blockHash: `0x${'b'.repeat(64)}` as `0x${string}` }) });
  assert.deepEqual(candidates, []);
});
