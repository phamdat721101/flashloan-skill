import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeAbiParameters as encode, encodeEventTopics, encodeFunctionResult, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ArbitrumLiquidityExecutionAdapter, type ArbitrumExecutionConfig } from '../liquidity/arbitrum-execution.js';
import { encodeLenderArbitrage, MULTI_LENDER_ROUTE_ABI } from '../liquidity/arbitrum.js';
import { digest, SnapshotStore } from '../liquidity/state.js';
import { AttemptJournal } from '../liquidity/journal.js';
import { LiquidityRuntime, type RouteCandidate } from '../liquidity/runtime.js';

import { fixture, account, executor } from './evm-rpc-fixture.js';
test('real Arbitrum adapter signs final EIP-1559 bytes locally and reconciles route-bound receipt custody', async () => {
  await fixture(async (adapter, candidate, config, controls) => {
    const directory = await mkdtemp(join(tmpdir(), 'liquidity-real-signing-'));
    try {
      const snapshots = new SnapshotStore(60000);
      snapshots.apply({ schemaVersion: '3.0', identity: candidate.identity, sourceId: 'local-rpc', cursor: '1', observedAtMs: Date.now(), complete: true, poolIds: candidate.poolIds, stateDigest: candidate.stateDigest });
      const journal = new AttemptJournal(join(directory, 'attempts.jsonl'));
      const decisions = await new LiquidityRuntime(snapshots, journal, new Map([[candidate.adapterId, adapter]])).run([candidate], { mode: 'auto', concurrency: 1, maxCandidates: 1, maxDailyLoss: '1000000', minProfit: '10000', budgetAssets: { 'arbitrum:42161': candidate.profitAsset } });
      assert.ok(decisions.some(decision => decision.status === 'reconciled'), JSON.stringify(decisions));
      assert.equal(controls.sends, 1); assert.ok(controls.raw);
      const parsed = parseTransaction(controls.raw);
      assert.equal(parsed.chainId, 42161); assert.equal(parsed.nonce, 0); assert.equal(parsed.to?.toLowerCase(), executor.toLowerCase());
      assert.ok(controls.raw.startsWith('0x02'));
      assert.equal((await recoverTransactionAddress({ serializedTransaction: controls.raw as `0x02${string}` })).toLowerCase(), account.address.toLowerCase());
      assert.equal((await journal.latest())[0].transactionId, keccak256(controls.raw));
      assert.equal((await journal.latest())[0].loss, '0');
      const receipt = await adapter.receipt(keccak256(controls.raw));
      assert.equal(receipt?.profitTransferProven, false); assert.equal(receipt?.profitCustodyProven, true);
      const recovered = new ArbitrumLiquidityExecutionAdapter(config, account, [{ candidate, calldata: parsed.data! }]);
      assert.equal((await recovered.receipt(keccak256(controls.raw)))?.profitAfterDebt, '110000');
      assert.equal(controls.sends, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
test('revision drift and pending nonce changes reject before submission', async () => {
  await fixture(async (adapter, candidate, _, controls) => {
    const resource = await adapter.resource(candidate);
    controls.nonce = 1;
    await assert.rejects(adapter.sign(candidate, resource), /NONCE_CHANGED/);
    controls.drift = true;
    await assert.rejects(adapter.simulate(candidate), /EXECUTION_REVISION_CHANGED/);
    assert.equal(controls.sends, 0);
  });
});
test('cancellation during the relay chain-ID response cannot broadcast after halt', async () => {
  await fixture(async (adapter, candidate, _, controls) => {
    const signed = await adapter.sign(candidate, await adapter.resource(candidate));
    const controller = new AbortController(); controls.abortRelay = controller;
    await assert.rejects(adapter.submit(signed.signedBytes, controller.signal), /EXECUTION_CANCELLED/);
    assert.equal(controller.signal.aborted, true); assert.equal(controls.chainReads, 2); assert.equal(controls.sends, 0);
  });
});
