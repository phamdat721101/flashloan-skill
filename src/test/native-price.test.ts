import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicClient } from 'viem';
import { nativeCostUsdE8, quoteNativeUsd, type NativePricePolicy } from '../evm-fees.js';
import { nativePricePolicy } from '../config.js';
import { quoteWithRetry, valueSimulatedGas, type NativeUsdSource } from '../arbitrum.js';
import type { AllocationPlan, NativePriceEvidence } from '../types.js';

const FEED = '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612', UPTIME = '0xfdb631f5ee196f0ed6faa767959853a9f217697d';
const policy: NativePricePolicy = { feed: FEED, maxAgeSeconds: 90000, sequencerUptimeFeed: UPTIME, sequencerGraceSeconds: 3600 };
const NOW = 1_800_000_000n;
/** latestRoundData = (roundId, answer, startedAt, updatedAt, answeredInRound) */
function client(price: { answer: bigint; updatedAt: bigint; round?: bigint; answeredIn?: bigint }, uptime: { answer: bigint; startedAt: bigint } | 'throw' = { answer: 0n, startedAt: NOW - 100_000n }) {
  return {
    async getBlock() { return { timestamp: NOW }; },
    async readContract({ address, functionName }: { address: string; functionName: string }) {
      if (address === UPTIME) { if (uptime === 'throw') throw new Error('rpc'); return [1n, uptime.answer, uptime.startedAt, uptime.startedAt, 1n]; }
      if (functionName === 'decimals') return 8;
      return [price.round ?? 5n, price.answer, price.updatedAt, price.updatedAt, price.answeredIn ?? 5n];
    }
  } as unknown as PublicClient;
}

test('quotes native USD at the valued block with exact ceiling gas math', async () => {
  const quote = await quoteNativeUsd(client({ answer: 235088428829n, updatedAt: NOW - 44n }), policy, 518949007n);
  assert.deepEqual({ ...quote, sequencer: quote.sequencer?.up }, { feed: FEED, priceUsdE8: '235088428829', updatedAt: Number(NOW - 44n), blockNumber: '518949007', blockTimestamp: Number(NOW), sequencer: true });
  // 435632 gas × 0.01 gwei = 4356320000000 wei; × 235088428829 / 1e18 = 1024120.42… USD·1e8 exactly → ceiling 1024121
  assert.equal(nativeCostUsdE8(4_356_320_000_000n, 235088428829n), 1024121n);
  assert.equal(nativeCostUsdE8(1n, 1n), 1n, 'never rounds a non-zero cost down to zero');
  assert.throws(() => nativeCostUsdE8(1n, 0n), /INVALID_NATIVE_COST/);
});

test('EDGE-02 rejects stale, non-positive and incomplete rounds', async () => {
  for (const bad of [{ answer: 235088428829n, updatedAt: NOW - 90001n }, { answer: 0n, updatedAt: NOW }, { answer: -1n, updatedAt: NOW }, { answer: 1n, updatedAt: NOW, round: 6n, answeredIn: 5n }])
    await assert.rejects(quoteNativeUsd(client(bad), policy, 1n), /NATIVE_PRICE_STALE_OR_INVALID/);
  console.log('native_price_round_validity_proven');
});

test('EDGE-03 blocks while the sequencer is down or inside its grace period', async () => {
  const fresh = { answer: 235088428829n, updatedAt: NOW };
  await assert.rejects(quoteNativeUsd(client(fresh, { answer: 1n, startedAt: NOW - 100_000n }), policy, 1n), /SEQUENCER_DOWN/);
  await assert.rejects(quoteNativeUsd(client(fresh, { answer: 0n, startedAt: NOW - 3599n }), policy, 1n), /SEQUENCER_GRACE_PERIOD/);
  await assert.rejects(quoteNativeUsd(client(fresh, { answer: 0n, startedAt: 0n }), policy, 1n), /SEQUENCER_GRACE_PERIOD/);
  await assert.rejects(quoteNativeUsd(client(fresh, 'throw'), policy, 1n), /NATIVE_FEED_UNREADABLE/);
  console.log('native_price_sequencer_gate_proven');
});

test('disables the sequencer gate only with explicit none', async () => {
  const quote = await quoteNativeUsd(client({ answer: 1n, updatedAt: NOW }, 'throw'), { ...policy, sequencerUptimeFeed: null }, 1n);
  assert.equal(quote.sequencer, null);
  assert.equal(nativePricePolicy({ SEQUENCER_UPTIME_FEED: 'none' }, 42161)?.sequencerUptimeFeed, null);
});

test('EDGE-01 config defaults to the Arbitrum feeds and rejects invalid overrides', () => {
  assert.deepEqual(nativePricePolicy({ NATIVE_TOKEN_USD: '2700' }, 42161), { feed: FEED, maxAgeSeconds: 90000, sequencerUptimeFeed: UPTIME, sequencerGraceSeconds: 3600 });
  assert.equal(nativePricePolicy({}, 8453), undefined, 'no implicit feed for chains without a verified default');
  assert.throws(() => nativePricePolicy({ NATIVE_USD_MAX_AGE_SECONDS: '90001' }, 42161), /NATIVE_USD_MAX_AGE_SECONDS/);
  assert.throws(() => nativePricePolicy({ NATIVE_USD_FEED: 'nope' }, 42161), /NATIVE_USD_FEED/);
  assert.throws(() => nativePricePolicy({ SEQUENCER_GRACE_SECONDS: '-1' }, 42161), /SEQUENCER_GRACE_SECONDS/);
  console.log('native_price_config_binding_proven');
});

const evidence: NativePriceEvidence = { feed: FEED, priceUsdE8: '200000000000', updatedAt: 1, blockNumber: '1', blockTimestamp: 1, sequencer: null };
test('EDGE-04 profit floor subtracts the live gas cost', () => {
  const result = valueSimulatedGas({ quotedNetProfitUsd: 12 } as AllocationPlan, 1_000_000n, 1_000_000_000_000n, evidence);
  assert.equal(result.gasCostUsd, 2000, '1e18 wei at $2000');
  assert.equal(result.expectedNetProfitUsd, 12 - 2000);
  assert.equal(result.nativePrice, evidence);
  console.log('native_price_gas_profit_floor_proven');
});

test('EDGE-05 transient receipt price failure recovers and a persistent one yields no price', async () => {
  let calls = 0;
  const flaky: NativeUsdSource = { async quote() { if (++calls < 3) throw new Error('rpc'); return evidence; } };
  assert.equal(await quoteWithRetry(flaky, 1n, 3, 0), evidence);
  assert.equal(calls, 3);
  calls = 0;
  const down: NativeUsdSource = { async quote() { calls++; throw new Error('SEQUENCER_DOWN'); } };
  assert.equal(await quoteWithRetry(down, 1n, 3, 0), undefined);
  assert.equal(calls, 3, 'bounded: exactly three attempts');
  console.log('native_price_receipt_retry_bound_proven');
});
