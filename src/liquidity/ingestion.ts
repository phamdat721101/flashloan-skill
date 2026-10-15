import { createReadStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExecutionLock } from '../execution-lock.js';
import { digest, isSuiDigest, parseStateIdentity, uint, type StateIdentity } from './state.js';

export interface SourceBinding {
  sourceId: string;
  chain: StateIdentity['chain'];
  network: string;
  chainIdentifier: string;
}
export interface SourceFrame { identity: StateIdentity; parentDigest: string | null; payload: unknown }
export interface SourceRecord extends SourceFrame {
  schemaVersion: '3.0'; sourceId: string; chainIdentifier: string;
  payloadDigest: string; previousRecordDigest: string | null; recordDigest: string;
}
function chainDigest(identity: StateIdentity): string {
  return identity.chain === 'arbitrum' ? identity.blockHash : identity.checkpointDigest;
}

/** Bounded-memory JSONL recovery. A partial last record is never treated as committed. */
export async function* readSourceLines(path: string, maxRecordBytes: number, range?: { start: number; end: number }): AsyncGenerator<string> {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 || maxRecordBytes > 64 * 1024 * 1024) throw new Error('INVALID_SOURCE_RECORD_LIMIT');
  if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start)) throw new Error('INVALID_SOURCE_READ_RANGE');
  const stream = createReadStream(path, { highWaterMark: 65536,...range });
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, chunk as Buffer]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        if (end > maxRecordBytes) throw new Error('SOURCE_RECORD_TOO_LARGE');
        const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
        if (!line.length) throw new Error('SOURCE_JOURNAL_CORRUPT');
        // Buffer's default decoder replaces invalid UTF-8. Reject it instead.
        yield new TextDecoder('utf-8', { fatal: true }).decode(line);
      }
      if (pending.length > maxRecordBytes) throw new Error('SOURCE_RECORD_TOO_LARGE');
    }
    if (pending.length) throw new Error('SOURCE_JOURNAL_TORN_WRITE');
  } finally { stream.destroy(); }
}

/** One pinned source owns a log. The fsynced observation itself is its durable cursor. */
export class SourceJournal {
  private tail: Promise<void> = Promise.resolve();
  private cached: { size: number; mtimeMs: number; ino: number; last: SourceRecord | null } | undefined;
  constructor(private readonly path: string, readonly binding: Readonly<SourceBinding>, private readonly maxRecordBytes = 4 * 1024 * 1024) {
    if (!binding || Object.keys(binding).sort().join(',') !== 'chain,chainIdentifier,network,sourceId' || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 256 || maxRecordBytes > 64 * 1024 * 1024 || typeof binding.sourceId !== 'string' || !binding.sourceId || binding.sourceId.length > 128 || typeof binding.network !== 'string' || typeof binding.chainIdentifier !== 'string') throw new Error('INVALID_SOURCE_JOURNAL_CONFIG');
    const genesis = binding.chain === 'arbitrum' ? binding.chainIdentifier === binding.network : isSuiDigest(binding.chainIdentifier);
    if (!genesis || !['arbitrum', 'sui'].includes(binding.chain) || !(binding.chain === 'arbitrum' ? ['42161', '421614'] : ['mainnet', 'testnet', 'localnet']).includes(binding.network)) throw new Error('INVALID_SOURCE_BINDING');
    this.binding = Object.freeze(structuredClone(binding));
  }
  private validate(frame: SourceFrame): void {
    const identity = parseStateIdentity(frame.identity);
    if (identity.chain !== this.binding.chain || identity.network !== this.binding.network) throw new Error('SOURCE_CHAIN_MISMATCH');
    const validParent = identity.chain === 'arbitrum' ? typeof frame.parentDigest === 'string' && /^0x[0-9a-f]{64}$/.test(frame.parentDigest) : isSuiDigest(frame.parentDigest);
    if (!(frame.parentDigest === null ? identity.height === '0' : validParent)) throw new Error('INVALID_SOURCE_PARENT');
    digest(frame.payload);
  }
  private verify(record: SourceRecord, prior: SourceRecord | null): void {
    if (!record || Object.keys(record).sort().join(',') !== 'chainIdentifier,identity,parentDigest,payload,payloadDigest,previousRecordDigest,recordDigest,schemaVersion,sourceId' || record.schemaVersion !== '3.0' || record.sourceId !== this.binding.sourceId || record.chainIdentifier !== this.binding.chainIdentifier) throw new Error('SOURCE_JOURNAL_CORRUPT');
    this.validate(record);
    const { recordDigest, ...body } = record;
    if (digest(record.payload) !== record.payloadDigest || digest(body) !== recordDigest || record.previousRecordDigest !== (prior?.recordDigest ?? null)) throw new Error('SOURCE_JOURNAL_HASH_MISMATCH');
    if (prior && (uint(record.identity.height, 64) !== uint(prior.identity.height, 64) + 1n || record.parentDigest !== chainDigest(prior.identity))) throw new Error('SOURCE_GAP_OR_DIVERGENCE');
  }
  async *records(): AsyncGenerator<SourceRecord> {
    let prior: SourceRecord | null = null;
    try {
      for await (const line of readSourceLines(this.path, this.maxRecordBytes)) {
        const record = JSON.parse(line) as SourceRecord;
        this.verify(record, prior); prior = record;
        yield structuredClone(record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  async latest(): Promise<SourceRecord | null> {
    let info;
    try { info = await stat(this.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.cached = undefined; return null; } throw error;
    }
    if (this.cached && this.cached.size === info.size && this.cached.mtimeMs === info.mtimeMs && this.cached.ino === info.ino) return structuredClone(this.cached.last);
    let last: SourceRecord | null = null;
    for await (const record of this.records()) last = record;
    this.cached = { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, last };
    return structuredClone(last);
  }
  async append(input: SourceFrame): Promise<'committed' | 'duplicate'> {
    const frame = structuredClone(input); this.validate(frame);
    const operation = this.tail.then(() => new ExecutionLock(`${this.path}.lock`).runExclusive(async () => {
      const prior = await this.latest();
      if (prior && frame.identity.height === prior.identity.height) {
        if (digest(frame.identity) === digest(prior.identity) && frame.parentDigest === prior.parentDigest && digest(frame.payload) === prior.payloadDigest) return 'duplicate' as const;
        throw new Error('SOURCE_GAP_OR_DIVERGENCE');
      }
      const body = { ...frame, schemaVersion: '3.0' as const, sourceId: this.binding.sourceId, chainIdentifier: this.binding.chainIdentifier, payloadDigest: digest(frame.payload), previousRecordDigest: prior?.recordDigest ?? null };
      const record: SourceRecord = { ...body, recordDigest: digest(body) }; this.verify(record, prior);
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      if (bytes.length - 1 > this.maxRecordBytes) throw new Error('SOURCE_RECORD_TOO_LARGE');
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, 'a', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      // Sync the directory entry as well as the file on initial creation.
      const directory = await open(dirname(this.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      const info = await stat(this.path);
      this.cached = { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, last: record };
      return 'committed' as const;
    }));
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }
}

/** Deterministic bounded backfill; commit each frame before asking for the next one. */
export async function ingestSourceRange(journal: SourceJournal, start: string, end: string, maxFrames: number, read: (height: string) => Promise<SourceFrame>): Promise<{ committed: number; lastHeight: string }> {
  const first = uint(start, 64), last = uint(end, 64);
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 1000 || first > last || last - first + 1n > BigInt(maxFrames)) throw new Error('SOURCE_BACKFILL_LIMIT');
  const prior = await journal.latest();
  if (prior && uint(prior.identity.height, 64) < first - 1n) throw new Error('SOURCE_GAP_OR_DIVERGENCE');
  let next = prior && uint(prior.identity.height, 64) >= first ? uint(prior.identity.height, 64) + 1n : first;
  let committed = 0;
  for (; next <= last; next++) {
    const frame = await read(next.toString());
    if (frame.identity.height !== next.toString()) throw new Error('SOURCE_HEIGHT_MISMATCH');
    await journal.append(frame); committed++;
  }
  const latest = await journal.latest();
  if (!latest) throw new Error('SOURCE_JOURNAL_EMPTY');
  return { committed, lastHeight: latest.identity.height };
}

/** Journal first, then notify. A new native stream has no replay cursor: backfill bounded gaps explicitly. */
export async function reconcileNativeCheckpoints(journal: SourceJournal,stream: AsyncIterable<{ height: string; digest: string }>,read: (height: string) => Promise<SourceFrame>,options: { start: string; maxFrames: number; maxGap: number; signal?: AbortSignal },notify?: (frame: SourceFrame) => Promise<void>): Promise<{ committed: number; lastHeight: string | null }> {
  if (journal.binding.chain !== 'sui' || !Number.isSafeInteger(options.maxFrames) || options.maxFrames < 1 || options.maxFrames > 1000 || !Number.isSafeInteger(options.maxGap) || options.maxGap < 1 || options.maxGap > 1000) throw new Error('INVALID_NATIVE_CHECKPOINT_CONFIG');
  let prior = await journal.latest(), next = prior ? uint(prior.identity.height,64) + 1n : uint(options.start,64), committed = 0;
  if (options.signal?.aborted) return { committed,lastHeight: prior?.identity.height ?? null };
  const iterator = stream[Symbol.asyncIterator]();
  const wait = async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
    if (options.signal?.aborted) return undefined;
    let abort: (() => void) | undefined;
    const cancelled = new Promise<undefined>(resolve => { abort = () => resolve(undefined); options.signal?.addEventListener('abort',abort,{ once: true }); });
    try { return await Promise.race([operation(),cancelled]); }
    finally { if (abort) options.signal?.removeEventListener('abort',abort); }
  };
  try { while (true) {
    const item = await wait(() => iterator.next());
    if (!item || item.done) break;
    const hint = item.value;
    if (options.signal?.aborted) break;
    const height = uint(hint.height,64);
    if (height < next) {
      if (!prior || height !== uint(prior.identity.height,64) || prior.identity.chain !== 'sui' || prior.identity.checkpointDigest !== hint.digest) throw new Error('SOURCE_GAP_OR_DIVERGENCE');
      continue;
    }
    if (height - next + 1n > BigInt(options.maxGap)) throw new Error('SOURCE_BACKFILL_LIMIT');
    for (; next <= height && committed < options.maxFrames; next++) {
      if (options.signal?.aborted) return { committed,lastHeight: prior?.identity.height ?? null };
      const frame = await wait(() => read(next.toString()));
      if (!frame) return { committed,lastHeight: prior?.identity.height ?? null };
      if (frame.identity.chain !== 'sui' || frame.identity.height !== next.toString() || (next === height && frame.identity.checkpointDigest !== hint.digest)) throw new Error('CHECKPOINT_RECORD_IDENTITY_MISMATCH');
      if (options.signal?.aborted) return { committed,lastHeight: prior?.identity.height ?? null };
      await journal.append(frame); prior = await journal.latest(); committed++; if (notify) await notify(frame);
    }
    if (committed >= options.maxFrames) break;
  } } finally { if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {}); }
  return { committed,lastHeight: prior?.identity.height ?? null };
}

export interface FollowSourceOptions {
  start: string;
  maxFrames: number;
  maxGap: number;
  pollIntervalMs: number;
  maxIdlePolls: number;
  signal?: AbortSignal;
}

/** Live polling with bounded catch-up and backpressure. Restart from the durable cursor.
 * The downstream callback is not an exactly-once queue: recover/replay the journal
 * after a callback failure or process death between commit and callback.
 */
export async function followSource(
  journal: SourceJournal,
  options: FollowSourceOptions,
  head: () => Promise<string>,
  read: (height: string) => Promise<SourceFrame>,
  onCommitted: (frame: SourceFrame) => Promise<void> = async () => {}
): Promise<{ committed: number; lastHeight: string | null; status: 'frame-limit' | 'idle-limit' | 'cancelled' }> {
  const start = uint(options.start, 64);
  for (const value of [options.maxFrames, options.maxGap, options.maxIdlePolls]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error('INVALID_SOURCE_FOLLOW_LIMIT');
  }
  if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 100 || options.pollIntervalMs > 60000) throw new Error('INVALID_SOURCE_POLL_INTERVAL');
  let prior = await journal.latest(), committed = 0, idle = 0;
  if (prior && uint(prior.identity.height, 64) < start - 1n) throw new Error('SOURCE_GAP_OR_DIVERGENCE');
  let next = prior ? uint(prior.identity.height, 64) + 1n : start;
  const result = (status: 'frame-limit' | 'idle-limit' | 'cancelled') => ({ committed, lastHeight: prior?.identity.height ?? null, status });
  while (committed < options.maxFrames) {
    if (options.signal?.aborted) return result('cancelled');
    const latest = uint(await head(), 64);
    if (options.signal?.aborted) return result('cancelled');
    if (prior && latest < uint(prior.identity.height, 64)) throw new Error('SOURCE_HEAD_REGRESSION');
    if (latest >= next) {
      if (latest - next + 1n > BigInt(options.maxGap)) throw new Error('SOURCE_BACKFILL_LIMIT');
      idle = 0;
      for (; next <= latest && committed < options.maxFrames; next++) {
        if (options.signal?.aborted) return result('cancelled');
        const frame = structuredClone(await read(next.toString()));
        if (options.signal?.aborted) return result('cancelled');
        if (frame.identity.height !== next.toString()) throw new Error('SOURCE_HEIGHT_MISMATCH');
        // append verifies source binding, parent continuity and payload integrity.
        const status = await journal.append(frame);
        prior = await journal.latest();
        if (status === 'committed') { committed++; await onCommitted(frame); }
      }
    } else {
      // A stable height is not evidence of a stable hash (especially on Arbitrum).
      if (prior) {
        const current = await read(prior.identity.height);
        if (options.signal?.aborted) return result('cancelled');
        if (current.identity.height !== prior.identity.height) throw new Error('SOURCE_HEIGHT_MISMATCH');
        await journal.append(current);
      }
      if (++idle >= options.maxIdlePolls) return result('idle-limit');
    }
    if (committed >= options.maxFrames) return result('frame-limit');
    try { await delay(options.pollIntervalMs, undefined, { signal: options.signal }); }
    catch (error) { if (options.signal?.aborted) return result('cancelled'); throw error; }
  }
  return result('frame-limit');
}
