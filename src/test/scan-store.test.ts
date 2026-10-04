import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ScanStore } from '../scan/store.js';

const hash = `0x${'a'.repeat(64)}` as const;

test('EDGE-02 persists a checkpoint and appends one schema-valid envelope per scan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashloan-agent-store-'));
  const store = new ScanStore(directory);
  await store.saveCheckpoint({ chainId: 42161, blockNumber: '123', blockHash: hash });
  assert.deepEqual(await store.loadCheckpoint(), { chainId: 42161, blockNumber: '123', blockHash: hash });
  const output = join(directory, 'results.jsonl');
  await store.appendEnvelope(output, {
    schemaVersion: '1.0', runId: 'run-1', chainId: 42161,
    observedBlock: { number: '123', hash, timestamp: '2026-10-04T00:00:00.000Z' },
    opportunities: [], diagnostics: []
  });
  assert.match(await readFile(output, 'utf8'), /"schemaVersion":"1.0"/);
});

test('returns no checkpoint before the scanner has persisted one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashloan-agent-store-'));
  assert.equal(await new ScanStore(directory).loadCheckpoint(), undefined);
});

test('retains discovered borrower entities independently of the advancing checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashloan-agent-store-'));
  const store = new ScanStore(directory);
  await store.saveEntities({
    aaveBorrowers: ['0x1111111111111111111111111111111111111111'],
    morphoBorrowers: [{ marketId: `0x${'b'.repeat(64)}`, borrower: '0x2222222222222222222222222222222222222222' }]
  });
  assert.deepEqual(await store.loadEntities(), {
    aaveBorrowers: ['0x1111111111111111111111111111111111111111'],
    morphoBorrowers: [{ marketId: `0x${'b'.repeat(64)}`, borrower: '0x2222222222222222222222222222222222222222' }]
  });
});
