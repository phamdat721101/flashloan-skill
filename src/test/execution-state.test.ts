import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionLock } from '../execution-lock.js';
import { DailyLossLedger } from '../loss-ledger.js';

test('persists only realized losses for the current UTC day', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashloan-ledger-'));
  try {
    const ledger = new DailyLossLedger(join(directory, 'daily-loss.json'));
    await ledger.recordProfit(-42.5, new Date('2026-10-04T12:00:00Z'));
    await ledger.recordProfit(15, new Date('2026-10-04T13:00:00Z'));
    assert.equal(await ledger.currentLossUsd(new Date('2026-10-04T14:00:00Z')), 42.5);
    assert.equal(await ledger.currentLossUsd(new Date('2026-10-05T00:00:00Z')), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not permit concurrent execution leases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashloan-lock-'));
  try {
    const first = new ExecutionLock(join(directory, 'execution.lock'));
    const second = new ExecutionLock(join(directory, 'execution.lock'));
    await first.runExclusive(async () => {
      await assert.rejects(() => second.runExclusive(async () => undefined), /already in progress/);
    });
    await second.runExclusive(async () => undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
