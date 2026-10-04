import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NimRuntimeMemory } from '../nim-memory.js';

test('records sanitized runtime events and promotes one reusable failure lesson', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flashloan-nim-memory-'));
  const memory = new NimRuntimeMemory(root);
  const event = { schemaVersion: '1.0' as const, occurredAt: '2026-10-04T00:00:00.000Z', runId: 'run-1', stage: 'solve' as const, outcome: 'failed' as const, code: 'QUOTE_TIMEOUT', retryable: true, detail: `privateKey=0x${'1'.repeat(64)}` };
  await memory.record(event);
  await memory.record({ ...event, runId: 'run-2' });
  const events = await readFile(join(root, 'memory.jsonl'), 'utf8');
  const lessons = await readFile(join(root, 'lessons.jsonl'), 'utf8');
  assert.equal(events.split('\n').filter(Boolean).length, 2);
  assert.doesNotMatch(events, /1{64}/);
  assert.equal(lessons.split('\n').filter(Boolean).length, 1);
});
