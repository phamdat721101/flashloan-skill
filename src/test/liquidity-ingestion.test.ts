import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toBase58 } from '@mysten/sui/utils';
import { followSource, ingestSourceRange, SourceJournal, type SourceBinding, type SourceFrame } from '../liquidity/ingestion.js';

const bindings: SourceBinding[] = [
  { sourceId: 'arb-test', chain: 'arbitrum', network: '42161', chainIdentifier: '42161' },
  { sourceId: 'sui-test', chain: 'sui', network: 'mainnet', chainIdentifier: toBase58(new Uint8Array(32).fill(4)) }
];
function frame(binding: SourceBinding, height: number): SourceFrame {
  const chainDigest = (value: number) => binding.chain === 'arbitrum' ? `0x${value.toString(16).padStart(64, '0')}` : toBase58(new Uint8Array(32).fill(value + 1));
  const identity = binding.chain === 'arbitrum'
    ? { chain: 'arbitrum' as const, network: '42161' as const, height: String(height), blockHash: chainDigest(height) }
    : { chain: 'sui' as const, network: 'mainnet' as const, height: String(height), checkpointDigest: chainDigest(height) };
  return { identity, parentDigest: height === 0 ? null : chainDigest(height - 1), payload: { reserve: String(height * 100) } };
}
async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'liquidity-ingestion-'));
  try { await run(join(directory, 'source.jsonl')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('source observations commit parent/hash-linked cursors and resume exactly after restart on both chains', async () => {
  for (const binding of bindings) await fixture(async path => {
    const calls: string[] = [];
    await assert.rejects(ingestSourceRange(new SourceJournal(path, binding), '1', '4', 4, async height => {
      calls.push(height); if (height === '3') throw new Error('TRANSIENT_SOURCE_FAILURE'); return frame(binding, Number(height));
    }), /TRANSIENT_SOURCE_FAILURE/);
    assert.equal((await new SourceJournal(path, binding).latest())!.identity.height, '2');
    const result = await ingestSourceRange(new SourceJournal(path, binding), '1', '4', 4, async height => {
      calls.push(height); return frame(binding, Number(height));
    });
    assert.deepEqual(result, { committed: 2, lastHeight: '4' });
    assert.deepEqual(calls, ['1', '2', '3', '3', '4']);
    const records = []; for await (const record of new SourceJournal(path, binding).records()) records.push(record);
    assert.equal(records.length, 4); assert.equal(records[1].previousRecordDigest, records[0].recordDigest);
    const resumed = await ingestSourceRange(new SourceJournal(path, binding), '1', '4', 4, async () => { throw new Error('MUST_NOT_REPLAY_COMMITTED_DATA'); });
    assert.equal(resumed.committed, 0);
  });
});

test('duplicate observations are idempotent; gaps, divergent parents and changed payloads never advance the cursor', async () => {
  for (const binding of bindings) await fixture(async path => {
    const journal = new SourceJournal(path, binding), first = frame(binding, 1);
    assert.equal(await journal.append(first), 'committed'); assert.equal(await journal.append(first), 'duplicate');
    await assert.rejects(journal.append({ ...first, payload: { reserve: 'tampered' } }), /DIVERGENCE/);
    await assert.rejects(journal.append(frame(binding, 3)), /DIVERGENCE/);
    await assert.rejects(journal.append({ ...frame(binding, 2), parentDigest: first.parentDigest }), /DIVERGENCE/);
    assert.equal((await journal.latest())!.identity.height, '1');
  });
});

test('concurrent same-process source writes are serialized and cached cursors notice another writer', async () => {
  await fixture(async path => {
    const binding = bindings[0], first = new SourceJournal(path, binding);
    await Promise.all([first.append(frame(binding, 1)), first.append(frame(binding, 2))]);
    const second = new SourceJournal(path, binding); await second.append(frame(binding, 3));
    assert.equal((await first.latest())!.identity.height, '3');
    await assert.rejects(new SourceJournal(path, { ...binding, sourceId: 'other' }).latest(), /CORRUPT/);
  });
});

test('torn writes and hash corruption fail closed before recovery reads another observation', async () => {
  await fixture(async path => {
    const binding = bindings[0]; await new SourceJournal(path, binding).append(frame(binding, 1));
    const original = await readFile(path, 'utf8');
    await appendFile(path, '{"partial":');
    let reads = 0;
    await assert.rejects(ingestSourceRange(new SourceJournal(path, binding), '1', '2', 2, async () => { reads++; return frame(binding, 2); }), /TORN_WRITE/);
    assert.equal(reads, 0);
    const changed = JSON.parse(original); changed.payload.reserve = 'changed';
    await writeFile(path, JSON.stringify(changed) + '\n');
    await assert.rejects(new SourceJournal(path, binding).latest(), /HASH_MISMATCH/);
  });
});

test('source record size and range bounds reject before unbounded work', async () => {
  await fixture(async path => {
    const binding = bindings[0], journal = new SourceJournal(path, binding, 1024);
    await assert.rejects(journal.append({ ...frame(binding, 1), payload: 'x'.repeat(1024) }), /TOO_LARGE/);
    assert.equal(await journal.latest(), null);
    await assert.rejects(ingestSourceRange(journal, '1', '100', 10, async () => { throw new Error('MUST_NOT_READ'); }), /BACKFILL_LIMIT/);
    await writeFile(path, 'x'.repeat(1025));
    await assert.rejects(new SourceJournal(path, binding, 1024).latest(), /TOO_LARGE/);
  });
});

test('an exclusive source lock blocks another process and an incorrect reader height cannot be committed', async () => {
  await fixture(async path => {
    const binding = bindings[0], journal = new SourceJournal(path, binding);
    await writeFile(`${path}.lock`, 'other-process\n', { flag: 'wx' });
    await assert.rejects(journal.append(frame(binding, 1)), /already in progress/);
    await rm(`${path}.lock`);
    await assert.rejects(ingestSourceRange(journal, '1', '1', 1, async () => frame(binding, 2)), /HEIGHT_MISMATCH/);
    assert.equal(await journal.latest(), null);
  });
});

const followOptions = { start: '1', maxFrames: 3, maxGap: 4, pollIntervalMs: 100, maxIdlePolls: 1 };
test('live follower backfills both chains and exposes only durable frames with downstream backpressure', async () => {
  for (const binding of bindings) await fixture(async path => {
    const journal = new SourceJournal(path, binding), order: string[] = [];
    const result = await followSource(journal, followOptions, async () => '3', async height => {
      order.push(`read:${height}`); return frame(binding, Number(height));
    }, async observed => {
      assert.equal((await new SourceJournal(path, binding).latest())?.identity.height, observed.identity.height);
      order.push(`durable:${observed.identity.height}`);
    });
    assert.deepEqual(order, ['read:1', 'durable:1', 'read:2', 'durable:2', 'read:3', 'durable:3']);
    assert.deepEqual(result, { committed: 3, lastHeight: '3', status: 'frame-limit' });
    const restarted = await followSource(new SourceJournal(path, binding), { ...followOptions, maxFrames: 1 }, async () => '4', async height => frame(binding, Number(height)));
    assert.equal(restarted.lastHeight, '4'); assert.equal(restarted.committed, 1);
  });
});

test('live follower rejects oversized gaps, regressed heads and invalid limits before reading state', async () => {
  await fixture(async path => {
    const journal = new SourceJournal(path, bindings[0]); let reads = 0;
    const read = async (height: string) => { reads++; return frame(bindings[0], Number(height)); };
    await assert.rejects(followSource(journal, followOptions, async () => '6', read), /BACKFILL_LIMIT/);
    await assert.rejects(followSource(journal, { ...followOptions, maxGap: 0 }, async () => '1', read), /FOLLOW_LIMIT/);
    await journal.append(frame(bindings[0], 2));
    await assert.rejects(followSource(journal, followOptions, async () => '1', read), /HEAD_REGRESSION/);
    assert.equal(reads, 0);
  });
});

test('live follower stops on cancellation or idle bounds and preserves commits after downstream failure', async () => {
  await fixture(async path => {
    const journal = new SourceJournal(path, bindings[0]), controller = new AbortController();
    const idle = await followSource(journal, followOptions, async () => '0', async () => { throw new Error('MUST_NOT_READ'); });
    assert.equal(idle.status, 'idle-limit'); assert.equal(idle.lastHeight, null);
    const cancelled = await followSource(journal, { ...followOptions, signal: controller.signal }, async () => '3', async height => frame(bindings[0], Number(height)), async () => controller.abort());
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.lastHeight, '1');
    await assert.rejects(followSource(journal, followOptions, async () => '3', async height => frame(bindings[0], Number(height)), async () => { throw new Error('DOWNSTREAM_FAILURE'); }), /DOWNSTREAM_FAILURE/);
    assert.equal((await new SourceJournal(path, bindings[0]).latest())?.identity.height, '2');
  });
});

test('a same-height reorg cannot pass the live follower idle check', async () => {
  await fixture(async path => {
    const binding = bindings[0], journal = new SourceJournal(path, binding);
    await journal.append(frame(binding, 1));
    await assert.rejects(followSource(journal, followOptions, async () => '1', async () => ({
      ...frame(binding, 1), identity: { ...frame(binding, 1).identity, chain: 'arbitrum', network: '42161', blockHash: `0x${'f'.repeat(64)}` }
    })), /DIVERGENCE/);
    assert.equal((await journal.latest())?.identity.height, '1');
  });
});
