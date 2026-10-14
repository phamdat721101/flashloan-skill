import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { validateExecutorPlan } from '../arbitrum.js';
import type { AllocationPlan, SkillConfig } from '../types.js';
import { DYNAMIC_V4_EXECUTOR_DEPLOYMENT, FLASH_EXECUTOR_ABI, FLASH_EXECUTOR_ADDRESS, FLASH_EXECUTOR_SELECTORS, MULTI_SPLIT_EXECUTOR_DEPLOYMENT, MULTI_VENUE_EXECUTOR_DEPLOYMENT } from '../contracts/flash-executor.js';

const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;

test('multi-split code identity remains separate from multi-venue admission', () => {
  const deployment = MULTI_SPLIT_EXECUTOR_DEPLOYMENT;
  assert.equal(deployment.chainId, 42161);
  assert.notEqual(deployment.address, MULTI_VENUE_EXECUTOR_DEPLOYMENT.address);
  assert.equal(deployment.capability, 'multi-split-arbitrage');
  assert.match(deployment.runtimeCodeHash, hash);
  assert.equal(deployment.codeVerifiedAtBlock, 514628150);
});

test('all ABI-backed capability selectors match the exact ABI tuple widths', () => {
  const selectors = new Set(FLASH_EXECUTOR_ABI.filter(item => item.type === 'function').map(item => toFunctionSelector(item)));
  for (const [capability, selector] of Object.entries(FLASH_EXECUTOR_SELECTORS)) {
    // Multi-split is a separate artifact, not a member of FLASH_EXECUTOR_ABI.
    if (capability !== 'multi-split-arbitrage') assert.ok(selectors.has(selector), `${capability} selector does not match its ABI`);
  }
});

test('publishes the reviewed dynamic V4 deployment separately from the legacy executor', () => {
  const deployment = DYNAMIC_V4_EXECUTOR_DEPLOYMENT;

  assert.equal(deployment.chainId, 42161);
  assert.notEqual(deployment.address, FLASH_EXECUTOR_ADDRESS);
  assert.match(deployment.address, address);
  assert.match(deployment.deployTxHash, hash);
  assert.match(deployment.aaveProvider.address, address);
  assert.match(deployment.aaveProvider.configureTxHash, hash);
  assert.match(deployment.aaveProvider.runtimeCodeHash, hash);
  assert.match(deployment.v4PoolManager.address, address);
  assert.match(deployment.v4PoolManager.configureTxHash, hash);
  assert.match(deployment.v4PoolManager.runtimeCodeHash, hash);
  assert.equal(deployment.v4PoolManager.hooksAllowed, false);
  assert.equal(deployment.v4ExecutionAdmission, 'revoked-reversed-balance-delta');
});

test('publishes the reviewed V2/V3/V4 deployment separately from legacy executors', () => {
  const deployment = MULTI_VENUE_EXECUTOR_DEPLOYMENT;

  assert.equal(deployment.chainId, 42161);
  assert.notEqual(deployment.address, FLASH_EXECUTOR_ADDRESS);
  assert.notEqual(deployment.address, DYNAMIC_V4_EXECUTOR_DEPLOYMENT.address);
  assert.match(deployment.address, address);
  assert.match(deployment.deployTxHash, hash);
  assert.match(deployment.runtimeCodeHash, hash);
  for (const root of [deployment.aaveProvider, deployment.v2Factory, deployment.v3Factory, deployment.v4PoolManager]) {
    assert.match(root.address, address);
    assert.match(root.configureTxHash, hash);
    assert.match(root.runtimeCodeHash, hash);
  }
  assert.equal(deployment.v4PoolManager.hooksAllowed, false);
  assert.equal(deployment.v4ExecutionAdmission, 'revoked-reversed-balance-delta');
});

test('known immutable V4 decoder deployments cannot reach simulation or signing', () => {
  const deployment = MULTI_VENUE_EXECUTOR_DEPLOYMENT;
  const token = FLASH_EXECUTOR_ADDRESS;
  const route = (version: number) => encodeFunctionData({ abi: FLASH_EXECUTOR_ABI, functionName: 'executeArbitrage', args: [{
    aaveProvider: deployment.aaveProvider.address, flashAsset: token, flashAmount: 100n,
    legs: [{ venueVersion: version, root: deployment.v4PoolManager.address, pool: token, tokenIn: token, tokenOut: token, minAmountOut: 101n, fee: 3000, sqrtPriceLimitX96: 0n, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000', hookData: '0x' }], minProfit: 1n, deadline: 1000n
  }] });
  const plan = { chainId: 42161, capability: 'multi-venue-arbitrage', transaction: { to: deployment.address, data: route(4) } } as AllocationPlan;
  const config = { chainId: 42161, executorAddress: deployment.address } as SkillConfig;
  assert.throws(() => validateExecutorPlan(plan, config), /unsafe V4 deployment/);
  // Inspect actual calldata even if the caller omits its capability label.
  assert.throws(() => validateExecutorPlan({ ...plan, capability: undefined }, config), /unsafe V4 deployment/);
  assert.doesNotThrow(() => validateExecutorPlan({ ...plan, transaction: { ...plan.transaction, data: route(2) } }, config));
  assert.throws(() => validateExecutorPlan({ ...plan, transaction: { to: DYNAMIC_V4_EXECUTOR_DEPLOYMENT.address, data: '0x' } }, { ...config, executorAddress: DYNAMIC_V4_EXECUTOR_DEPLOYMENT.address }), /unsafe V4 deployment/);
});
