import { open, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { fields, record, text, parseObservation, type MarketObservation } from './l2-contracts.js';
import { EvidenceJournal, L2ContextEngine, materializeFrames, replayEvidence, refreshEvidence } from './l2-ingestion.js';
import { L2AgentServer, serveL2Stdio } from './l2-agent.js';
import { L2RiskJournal } from './l2-execution.js';
import { evaluateL2, type TrainingExample } from './l2-prediction.js';
import { captureArbitrumL2, captureSuiL2, fastFeedObservations, hyperliquidBook, streamMarketMessages, secureEndpoint, decimalAtoms, BinanceDepthBook, L2_CAPABILITIES, type ArbitrumL2Capture } from './l2-sources.js';
import { readSourceLines } from './ingestion.js';
import { digest, uint } from './state.js';
import type { CheckpointObjectSet, CetusDecodeConfig } from '../sui/cetus.js';
import { retainL2Segments, type L2Segment } from './l2-storage.js';

async function readInput(path: string): Promise<Record<string,unknown>> {
  const file = await open(path,'r');
  try {
    const size = (await file.stat()).size;
    if (size > 4*1024*1024) throw new Error('L2_INPUT_LIMIT');
    const bytes = Buffer.alloc(size+1); const result = await file.read(bytes,0,bytes.length,0);
    if (result.bytesRead !== size) throw new Error('L2_INPUT_CHANGED');
    return record(JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(bytes.subarray(0,size))));
  } finally { await file.close(); }
}
function output(value: unknown): void { process.stdout.write(JSON.stringify(value)+'\n'); }
function closedJournals(config: Record<string,unknown>): EvidenceJournal[] {
  if (config.closedJournalPaths === undefined) return [];
  if (!Array.isArray(config.closedJournalPaths) || config.closedJournalPaths.length > 100) throw new Error('L2_SEGMENT_LIMIT');
  return config.closedJournalPaths.map(path => { text(path); if (path === config.journalPath) throw new Error('L2_DUPLICATE_SEGMENT'); return new EvidenceJournal(path); });
}
async function seedEngine(config: Record<string,unknown>): Promise<L2ContextEngine> {
  const engine = new L2ContextEngine(); for (const journal of closedJournals(config)) await replayEvidence(journal,engine); return engine;
}
export async function runL2Cli(command: string,path?: string): Promise<void> {
  if (command === 'l2-sources') { output(L2_CAPABILITIES); return; }
  if (!path) throw new Error('L2_INPUT_REQUIRED');
  const config = await readInput(path);
  if (config.schemaVersion !== '1.0') throw new Error('L2_INVALID_VERSION');
  if (command === 'l2-retain') {
    fields(config,['schemaVersion','root','segments','pinned'],['dryRun']); text(config.root);
    if (config.dryRun !== undefined && typeof config.dryRun !== 'boolean') throw new Error('L2_INVALID_RETENTION_MODE');
    output(await retainL2Segments(config.root,config.segments as L2Segment[],config.pinned as string[],(BigInt(Date.now())*1000000n).toString(),config.dryRun !== false)); return;
  }
  if (command === 'l2-evaluate') {
    fields(config,['schemaVersion','datasetPath','chain','horizon']); text(config.datasetPath);
    const examples: TrainingExample[] = []; let bytes = 0;
    for await (const line of readSourceLines(config.datasetPath,4*1024*1024)) {
      bytes += Buffer.byteLength(line);
      if (examples.length >= 100000 || bytes > 128*1024*1024) throw new Error('L2_DATASET_LIMIT'); examples.push(JSON.parse(line));
    }
    output(evaluateL2(examples,config.chain as 'arbitrum' | 'sui',config.horizon as 'next' | '1m' | '5m' | '15m')); return;
  }
  if (command === 'l2-benchmark') {
    fields(config,['schemaVersion','journalPath'],['closedJournalPaths']); text(config.journalPath);
    const start = performance.now(), engine = await replayEvidence(new EvidenceJournal(config.journalPath),await seedEngine(config));
    const latency = engine.latency();
    output({ schemaVersion: '1.0',poolCount: engine.snapshot().length,replayMs: performance.now()-start,heapBytes: process.memoryUsage().heapUsed,...latency,targetLocalP95Ms: 100,targetMet: latency.p95LocalMs === null ? null : latency.p95LocalMs <= 100,scope: 'local-replay-only' }); return;
  }
  if (command === 'l2-follow') {
    fields(config,['schemaVersion','journalPath','outputPath','source'],['closedJournalPaths']); text(config.journalPath); text(config.outputPath);
    const journal = new EvidenceJournal(config.journalPath), source = record(config.source);
    const cursors = new Map<string,bigint>();
    for (const segment of [...closedJournals(config),journal]) for await (const row of segment.records()) cursors.set(digest([row.observation.sourceId,row.observation.generation]),BigInt(row.observation.cursor)+1n);
    const commit = async (o: MarketObservation,generated = true) => {
      const key = digest([o.sourceId,o.generation]), cursor = generated ? cursors.get(key) ?? BigInt(o.cursor) : BigInt(o.cursor);
      const status = await journal.append({ ...o,cursor: cursor.toString() });
      if (status === 'committed') cursors.set(key,cursor+1n);
      return status;
    };
    if (source.kind === 'jsonl') {
      fields(source,['kind','path']); text(source.path);
      for await (const line of readSourceLines(source.path,4*1024*1024)) await commit(parseObservation(JSON.parse(line)),false);
    } else if (source.kind === 'arbitrum') {
      fields(source,['kind','capture']);
      for (const o of await captureArbitrumL2(source.capture as ArbitrumL2Capture)) await commit(o);
    } else if (source.kind === 'sui') {
      fields(source,['kind','rpcUrl','sourceId','generation','cursor','checkpoint','configs']);
      text(source.rpcUrl); text(source.sourceId); text(source.generation);
      const { kind: _,...capture } = source;
      for (const o of await captureSuiL2(capture as unknown as Parameters<typeof captureSuiL2>[0])) await commit(o);
    } else if (source.kind === 'fast-feed' || source.kind === 'hyperliquid' || source.kind === 'binance') {
      fields(source,['kind','endpointEnv','binding','maxMessages'],['snapshotEndpointEnv']); text(source.endpointEnv,128);
      if (!Number.isInteger(source.maxMessages) || Number(source.maxMessages) < 1 || Number(source.maxMessages) > 100000) throw new Error('L2_STREAM_LIMIT');
      const endpoint = process.env[source.endpointEnv]; if (!endpoint) throw new Error('L2_ENDPOINT_ENV_REQUIRED');
      const binding = record(source.binding), controller = new AbortController(), abort = () => controller.abort();
      process.once('SIGINT',abort); process.once('SIGTERM',abort);
      let count = 0, cursor = uint(binding.cursor,64);
      const binance = new BinanceDepthBook(Number(binding.baseDecimals)); let needsSnapshot = true;
      try {
        const subscription = source.kind === 'hyperliquid' ? ['l2Book','trades'].map(type => ({ method: 'subscribe',subscription: { type,coin: binding.coin } })) : null;
        const marketTrade = async (venue: 'binance' | 'hyperliquid',id: string,side: 'buy' | 'sell',price: unknown,quantity: unknown,timeMs: unknown) => {
          if (!Number.isSafeInteger(timeMs) || Number(timeMs) < 0) throw new Error('L2_INVALID_MARKET_TIME');
          await commit(parseObservation({ schemaVersion: '1.0',sourceId: binding.sourceId,generation: binding.generation,cursor: (cursor++).toString(),eventId: `${venue}-trade:${id}`,poolId: binding.poolId,identity: null,parentDigest: null,status: 'external',eventTimeNs: (BigInt(timeMs as number)*1000000n).toString(),receivedTimeNs: (BigInt(Date.now())*1000000n).toString(),evidence: `${venue}-trade:${digest({ id,price,quantity,timeMs })}`,payload: { kind: 'market-trade',venue,baseAsset: binding.baseAsset,quoteAsset: binding.quoteAsset,side,price: decimalAtoms(price,9),quantity: decimalAtoms(quantity,Number(binding.baseDecimals)) } }));
        };
        for await (const message of streamMarketMessages(endpoint,subscription,controller.signal)) {
          const received = (BigInt(Date.now())*1000000n).toString();
          if (source.kind === 'fast-feed') {
            const observations = fastFeedObservations(message,{ ...binding,cursor: cursor.toString() } as Parameters<typeof fastFeedObservations>[1],received);
            for (const o of observations) { await commit(o); cursor++; }
          } else if (source.kind === 'hyperliquid') {
            const envelope = record(message);
            if (envelope.channel === 'l2Book') {
              const book = hyperliquidBook(envelope.data,String(binding.coin),Number(binding.baseDecimals));
              const { timeMs,...depth } = book;
              await commit(parseObservation({ schemaVersion: '1.0',sourceId: binding.sourceId,generation: binding.generation,cursor: (cursor++).toString(),eventId: digest(message),poolId: binding.poolId,identity: null,parentDigest: null,status: 'external',eventTimeNs: (BigInt(timeMs)*1000000n).toString(),receivedTimeNs: received,evidence: `hyperliquid:${digest(message)}`,payload: { kind: 'market-book',venue: 'hyperliquid',baseAsset: binding.baseAsset,quoteAsset: binding.quoteAsset,...depth } }));
            } else if (envelope.channel === 'trades') {
              if (!Array.isArray(envelope.data) || envelope.data.length > 1000) throw new Error('L2_MARKET_TRADE_LIMIT');
              for (const raw of envelope.data) {
                const t = record(raw);
                if (t.coin !== binding.coin || !['A','B'].includes(String(t.side)) || !Number.isSafeInteger(t.tid)) throw new Error('L2_INVALID_MARKET_TRADE');
                await marketTrade('hyperliquid',String(t.tid),t.side === 'B' ? 'buy' : 'sell',t.px,t.sz,t.time);
              }
            }
          } else {
            const envelope = record(message), event = record(envelope.data ?? message);
            if (event.e === 'trade') {
              if (event.s !== binding.symbol || typeof event.m !== 'boolean' || !Number.isSafeInteger(event.t)) throw new Error('L2_INVALID_MARKET_TRADE');
              await marketTrade('binance',String(event.t),event.m ? 'sell' : 'buy',event.p,event.q,event.E);
              if (++count >= Number(source.maxMessages)) break;
              continue;
            }
            if (event.e !== 'depthUpdate' || event.s !== binding.symbol || !Number.isSafeInteger(event.E) || Number(event.E) < 0) throw new Error('L2_BINANCE_INSTRUMENT_MISMATCH');
            if (needsSnapshot) {
              text(source.snapshotEndpointEnv,128); const snapshotUrl = process.env[source.snapshotEndpointEnv];
              if (!snapshotUrl) throw new Error('L2_ENDPOINT_ENV_REQUIRED'); secureEndpoint(snapshotUrl);
              const response = await fetch(snapshotUrl,{ signal: AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]) });
              if (!response.ok || !response.body) throw new Error('L2_MARKET_SNAPSHOT_FAILED');
              const chunks: Uint8Array[] = []; let size = 0;
              for await (const chunk of response.body) { size += chunk.length; if (size > 4*1024*1024) throw new Error('L2_INPUT_LIMIT'); chunks.push(chunk); }
              binance.snapshot(JSON.parse(Buffer.concat(chunks).toString('utf8'))); needsSnapshot = false;
            }
            try {
              if (binance.apply(event) === 'applied') await commit(parseObservation({ schemaVersion: '1.0',sourceId: binding.sourceId,generation: binding.generation,cursor: (cursor++).toString(),eventId: digest(message),poolId: binding.poolId,identity: null,parentDigest: null,status: 'external',eventTimeNs: (BigInt(event.E as number)*1000000n).toString(),receivedTimeNs: received,evidence: `binance:${digest(message)}`,payload: { kind: 'market-book',venue: 'binance',baseAsset: binding.baseAsset,quoteAsset: binding.quoteAsset,...binance.book() } }));
            } catch (error) {
              if (!(error instanceof Error) || error.message !== 'L2_BOOK_RESYNC_REQUIRED') throw error;
              needsSnapshot = true; process.stderr.write('L2_BOOK_RESYNC_REQUIRED\n');
            }
          }
          if (++count >= Number(source.maxMessages)) break;
        }
      } finally { controller.abort(); process.removeListener('SIGINT',abort); process.removeListener('SIGTERM',abort); }
    } else throw new Error('L2_UNSUPPORTED_SOURCE');
    output(await materializeFrames(journal,config.outputPath,closedJournals(config))); return;
  }
  if (command === 'l2-replay') {
    fields(config,['schemaVersion','journalPath','outputPath'],['closedJournalPaths']); text(config.journalPath); text(config.outputPath);
    output(await materializeFrames(new EvidenceJournal(config.journalPath),config.outputPath,closedJournals(config))); return;
  }
  if (command === 'l2-inspect') {
    fields(config,['schemaVersion','journalPath','poolId'],['closedJournalPaths']); text(config.journalPath); text(config.poolId);
    output((await replayEvidence(new EvidenceJournal(config.journalPath),await seedEngine(config))).inspect(config.poolId,(BigInt(Date.now())*1000000n).toString())); return;
  }
  if (command === 'l2-serve') {
    fields(config,['schemaVersion','journalPath'],['riskJournalPath','closedJournalPaths']); text(config.journalPath);
    if (config.riskJournalPath !== undefined) text(config.riskJournalPath);
    const journal = new EvidenceJournal(config.journalPath), reader = journal.reader(), engine = await seedEngine(config);
    await refreshEvidence(reader,engine);
    const server = new L2AgentServer(engine,undefined,config.riskJournalPath ? new L2RiskJournal(config.riskJournalPath as string) : undefined);
    let tail = Promise.resolve(), stopped = false, refreshFailure: Error | undefined;
    const write = (line: string) => { tail = tail.then(async () => { if (!process.stdout.write(line)) await new Promise<void>(resolve => process.stdout.once('drain',resolve)); }); return tail; };
    const watcher = (async () => {
      let fingerprint = '';
      while (!stopped) {
        try {
          const info = await stat(journal.path), next = `${info.ino}:${info.size}:${info.mtimeMs}`;
          if (next !== fingerprint) {
            await refreshEvidence(reader,engine);
            for (const update of server.replaceEngine(engine)) await write(JSON.stringify(update)+'\n');
            fingerprint = next;
          }
        } catch (error) { refreshFailure = error instanceof Error ? error : new Error('L2_REFRESH_FAILED'); stopped = true; process.stdin.destroy(); }
        if (!stopped) await delay(250);
      }
    })();
    try { await serveL2Stdio(server,process.stdin,write); }
    finally { stopped = true; await watcher; await tail; }
    if (refreshFailure) throw refreshFailure;
    return;
  }
  throw new Error('L2_UNSUPPORTED_COMMAND');
}
