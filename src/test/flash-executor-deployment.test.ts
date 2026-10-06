import assert from 'node:assert/strict';
import test from 'node:test';
import { DYNAMIC_V4_EXECUTOR_DEPLOYMENT, FLASH_EXECUTOR_ADDRESS } from '../contracts/flash-executor.js';

const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;

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
});
