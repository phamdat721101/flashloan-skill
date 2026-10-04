import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutorAdapter, OpportunityProvider } from '../connectors.js';
import { validateBroadcastEvidence, validateExecutorPlan } from '../arbitrum.js';
import { FLASH_EXECUTOR_SELECTORS } from '../contracts/flash-executor.js';
import { FlashloanOrchestrator } from '../orchestrator.js';
import type { AllocationPlan, ExecutionReceipt, Opportunity, SimulationResult, SkillConfig } from '../types.js';

const address = '0x1111111111111111111111111111111111111111' as const;
const key = `0x${'1'.repeat(64)}` as const;

function plan(tier: number): AllocationPlan {
  return {
    id: `plan-${tier}`,
    opportunityId: 'dex-route',
    chainId: 42161,
    strategy: 'dex-pair-arbitrage',
    borrowTierUsd: tier,
    priceImpactBps: 20,
    quotedNetProfitUsd: tier / 100_000,
    legs: [{ venue: 'uniswap-v3', path: [address, address], allocationBps: 10_000, minAmountOut: 1n }],
    transaction: { to: address, data: '0x' }
  };
}

const config: SkillConfig = {
  chainId: 42161,
  rpcUrl: 'https://rpc.example',
  privateRelayUrl: 'https://relay.example',
  executorAddress: address,
  operatorPrivateKey: key,
  risk: { borrowTiersUsd: [100_000, 200_000, 500_000], maxGasUsd: 2_000, maxDailyLossUsd: 10_000, maxPriceImpactBps: 200, minNetProfitUsd: 1, maxProposalBlockAge: 1, rpcConcurrency: 2 }
};

test('simulates every configured tier and broadcasts the best allowed allocation', async () => {
  const selected: string[] = [];
  const executor: ExecutorAdapter = {
    chainId: 42161,
    verify: async () => {},
    simulate: async (candidate): Promise<SimulationResult> => ({ ok: true, gasCostUsd: 10, expectedNetProfitUsd: candidate.quotedNetProfitUsd }),
    broadcast: async (candidate): Promise<ExecutionReceipt> => {
      selected.push(candidate.id);
      return { transactionHash: '0xabc', blockNumber: 1n, gasUsed: 2n, realizedPnlStatus: 'known' };
    }
  };
  const opportunity: Opportunity = {
    id: 'dex-route', chainId: 42161, channel: 'dex', strategy: 'dex-pair-arbitrage',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    buildAllocation: async (tier) => plan(tier)
  };
  const provider: OpportunityProvider = { id: 'fixture', discover: async () => [opportunity] };
  const result = await new FlashloanOrchestrator([provider], executor).run(config);
  assert.equal(result.decisions.length, 3);
  assert.deepEqual(selected, ['plan-500000']);
  assert.equal(result.receipt?.transactionHash, '0xabc');
});

test('blocks invalid allocations even when a simulation succeeds', async () => {
  const invalid = { ...plan(100_000), legs: [{ ...plan(100_000).legs[0], allocationBps: 9_999 }] };
  const simulation: SimulationResult = { ok: true, gasCostUsd: 1, expectedNetProfitUsd: 20 };
  const executor: ExecutorAdapter = { chainId: 42161, verify: async () => {}, simulate: async () => simulation, broadcast: async () => { throw new Error('must not broadcast'); } };
  const provider: OpportunityProvider = { id: 'fixture', discover: async () => [{ id: 'bad', chainId: 42161, channel: 'dex', strategy: 'dex', expiresAt: new Date(Date.now() + 60_000).toISOString(), buildAllocation: async () => invalid }] };
  const result = await new FlashloanOrchestrator([provider], executor).run({ ...config, risk: { ...config.risk, borrowTiersUsd: [100_000] } });
  assert.equal(result.receipt, undefined);
  assert.match(result.decisions[0].reasons.join(' '), /10,000/);
});

test('rejects opportunity calldata that does not target the configured executor', () => {
  assert.throws(
    () => validateExecutorPlan({ ...plan(100_000), transaction: { to: '0x2222222222222222222222222222222222222222', data: '0x' } }, config),
    /configured executor/
  );
});

test('uses a strategy-owned dynamic allocation instead of static tiers when available', async () => {
  const selected: string[] = [];
  const executor: ExecutorAdapter = {
    chainId: 42161,
    verify: async () => {},
    simulate: async () => ({ ok: true, gasCostUsd: 1, expectedNetProfitUsd: 20 }),
    broadcast: async (candidate) => {
      selected.push(candidate.id);
      return { transactionHash: '0xabc', blockNumber: 1n, gasUsed: 2n, realizedPnlStatus: 'known' };
    }
  };
  const dynamic = { ...plan(100_000), id: 'dynamic', borrowTierUsd: 0 };
  const provider: OpportunityProvider = {
    id: 'dynamic-fixture',
    discover: async () => [{
      id: 'dynamic', chainId: 42161, channel: 'aave', strategy: 'aave-v3-liquidation',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      buildAllocation: async () => undefined,
      buildAllocations: async () => [dynamic]
    }]
  };
  const result = await new FlashloanOrchestrator([provider], executor).run(config);
  assert.equal(result.decisions.length, 1);
  assert.deepEqual(selected, ['dynamic']);
});

test('rejects expired or capability-mismatched autonomous proposals', () => {
  const expired = { ...plan(100_000), expiresAt: new Date(Date.now() - 1).toISOString() };
  assert.throws(() => validateExecutorPlan(expired, config), /expired/);
  const mismatched = {
    ...plan(100_000),
    capability: 'aave-v3-liquidation' as const,
    transaction: { to: address, data: `${FLASH_EXECUTOR_SELECTORS['dex-pair-arbitrage']}00` as `0x${string}` }
  };
  assert.throws(() => validateExecutorPlan(mismatched, config), /selector/);
  assert.throws(() => validateBroadcastEvidence(plan(100_000), 100n, 1), /block-bound/);
  const bounded = {
    ...plan(100_000),
    capability: 'dex-pair-arbitrage' as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceBlock: 97n,
    quoteBlock: 99n
  };
  assert.throws(() => validateBroadcastEvidence(bounded, 100n, 1), /stale/);
});

test('simulation-only mode never reaches broadcast', async () => {
  const executor: ExecutorAdapter = {
    chainId: 42161,
    verify: async () => {},
    simulate: async () => ({ ok: true, gasCostUsd: 1, expectedNetProfitUsd: 20 }),
    broadcast: async () => { throw new Error('simulation-only mode must not broadcast'); }
  };
  const provider: OpportunityProvider = {
    id: 'fixture',
    discover: async () => [{ id: 'safe', chainId: 42161, channel: 'dex', strategy: 'dex', expiresAt: new Date(Date.now() + 60_000).toISOString(), buildAllocation: async () => plan(100_000) }]
  };
  const result = await new FlashloanOrchestrator([provider], executor).run({ ...config, risk: { ...config.risk, borrowTiersUsd: [100_000] } }, { broadcast: false });
  assert.equal(result.receipt, undefined);
  assert.match(result.diagnostics.join(' '), /simulation-only/);
});
