import assert from 'node:assert/strict';
import test from 'node:test';
import { canBroadcast, loadConfig } from '../config.js';

test('never configures an executor, relay, or wallet implicitly', () => {
  const config = loadConfig({ ARBITRUM_RPC_URL: 'https://rpc.example' });
  assert.deepEqual(config.risk.borrowTiersUsd, []);
  assert.equal(config.risk.maxGasUsd, 2_000);
  assert.equal(config.risk.maxDailyLossUsd, 10_000);
  assert.equal(config.risk.maxPriceImpactBps, 200);
  assert.equal(config.risk.maxProposalBlockAge, 1);
  assert.equal(config.risk.rpcConcurrency, 4);
  assert.equal(config.executorAddress, undefined);
  assert.equal(config.privateRelayUrl, undefined);
  assert.equal(canBroadcast(config), false);
});

test('rejects malformed wallet configuration before any connector is constructed', () => {
  assert.throws(() => loadConfig({ ARBITRUM_RPC_URL: 'https://rpc.example', OPERATOR_PRIVATE_KEY: 'not-a-key' }), /32-byte/);
  assert.throws(() => loadConfig({ ARBITRUM_RPC_URL: 'https://rpc.example', BORROW_TIERS_USD: '100000,zero' }), /positive/);
  assert.throws(() => loadConfig({ ARBITRUM_RPC_URL: 'https://rpc.example', PRIVATE_RELAY_URL: 'http://relay.example' }), /HTTPS/);
});
