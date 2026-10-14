import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSuiAddress, toBase58 } from '@mysten/sui/utils';
import { SourceJournal } from '../liquidity/ingestion.js';
import { recoverSuiCheckpointState, SuiCheckpointState } from '../liquidity/sui-state.js';
import { readSuiPinnedObjects, type SuiCheckpointObservation } from '../liquidity/sources.js';

const suiDigest = (value: number) => toBase58(new Uint8Array(32).fill(value));
const chainIdentifier = suiDigest(4), first = normalizeSuiAddress('0x1'), second = normalizeSuiAddress('0x2');
function checkpoint(height: number, changes: SuiCheckpointObservation['transactions'][number]['changes']): SuiCheckpointObservation {
  return { schemaVersion: '3.0', chain: 'sui', network: 'mainnet', chainIdentifier, checkpoint: String(height), checkpointDigest: suiDigest(height + 1), previousCheckpointDigest: suiDigest(height), contentsDigest: suiDigest(8), committedTransactions: [{ digest: suiDigest(9), effectsDigest: suiDigest(6) }], transactions: [{ digest: suiDigest(9), effectsDigest: suiDigest(6), changes }] };
}
function write(id: string, version: string) { return { objectId: id, outputVersion: version, outputDigest: suiDigest(7), outputState: 'object-write' as const }; }

test('checkpoint references bootstrap conservatively and remain consistent across untouched objects', () => {
  const state = new SuiCheckpointState('mainnet', chainIdentifier, [first, second]);
  state.apply(checkpoint(1, [write(first, '10')]));
  assert.equal(state.snapshot().completeForDeclaredObjectSet, false); assert.deepEqual(state.snapshot().missingObjectIds, [second]);
  const next = checkpoint(2, [write(second, '20')]); state.apply(next);
  assert.equal(state.snapshot().completeForDeclaredObjectSet, true); assert.deepEqual(state.snapshot().objects.map(object => object.version), ['10', '20']);
  assert.equal(state.apply(next), 'duplicate');
  state.apply(checkpoint(3, [{ objectId: first, outputVersion: null, outputDigest: null, outputState: 'deleted' }]));
  assert.equal(state.snapshot().completeForDeclaredObjectSet, false); assert.deepEqual(state.snapshot().missingObjectIds, [first]);
});

test('gaps, unsupported tracked writes, incomplete effects and version regression invalidate state', () => {
  for (const bad of [checkpoint(3, []), checkpoint(2, [{ ...write(first, '11'), outputState: 'unknown' }]), checkpoint(2, [{ ...write(first, '11'), outputDigest: null }]), checkpoint(2, [write(first, '9')])]) {
    const state = new SuiCheckpointState('mainnet', chainIdentifier, [first]); state.apply(checkpoint(1, [write(first, '10')]));
    assert.throws(() => state.apply(bad), /DIVERGENCE|UNSUPPORTED|INCOMPLETE/);
    assert.throws(() => state.snapshot(), /RESYNC_REQUIRED/);
    assert.throws(() => state.apply(checkpoint(2, [write(first, '11')])), /RESYNC_REQUIRED/);
  }
});

test('recovery rebuilds identical references from committed observations rather than latest RPC objects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sui-checkpoint-state-'));
  try {
    const journal = new SourceJournal(join(directory, 'source.jsonl'), { sourceId: 'sui-test', chain: 'sui', network: 'mainnet', chainIdentifier });
    for (const cp of [checkpoint(1, [write(first, '10')]), checkpoint(2, [write(second, '20')])]) await journal.append({ identity: { chain: 'sui', network: 'mainnet', height: cp.checkpoint, checkpointDigest: cp.checkpointDigest }, parentDigest: cp.previousCheckpointDigest, payload: cp });
    const state = await recoverSuiCheckpointState(journal, [first, second]);
    assert.equal(state.snapshot().identity.height, '2'); assert.equal(state.snapshot().completeForDeclaredObjectSet, true);
    assert.deepEqual(state.snapshot().objects.map(object => object.version), ['10', '20']);
    const configPath = join(directory, 'state-config.json');
    await writeFile(configPath, JSON.stringify({ schemaVersion: '3.0', sourceId: 'sui-test', network: 'mainnet', expectedChainIdentifier: chainIdentifier, journalPath: join(directory, 'source.jsonl'), trackedObjectIds: [first, second] }));
    const output = await promisify(execFile)(process.execPath, ['dist/liquidity/cli.js', 'state-sui', configPath]);
    assert.equal(output.stderr, '');
    assert.deepEqual(JSON.parse(output.stdout), state.snapshot());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pinned object readers reject malformed or oversized reference sets before transport access', async () => {
  await assert.rejects(() => readSuiPinnedObjects('https://example.invalid', 'mainnet', chainIdentifier, []), /INVALID_PINNED_OBJECT_SET/);
  await assert.rejects(() => readSuiPinnedObjects('https://example.invalid', 'mainnet', chainIdentifier, [{ objectId: first, version: '0', digest: suiDigest(7) }]), /INVALID_PINNED_OBJECT_REF/);
  await assert.rejects(() => readSuiPinnedObjects('https://example.invalid', 'mainnet', chainIdentifier, [{ objectId: first, version: '1', digest: 'bad' }]), /INVALID_PINNED_OBJECT_REF/);
});

test('missing committed effects cannot silently preserve a stale complete object set', () => {
  const state = new SuiCheckpointState('mainnet', chainIdentifier, [first]);
  state.apply(checkpoint(1, [write(first, '10')]));
  assert.equal(state.snapshot().completeForDeclaredObjectSet, true);
  const incomplete = checkpoint(2, []); incomplete.transactions = [];
  assert.throws(() => state.apply(incomplete), /INCOMPLETE_CHECKPOINT_CONTENTS/);
  assert.throws(() => state.snapshot(), /RESYNC_REQUIRED/);
});
