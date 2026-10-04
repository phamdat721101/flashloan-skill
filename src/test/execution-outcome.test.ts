import assert from 'node:assert/strict';
import test from 'node:test';
import { executionOutcome } from '../execution-outcome.js';

test('classifies permanent executor ownership failures without exposing arbitrary error detail', () => {
  const outcome = executionOutcome('preflight', new Error('signer is not executor owner'));
  assert.equal(outcome.code, 'SIGNER_NOT_OWNER');
  assert.equal(outcome.retryable, false);
  assert.equal(outcome.stage, 'preflight');
});

test('classifies transient RPC failures as retryable', () => {
  const outcome = executionOutcome('simulate', new Error('RPC timeout while estimating gas'));
  assert.equal(outcome.code, 'EXECUTION_FAILED');
  assert.equal(outcome.retryable, true);
});
