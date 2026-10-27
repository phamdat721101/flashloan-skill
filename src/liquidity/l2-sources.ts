import { createPublicClient, http, decodeEventLog, parseAbi, type Address, type Hex } from 'viem';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { readArbitrumAnalyticsSnapshot, readSuiCetusAnalyticsSnapshot, readSuiCheckpoint, type AnalyticsPoolConfig } from './sources.js';
import type { CheckpointObjectSet, CetusDecodeConfig } from '../sui/cetus.js';
import { digest, uint } from './state.js';
import { parseObservation, fields, record, text, type MarketLevel, type MarketObservation } from './l2-contracts.js';

export const L2_CAPABILITIES = [
  { id: 'arbitrum-rpc', mode: 'canonical', implemented: true },
  { id: 'sui-pinned-analytics', mode: 'canonical', implemented: true },
  { id: 'arbitrum-standard-feed', mode: 'hint-only', implemented: true },
  { id: 'arbitrum-fast-feed', mode: 'provisional', implemented: true },
  { id: 'binance-depth', mode: 'external', implemented: true },
  { id: 'hyperliquid-book', mode: 'external', implemented: true }
] as const;
export function sequencerHints(raw: unknown): Array<{ sequence: string; tentativeHeight: string }> {
  const feed = record(raw);
  if (feed.version !== 1 || !Array.isArray(feed.messages) || feed.messages.length > 1000) throw new Error('L2_UNSUPPORTED_SEQUENCER_FEED');
  return feed.messages.map(value => {
    const message = record(value);
    if (!Number.isSafeInteger(message.sequenceNumber) || Number(message.sequenceNumber) < 0) throw new Error('L2_UNSAFE_FEED_SEQUENCE');
    const sequence = BigInt(message.sequenceNumber as number);
    return { sequence: sequence.toString(),tentativeHeight: (sequence+22207817n).toString() };
  });
}
export function fastFeedObservations(raw: unknown,binding: { sourceId: string; generation: string; cursor: string; network: '42161' | '421614'; pools: Record<string,string> },receivedTimeNs: string): MarketObservation[] {
  const feed = record(raw), transaction = record(feed.transaction), receipt = record(transaction.receipt);
  if (binding.network !== '42161' || feed.version !== 1 || !Number.isSafeInteger(feed.timestamp_ms) || Number(feed.timestamp_ms) < 0 || !/^0x[0-9a-f]{64}$/.test(String(transaction.tx_hash)) || !Array.isArray(receipt.logs) || receipt.logs.length > 10000) throw new Error('L2_UNSUPPORTED_FAST_FEED');
  if (receipt.status !== '0x1' && receipt.status !== 1) return [];
  let cursor = uint(binding.cursor,64);
  return receipt.logs.flatMap((value,index) => {
    const log = record(value), poolId = binding.pools[String(log.address).toLowerCase()];
    if (!poolId) return [];
    if (typeof log.data !== 'string' || !Array.isArray(log.topics)) throw new Error('L2_INVALID_FEED_LOG');
    let trade;
    try { trade = decodePoolSwap(log.data as Hex,log.topics as [Hex,...Hex[]]); }
    catch { return []; } // Non-swap logs are not inferred from calldata.
    return [parseObservation({ schemaVersion: '1.0',eventId: `${transaction.tx_hash}:${index}`,sourceId: binding.sourceId,generation: binding.generation,cursor: (cursor++).toString(),poolId,identity: null,parentDigest: null,status: 'provisional',eventTimeNs: (BigInt(feed.timestamp_ms as number)*1000000n).toString(),receivedTimeNs,evidence: `fast-feed:${digest(feed)}`,payload: { kind: 'trade',...trade } })];
  });
}
const swaps = parseAbi([
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)'
]);
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)']);
/** Cetus clmm-interface pool::SwapEvent, pinned by the existing 1.2.0 profile.
 * Quantities are event-reported volume; fee_amount is not invented as extra flow.
 */
export const CETUS_L2_SWAP_BCS = bcs.struct('SwapEvent',{
  atob: bcs.bool(),pool: bcs.Address,partner: bcs.Address,amount_in: bcs.u64(),amount_out: bcs.u64(),ref_amount: bcs.u64(),fee_amount: bcs.u64(),vault_a_amount: bcs.u64(),vault_b_amount: bcs.u64(),before_sqrt_price: bcs.u128(),after_sqrt_price: bcs.u128(),steps: bcs.u64()
});
export function decodeCetusL2Swap(bytes: Uint8Array): { poolAddress: string; side: 'buy' | 'sell'; baseAtoms: string; quoteAtoms: string } {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 153) throw new Error('L2_INVALID_CETUS_SWAP_BCS');
  const event = CETUS_L2_SWAP_BCS.parse(bytes);
  if (!Buffer.from(CETUS_L2_SWAP_BCS.serialize(event).toBytes()).equals(Buffer.from(bytes)) || !uint(event.amount_in,64) || !uint(event.amount_out,64)) throw new Error('L2_INVALID_CETUS_SWAP_BCS');
  return { poolAddress: normalizeSuiAddress(event.pool),side: event.atob ? 'sell' : 'buy',baseAtoms: event.atob ? event.amount_in : event.amount_out,quoteAtoms: event.atob ? event.amount_out : event.amount_in };
}
export function secureEndpoint(raw: string,stream = false): string {
  const url = new URL(raw), local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || !(stream ? url.protocol === 'wss:' || (local && url.protocol === 'ws:') : url.protocol === 'https:' || (local && url.protocol === 'http:'))) throw new Error('L2_INSECURE_ENDPOINT');
  return raw;
}
export function decodePoolSwap(data: Hex,topics: [Hex,...Hex[]]): { side: 'buy' | 'sell'; baseAtoms: string; quoteAtoms: string } {
  const event = decodeEventLog({ abi: swaps,data,topics,strict: true });
  const a = event.args;
  let base: bigint, quote: bigint;
  if ('amount0' in a) { base = a.amount0; quote = a.amount1; }
  else { base = a.amount0In-a.amount0Out; quote = a.amount1In-a.amount1Out; }
  if (base === 0n || quote === 0n || (base > 0n) === (quote > 0n)) throw new Error('L2_UNSUPPORTED_SWAP_FLOW');
  return { side: base < 0n ? 'buy' : 'sell',baseAtoms: (base < 0n ? -base : base).toString(),quoteAtoms: (quote < 0n ? -quote : quote).toString() };
}
export interface ArbitrumL2Capture {
  rpcUrl: string; sourceId: string; generation: string; cursor: string; blockNumber: string;
  pools: AnalyticsPoolConfig[]; allowanceOwners: Address[]; routers: Address[];
}
export async function captureSuiL2(config: { rpcUrl: string; sourceId: string; generation: string; cursor: string; checkpoint: CheckpointObjectSet; configs: CetusDecodeConfig[] }): Promise<MarketObservation[]> {
  fields(record(config),['rpcUrl','sourceId','generation','cursor','checkpoint','configs']); secureEndpoint(config.rpcUrl);
  const captured = await readSuiCetusAnalyticsSnapshot(config.rpcUrl,config.sourceId,config.checkpoint,config.configs), identity = captured.snapshot.identity;
  if (identity.chain !== 'sui') throw new Error('L2_CHAIN_MISMATCH');
  const client = new SuiGrpcClient({ baseUrl: config.rpcUrl,network: identity.network });
  const committed = await readSuiCheckpoint(config.rpcUrl,identity.network,identity.height,config.checkpoint.chainIdentifier);
  const response = await client.ledgerService.getCheckpoint({ checkpointId: { oneofKind: 'sequenceNumber',sequenceNumber: BigInt(identity.height) },readMask: { paths: ['digest','summary.previous_digest','summary.timestamp','transactions.digest','transactions.effects.digest','transactions.effects.events_digest','transactions.events'] } },{ timeout: 15000 }).response;
  const cp = response.checkpoint, timestamp = cp?.summary?.timestamp;
  if (cp?.digest !== identity.checkpointDigest || timestamp === undefined || timestamp.seconds < 0n || timestamp.nanos < 0 || timestamp.nanos >= 1000000000) throw new Error('L2_CHECKPOINT_TIME_UNAVAILABLE');
  if (committed.checkpointDigest !== cp.digest || cp.transactions.length !== committed.committedTransactions.length) throw new Error('L2_INCOMPLETE_CHECKPOINT_EVENTS');
  const eventTimeNs = (timestamp.seconds*1000000000n+BigInt(timestamp.nanos)).toString(), receivedTimeNs = (BigInt(Date.now())*1000000n).toString(); let cursor = uint(config.cursor,64), eventCount = 0;
  const observations: MarketObservation[] = [];
  const add = (poolId: string,eventId: string,payload: MarketObservation['payload'],evidence: string) => observations.push(parseObservation({ schemaVersion: '1.0',sourceId: config.sourceId,generation: config.generation,cursor: (cursor++).toString(),poolId,identity,parentDigest: cp.summary?.previousDigest ?? null,eventId,status: 'checkpoint-certified',eventTimeNs,receivedTimeNs,evidence,payload }));
  for (const [txIndex,tx] of cp.transactions.entries()) {
    const expected = committed.committedTransactions[txIndex];
    if (tx.digest !== expected.digest || tx.effects?.digest !== expected.effectsDigest || (tx.effects.eventsDigest && tx.events?.digest !== tx.effects.eventsDigest)) throw new Error('L2_INCOMPLETE_CHECKPOINT_EVENTS');
    for (const [index,event] of (tx.events?.events ?? []).entries()) {
      if (++eventCount > 10000) throw new Error('L2_EVENT_LIMIT');
      const profile = config.configs.find(c => event.eventType === `${normalizeSuiAddress(c.typeOrigin)}::pool::SwapEvent`);
      if (!profile) continue;
      if (!event.contents?.value) throw new Error('L2_INCOMPLETE_CHECKPOINT_EVENTS');
      const decoded = decodeCetusL2Swap(event.contents.value), pool = captured.pools.find(p => normalizeSuiAddress(p.poolAddress) === decoded.poolAddress);
      if (!pool) continue;
      const { poolAddress: _,...trade } = decoded;
      add(pool.poolId,`${tx.digest}:${index}`,{ kind: 'trade',...trade },`sui-event:${cp.digest}:${tx.digest}:${index}:${digest(Array.from(event.contents.value))}`);
    }
  }
  for (const pool of captured.pools) add(pool.poolId,`${identity.height}:${pool.poolId}:state`,{ kind: 'pool',pool,flowComplete: true },`sui-state:${digest({ pool,refs: captured.stateRefs })}`);
  return observations;
}
/** Read-only capture. Logs and all state are checked against the same block hash.
 * Allowance probes explicitly cover a bounded declared owner/router set only.
 */
export async function captureArbitrumL2(config: ArbitrumL2Capture): Promise<MarketObservation[]> {
  fields(record(config),['rpcUrl','sourceId','generation','cursor','blockNumber','pools','allowanceOwners','routers']);
  secureEndpoint(config.rpcUrl); uint(config.cursor,64); uint(config.blockNumber,64); text(config.sourceId,128); text(config.generation,128);
  if (!Array.isArray(config.allowanceOwners) || !Array.isArray(config.routers) || config.allowanceOwners.length > 20 || config.routers.length > 10 || [...config.allowanceOwners,...config.routers].some(a => !/^0x[0-9a-f]{40}$/.test(a))) throw new Error('L2_ALLOWANCE_LIMIT');
  const captured = await readArbitrumAnalyticsSnapshot(config.rpcUrl,config.sourceId,config.cursor,config.pools,config.blockNumber);
  const client = createPublicClient({ transport: http(config.rpcUrl,{ timeout: 15000,retryCount: 0 }) });
  const block = await client.getBlock({ blockNumber: BigInt(config.blockNumber) });
  if (captured.snapshot.identity.chain === 'sui' || block.hash !== captured.snapshot.identity.blockHash) throw new Error('L2_BLOCK_DIVERGENCE');
  const observations: MarketObservation[] = []; let cursor = BigInt(config.cursor);
  const add = (poolId: string,eventId: string,payload: MarketObservation['payload'],evidence: string) => observations.push(parseObservation({ schemaVersion: '1.0',eventId,sourceId: config.sourceId,cursor: (cursor++).toString(),generation: config.generation,poolId,identity: captured.snapshot.identity,parentDigest: block.parentHash,status: 'node-confirmed',eventTimeNs: (block.timestamp*1000000000n).toString(),receivedTimeNs: (BigInt(Date.now())*1000000n).toString(),evidence,payload }));
  for (const pool of captured.pools) {
    let flowComplete = true;
    if (!['uniswap-v2','uniswap-v3'].includes(pool.state.protocol)) throw new Error('L2_UNSUPPORTED_LOG_ADAPTER');
    const logs = await client.getLogs({ address: pool.poolAddress as Address,events: swaps,fromBlock: block.number,toBlock: block.number,strict: true });
    if (logs.length > 10000) throw new Error('L2_LOG_LIMIT');
    for (const log of logs) {
      if (log.blockHash !== block.hash || log.transactionHash === null || log.logIndex === null || log.removed) throw new Error('L2_BLOCK_DIVERGENCE');
      try { add(pool.poolId,`${log.transactionHash}:${log.logIndex}`,{ kind: 'trade',...decodePoolSwap(log.data,log.topics as [Hex,...Hex[]]) },`evm:${block.hash}:${log.transactionHash}:${log.logIndex}`); }
      catch (error) { if (error instanceof Error && error.message === 'L2_UNSUPPORTED_SWAP_FLOW') flowComplete = false; else throw error; }
    }
    for (const owner of config.allowanceOwners) {
      const balance = await client.readContract({ address: pool.token0 as Address,abi: tokenAbi,functionName: 'balanceOf',args: [owner],blockNumber: block.number });
      for (const router of config.routers) {
        const allowance = await client.readContract({ address: pool.token0 as Address,abi: tokenAbi,functionName: 'allowance',args: [owner,router],blockNumber: block.number });
        add(pool.poolId,`${block.hash}:${pool.poolId}:${owner}:${router}`,{ kind: 'allowance',owner,router,balanceAtoms: balance.toString(),allowanceAtoms: allowance.toString() },`evm-view:${block.hash}:${digest({ owner,router,token: pool.token0 })}`);
      }
    }
    add(pool.poolId,`${block.hash}:${pool.poolId}:state`,{ kind: 'pool',pool,flowComplete },`evm-state:${block.hash}:${digest(pool)}:${digest(logs.map(l => ({ data: l.data,topics: l.topics })))}`);
  }
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('L2_BLOCK_DIVERGENCE');
  return observations;
}

export function decimalAtoms(value: unknown,decimals: number): string {
  if (typeof value !== 'string' || value.length > 256 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('L2_INVALID_MARKET_DECIMAL');
  const [whole,fraction = ''] = value.split('.');
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) throw new Error('L2_MARKET_PRECISION');
  return uint((BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.slice(0,decimals).padEnd(decimals,'0') || '0')).toString()).toString();
}
export class BinanceDepthBook {
  private update: bigint | null = null;
  private bids = new Map<string,string>(); private asks = new Map<string,string>();
  constructor(private readonly baseDecimals: number) {}
  snapshot(raw: unknown): void {
    const s = record(raw); fields(s,['lastUpdateId','bids','asks']);
    if (!Number.isSafeInteger(s.lastUpdateId) || Number(s.lastUpdateId) < 0) throw new Error('L2_UNSAFE_MARKET_SEQUENCE');
    this.bids.clear(); this.asks.clear(); this.update = null;
    this.set(s.bids,this.bids); this.set(s.asks,this.asks); this.update = BigInt(s.lastUpdateId as number);
  }
  apply(raw: unknown): 'applied' | 'duplicate' {
    const e = record(raw);
    if (![e.U,e.u].every(v => Number.isSafeInteger(v) && Number(v) >= 0) || BigInt(e.U as number) > BigInt(e.u as number)) throw new Error('L2_UNSAFE_MARKET_SEQUENCE');
    if (this.update === null) throw new Error('L2_BOOK_RESYNC_REQUIRED');
    if (BigInt(e.u as number) <= this.update) return 'duplicate';
    if (BigInt(e.U as number) > this.update+1n) { this.update = null; throw new Error('L2_BOOK_RESYNC_REQUIRED'); }
    const bids = new Map(this.bids), asks = new Map(this.asks);
    this.set(e.b,bids); this.set(e.a,asks); this.bids = bids; this.asks = asks; this.update = BigInt(e.u as number); return 'applied';
  }
  private set(raw: unknown,target: Map<string,string>): void {
    if (!Array.isArray(raw) || raw.length > 5000) throw new Error('L2_BOOK_LIMIT');
    for (const level of raw) {
      if (!Array.isArray(level) || level.length !== 2) throw new Error('L2_INVALID_MARKET_LEVEL');
      const price = decimalAtoms(level[0],9), quantity = decimalAtoms(level[1],this.baseDecimals);
      if (price === '0') throw new Error('L2_ZERO_MARKET_PRICE');
      if (quantity === '0') target.delete(price); else target.set(price,quantity);
    }
    if (target.size > 5000) { this.update = null; throw new Error('L2_BOOK_LIMIT'); }
  }
  book(): { bids: MarketLevel[]; asks: MarketLevel[]; complete: false } {
    if (this.update === null) throw new Error('L2_BOOK_RESYNC_REQUIRED');
    const levels = (map: Map<string,string>,bid: boolean) => [...map].sort((a,b) => BigInt(a[0]) < BigInt(b[0]) ? (bid ? 1 : -1) : (bid ? -1 : 1)).map(([price,quantity]) => ({ price,quantity }));
    return { bids: levels(this.bids,true),asks: levels(this.asks,false),complete: false };
  }
}
export function hyperliquidBook(raw: unknown,coin: string,baseDecimals: number): { bids: MarketLevel[]; asks: MarketLevel[]; complete: false; timeMs: number } {
  const data = record(raw);
  if (data.coin !== coin || !Array.isArray(data.levels) || data.levels.length !== 2 || !Number.isSafeInteger(data.time) || Number(data.time) < 0) throw new Error('L2_INVALID_HYPERLIQUID_BOOK');
  const side = (levels: unknown): MarketLevel[] => {
    if (!Array.isArray(levels) || levels.length > 20) throw new Error('L2_BOOK_LIMIT');
    return levels.map(v => { const level = record(v); return { price: decimalAtoms(level.px,9),quantity: decimalAtoms(level.sz,baseDecimals) }; });
  };
  return { bids: side(data.levels[0]),asks: side(data.levels[1]),complete: false,timeMs: data.time as number };
}

/** Native WebSocket transport (Node 22+ or an injected standards-compatible
 * implementation). Queue overflow closes rather than silently losing depth.
 */
export async function* streamMarketMessages(url: string,subscription: unknown,signal?: AbortSignal): AsyncGenerator<unknown> {
  secureEndpoint(url,true);
  if (typeof WebSocket === 'undefined') throw new Error('L2_NATIVE_WEBSOCKET_UNAVAILABLE');
  const socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
  const queue: unknown[] = []; let failure: Error | undefined, closed = false, wake: (() => void) | undefined;
  const abort = () => { closed = true; socket.close(); wake?.(); };
  const fail = (code: string) => { failure = new Error(code); abort(); };
  socket.addEventListener('open',() => { if (subscription !== null) for (const request of Array.isArray(subscription) ? subscription : [subscription]) socket.send(JSON.stringify(request)); });
  socket.addEventListener('message',event => {
    try {
      const bytes = typeof event.data === 'string' ? Buffer.from(event.data) : Buffer.from(event.data as ArrayBuffer);
      if (bytes.length > 4*1024*1024 || queue.length >= 1024) return fail('L2_STREAM_OVERFLOW');
      queue.push(JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(bytes))); wake?.();
    } catch { fail('L2_INVALID_STREAM_FRAME'); }
  });
  socket.addEventListener('error',() => fail('L2_STREAM_FAILED'));
  socket.addEventListener('close',() => { closed = true; wake?.(); });
  signal?.addEventListener('abort',abort,{ once: true });
  if (signal?.aborted) abort();
  try {
    while (!closed || queue.length) {
      if (failure) throw failure;
      if (queue.length) yield queue.shift(); else await new Promise<void>(resolve => { wake = resolve; });
    }
    if (failure) throw failure;
  } finally { abort(); signal?.removeEventListener('abort',abort); }
}

/** Continuous canonical EVM capture using the existing durable follower, with bounded catch-up. */
export async function* followEvmTriggerBlocks(config:Omit<ArbitrumL2Capture,'blockNumber'>,journal:import('./ingestion.js').SourceJournal,options:import('./ingestion.js').FollowSourceOptions):AsyncGenerator<import('./trigger-watcher.js').TriggerBlock>{
  const {followSource}=await import('./ingestion.js');
  if(config.pools.some(p=>p.protocol==='uniswap-v4'))throw new Error('UNSUPPORTED_WATCH_LIQUIDITY_EVENTS');
  const {evidenceIdentity}=await import('./entry-band.js');
  secureEndpoint(config.rpcUrl);
  const client=createPublicClient({transport:http(config.rpcUrl,{timeout:15000,retryCount:0})});
  const network=String(await client.getChainId());if(!['8453','42161','421614'].includes(network))throw new Error('UNSUPPORTED_WATCH_NETWORK');
  let emitted=0;
  while(!options.signal?.aborted&&emitted<options.maxFrames){
    let captured:import('./ingestion.js').SourceFrame|undefined;
    const result=await followSource(journal,{...options,maxFrames:1},async()=>String(await client.getBlockNumber({cacheTime:0})),async height=>{
      if(options.signal?.aborted)throw new Error('WATCH_CANCELLED');
      const prior=await journal.latest();
      if(prior?.identity.height===height&&prior.identity.chain!=='sui'){
        const header=await client.getBlock({blockNumber:BigInt(height)});if(header.hash===prior.identity.blockHash)return {identity:prior.identity,parentDigest:prior.parentDigest,payload:prior.payload};
      }
      const observations=await captureArbitrumL2({...config,blockNumber:height});
      const state=observations.find(o=>o.payload.kind==='pool');if(!state?.identity)throw new Error('WATCH_STATE_UNAVAILABLE');
      const liquidityEvents:string[]=[];
      for(const pool of config.pools){const events=pool.protocol==='uniswap-v2'?parseAbi(['event Mint(address indexed sender,uint256 amount0,uint256 amount1)','event Burn(address indexed sender,uint256 amount0,uint256 amount1,address indexed to)']):parseAbi(['event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)','event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)']);
        const logs=await client.getLogs({address:pool.address,events,fromBlock:BigInt(height),toBlock:BigInt(height)});if(logs.length>10000)throw new Error('L2_LOG_LIMIT');
        for(const log of logs){if(log.blockHash!==(state.identity.chain==='sui'?'':state.identity.blockHash)||log.removed)throw new Error('L2_BLOCK_DIVERGENCE');liquidityEvents.push(`${log.blockHash}:${log.transactionHash}:${log.logIndex}`);}
      }
      if((await client.getBlock({blockNumber:BigInt(height)})).hash!==(state.identity.chain==='sui'?'':state.identity.blockHash))throw new Error('L2_BLOCK_DIVERGENCE');
      return {identity:state.identity,parentDigest:state.parentDigest,payload:{observations,liquidityEvents}};
    },async frame=>{captured=frame;});
    if(!captured){if(result.status!=='frame-limit')return;continue;}
    const payload=captured.payload as {observations?:MarketObservation[];liquidityEvents?:string[]};
    const observations=Array.isArray(captured.payload)?captured.payload as MarketObservation[]:payload.observations;if(!observations)throw new Error('INVALID_WATCH_FRAME');
    const pools=observations.flatMap(o=>o.payload.kind==='pool'?[o.payload.pool]:[]);
    if(!pools.length)throw new Error('WATCH_STATE_UNAVAILABLE');
    const base=[pools[0].token0,pools[0].token1].sort()[0];
    const swaps=observations.flatMap(o=>{
      if(o.payload.kind!=='trade')return [];const pool=pools.find(p=>p.poolId===o.poolId);if(!pool)throw new Error('WATCH_POOL_MISMATCH');
      const index=o.eventId.lastIndexOf(':'),transactionId=o.eventId.slice(0,index),logIndex=Number(o.eventId.slice(index+1));
      if(!/^0x[a-f0-9]{64}$/.test(transactionId)||!Number.isSafeInteger(logIndex)||logIndex<0)throw new Error('WATCH_EVENT_ID_INVALID');
      const tokenIn=o.payload.side==='sell'?pool.token0:pool.token1;
      return [{transactionId,logIndex,poolId:o.poolId,direction:tokenIn===base?'sell-base' as const:'buy-base' as const,amountInRaw:o.payload.side==='sell'?o.payload.baseAtoms:o.payload.quoteAtoms,observedAtNs:o.receivedTimeNs,inclusionToObservationMs:null}];
    });
    emitted++;yield {state:evidenceIdentity(pools[0]),parentHash:captured.parentDigest??'',pools,swaps,liquidityEvents:payload.liquidityEvents??[]};
  }
}
