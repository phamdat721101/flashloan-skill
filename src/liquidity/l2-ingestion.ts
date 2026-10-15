import { mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ExecutionLock } from '../execution-lock.js';
import { readSourceLines } from './ingestion.js';
import { digest } from './state.js';
import { performance } from 'node:perf_hooks';
import { parseObservation, ns, type MarketObservation, type MicrostructureFrame } from './l2-contracts.js';
import { buildMicrostructureFrame } from './l2-metrics.js';

export interface EvidenceRecord { observation: MarketObservation; previousDigest: string | null; recordDigest: string }
function observationDigest(o: MarketObservation): string {
  const { cursor: _,receivedTimeNs: _received,...semantic } = o;
  return digest(semantic);
}

/** Verified append cursor; retain only identities/hashes, not historical payloads.
 * A replacement/truncation is a hard resync, not a trusted continuation.
 */
export class EvidenceTail {
  private offset = 0;
  private ino: number | undefined;
  private mtime = 0;
  count = 0;
  digest: string | null = null;
  readonly cursors = new Map<string,bigint>();
  readonly ids = new Map<string,string>();
  constructor(private readonly path: string,private readonly maxRecords = 100000) {}
  async *read(): AsyncGenerator<EvidenceRecord> {
    let info;
    try { info = await stat(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && this.ino === undefined) return; throw error; }
    if ((this.ino !== undefined && this.ino !== info.ino) || info.size < this.offset || (info.size === this.offset && this.ino !== undefined && info.mtimeMs !== this.mtime)) throw new Error('L2_JOURNAL_REPLACED');
    if (info.size > this.offset) for await (const line of readSourceLines(this.path,4*1024*1024,{ start: this.offset,end: info.size-1 })) {
      if (this.count >= this.maxRecords) throw new Error('L2_SEGMENT_FULL');
      const row = JSON.parse(line) as EvidenceRecord;
      if (!row || Object.keys(row).sort().join(',') !== 'observation,previousDigest,recordDigest') throw new Error('L2_CORRUPT_JOURNAL');
      const o = parseObservation(row.observation), key = digest([o.sourceId,o.generation]), id = `${key}:${o.eventId}`, before = this.cursors.get(key), cursor = BigInt(o.cursor);
      if (row.previousDigest !== this.digest || row.recordDigest !== digest({ observation: o,previousDigest: this.digest }) || this.ids.has(id) || (before !== undefined && cursor !== before+1n)) throw new Error('L2_JOURNAL_DIVERGENCE');
      this.cursors.set(key,cursor); this.ids.set(id,observationDigest(o)); this.count++; this.digest = row.recordDigest; this.offset += Buffer.byteLength(line)+1;
      yield row;
    }
    this.ino = info.ino; this.mtime = info.mtimeMs;
  }
}

/** A bounded hash-linked segment. Rotate explicitly; never silently discard evidence.
 * Source journals remain unchanged: external/provisional data is not chain history.
 */
export class EvidenceJournal {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly writer: EvidenceTail;
  constructor(readonly path: string,private readonly maxRecords = 100000) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100000) throw new Error('L2_INVALID_SEGMENT_LIMIT');
    this.writer = new EvidenceTail(path,maxRecords);
  }
  reader(): EvidenceTail { return new EvidenceTail(this.path,this.maxRecords); }
  async *records(): AsyncGenerator<EvidenceRecord> {
    yield* this.reader().read();
  }
  async append(input: unknown): Promise<'committed' | 'duplicate'> {
    const observation = parseObservation(input);
    const op = this.tail.then(() => new ExecutionLock(`${this.path}.lock`).runExclusive(async () => {
      for await (const _row of this.writer.read()) { /* verify only unseen bytes */ }
      const key = digest([observation.sourceId,observation.generation]), id = `${key}:${observation.eventId}`, previous = this.writer.ids.get(id);
      if (previous !== undefined) {
        if (previous !== observationDigest(observation)) throw new Error('L2_EVENT_SUBSTITUTION');
        return 'duplicate' as const;
      }
      if (this.writer.count >= this.maxRecords) throw new Error('L2_SEGMENT_FULL');
      const cursor = this.writer.cursors.get(key), prior = this.writer.digest;
      if (cursor !== undefined && BigInt(observation.cursor) !== cursor+1n) throw new Error('L2_SOURCE_GAP');
      const body = { observation,previousDigest: prior }, row = { ...body,recordDigest: digest(body) };
      await durableAppend(this.path,row);
      return 'committed' as const;
    }));
    this.tail = op.catch(() => {}); return op;
  }
}
export async function durableAppend(path: string,value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value)+'\n');
  if (bytes.length > 4*1024*1024) throw new Error('L2_RECORD_LIMIT');
  await mkdir(dirname(path),{ recursive: true });
  const handle = await open(path,'a',0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const dir = await open(dirname(path),'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

/** Evidence -> bounded reducer -> deterministic frame; invalidate before rebuilding.
 * Idempotence is logical event identity across sources, not arrival order.
 */
export class L2ContextEngine {
  private history = new Map<string,MarketObservation[]>();
  private seen = new Map<string,string>();
  private invalid = new Set<string>();
  private frames = new Map<string,MicrostructureFrame>();
  private auxiliary = new Map<string,Map<string,MarketObservation>>();
  private rejected = new Map<string,string>();
  private processingMs: number[] = [];
  constructor(private readonly maxPools = 20,private readonly maxHistory = 10000) {
    if (!Number.isInteger(maxPools) || maxPools < 1 || maxPools > 100 || !Number.isInteger(maxHistory) || maxHistory < 2 || maxHistory > 100000) throw new Error('L2_INVALID_ENGINE_LIMIT');
  }
  apply(input: unknown): MicrostructureFrame | null {
    const o = parseObservation(input), key = digest([o.poolId,o.generation]), logical = `${key}:${o.eventId}`;
    if (o.payload.kind === 'invalidate') {
      const old = digest([o.poolId,o.payload.generation]); this.invalid.add(old); this.history.delete(old);
      for (const key of this.seen.keys()) if (key.startsWith(`${old}:`)) this.seen.delete(key);
      if (this.frames.get(o.poolId)?.generation === o.payload.generation) this.frames.delete(o.poolId);
      return null;
    }
    if (this.invalid.has(key)) throw new Error('L2_INVALIDATED_GENERATION');
    if (o.status === 'provisional') return null;
    if (o.status === 'external') {
      const sources = this.auxiliary.get(o.poolId) ?? new Map<string,MarketObservation>();
      const sourceKey = `${o.sourceId}:${o.payload.kind}`, prior = sources.get(sourceKey);
      if (prior && (ns(o.receivedTimeNs) < ns(prior.receivedTimeNs) || BigInt(o.cursor) <= BigInt(prior.cursor))) {
        if (digest(prior) === digest(o)) return null;
        throw new Error('L2_MARKET_ORDER');
      }
      if (sources.size >= 10 && !sources.has(sourceKey)) throw new Error('L2_SOURCE_LIMIT');
      if (this.auxiliary.size >= this.maxPools && !this.auxiliary.has(o.poolId)) throw new Error('L2_WATCHLIST_LIMIT');
      sources.set(sourceKey,o); this.auxiliary.set(o.poolId,sources); return null;
    }
    const semantic = digest({ identity: o.identity,eventTimeNs: o.eventTimeNs,payload: o.payload });
    if (this.seen.has(logical)) {
      if (this.seen.get(logical) !== semantic) throw new Error('L2_EVENT_SUBSTITUTION');
      return null;
    }
    const history = this.history.get(key) ?? [];
    if (!this.history.has(key) && this.history.size >= this.maxPools) throw new Error('L2_WATCHLIST_LIMIT');
    const prior = this.frames.get(o.poolId);
    if (prior && o.payload.kind !== 'pool' && o.payload.kind !== 'deepbook' && ns(o.eventTimeNs) < ns(prior.quality.windowStartNs)) return null;
    if (prior && prior.generation !== o.generation) throw new Error('L2_INVALIDATION_REQUIRED');
    if (prior && ['pool','deepbook'].includes(o.payload.kind)) {
      const reason = BigInt(o.identity!.height) !== BigInt(prior.identity.height)+1n ? 'L2_CANONICAL_GAP' : o.parentDigest !== (prior.identity.chain === 'arbitrum' ? prior.identity.blockHash : prior.identity.checkpointDigest) ? 'L2_PARENT_DIVERGENCE' : null;
      if (reason) { this.invalid.add(key); this.frames.delete(o.poolId); this.history.delete(key); for (const id of this.seen.keys()) if (id.startsWith(`${key}:`)) this.seen.delete(id); this.rejected.set(o.poolId,reason); throw new Error(reason); }
    }
    if (history.length && ns(o.receivedTimeNs) < ns(history[history.length-1].receivedTimeNs)) throw new Error('L2_NON_MONOTONIC_ARRIVAL');
    const start = ns(o.eventTimeNs) - 60n*60000000000n;
    // Keep one pre-window observation to prove warmup, plus the bounded window.
    const before = history.filter(v => ns(v.eventTimeNs) < start).at(-1);
    const kept = history.filter(v => ns(v.eventTimeNs) >= start);
    if (before) kept.unshift(before);
    const retained = new Set(kept.map(v => `${key}:${v.eventId}`));
    for (const id of this.seen.keys()) if (id.startsWith(`${key}:`) && !retained.has(id)) this.seen.delete(id);
    if (kept.length >= this.maxHistory || this.seen.size >= this.maxPools*this.maxHistory) throw new Error('L2_HISTORY_LIMIT');
    const next = [...kept,o];
    const started = performance.now();
    const frame = ['pool','deepbook'].includes(o.payload.kind) ? buildMicrostructureFrame(o,[...next,...(this.auxiliary.get(o.poolId)?.values() ?? [])],prior) : null;
    this.history.set(key,next); this.seen.set(logical,semantic);
    if (frame) { this.frames.set(o.poolId,frame); this.rejected.delete(o.poolId); this.processingMs.push(performance.now()-started); if (this.processingMs.length > 1024) this.processingMs.shift(); }
    return frame;
  }
  inspect(poolId: string,nowNs: string): MicrostructureFrame {
    const frame = this.frames.get(poolId);
    if (!frame) throw new Error(this.rejected.has(poolId) ? 'L2_RESYNC_REQUIRED' : 'L2_POOL_NOT_FOUND');
    const age = ns(nowNs)-ns(frame.receivedTimeNs), limit = frame.identity.chain === 'arbitrum' ? 2000000000n : 5000000000n;
    if (age < 0n || age > limit) throw new Error('L2_STALE_STATE');
    return structuredClone(frame);
  }
  snapshot(): MicrostructureFrame[] { return structuredClone([...this.frames.values()]); }
  diagnostics(): Record<string,string> { return Object.fromEntries(this.rejected); }
  latency(): { samples: number; p95LocalMs: number | null } {
    const sorted = [...this.processingMs].sort((a,b) => a-b);
    return { samples: sorted.length,p95LocalMs: sorted.length ? sorted[Math.ceil(sorted.length*0.95)-1] : null };
  }
}
function applyEvidence(engine: L2ContextEngine,observation: MarketObservation): { frame: MicrostructureFrame | null; rejection: string | null } {
  try { return { frame: engine.apply(observation),rejection: null }; }
  catch (error) {
    if (error instanceof Error && ['L2_CANONICAL_GAP','L2_PARENT_DIVERGENCE','L2_INVALIDATED_GENERATION'].includes(error.message)) return { frame: null,rejection: error.message };
    throw error;
  }
}
export async function replayEvidence(journal: EvidenceJournal,engine = new L2ContextEngine()): Promise<L2ContextEngine> {
  await refreshEvidence(journal.reader(),engine);
  return engine;
}
export async function refreshEvidence(reader: EvidenceTail,engine: L2ContextEngine): Promise<void> {
  for await (const r of reader.read()) applyEvidence(engine,r.observation);
}

/** Output and its consumed input digest commit in one fsynced record. Replaying
 * after a crash before acknowledgement cannot publish a second logical output.
 */
export async function materializeFrames(journal: EvidenceJournal,outputPath: string,closedJournals: readonly EvidenceJournal[] = []): Promise<{ frames: number; records: number; rejected: number }> {
  return new ExecutionLock(`${outputPath}.lock`).runExclusive(async () => {
    const existing: Array<{ inputDigest: string; frameId: string | null; rejection: string | null }> = [];
    try { for await (const line of readSourceLines(outputPath,4*1024*1024)) {
      const row = JSON.parse(line);
      if (row.recordDigest !== digest({ inputDigest: row.inputDigest,frame: row.frame,rejection: row.rejection }) || (row.frame && row.frame.frameId !== digest(Object.fromEntries(Object.entries(row.frame).filter(([key]) => key !== 'frameId'))))) throw new Error('L2_CORRUPT_OUTPUT');
      existing.push({ inputDigest: row.inputDigest,frameId: row.frame?.frameId ?? null,rejection: row.rejection });
      if (existing.length > 100000) throw new Error('L2_SEGMENT_FULL');
    } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const engine = new L2ContextEngine(); let records = 0, frames = 0, rejected = 0;
    if (closedJournals.length > 100) throw new Error('L2_SEGMENT_LIMIT');
    for (const closed of closedJournals) await replayEvidence(closed,engine);
    for await (const r of journal.records()) {
      const { frame,rejection } = applyEvidence(engine,r.observation), old = existing[records++];
      if (old) { if (old.inputDigest !== r.recordDigest || old.frameId !== (frame?.frameId ?? null) || old.rejection !== rejection) throw new Error('L2_OUTPUT_DIVERGENCE'); continue; }
      const body = { inputDigest: r.recordDigest,frame,rejection };
      if (rejection) rejected++;
      await durableAppend(outputPath,{ ...body,recordDigest: digest(body) }); if (frame) frames++;
    }
    if (existing.length > records) throw new Error('L2_OUTPUT_DIVERGENCE');
    return { frames,records,rejected };
  });
}
