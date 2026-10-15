import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, appendFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { toBase58 } from '@mysten/sui/utils';
import { encodeEventTopics, encodeAbiParameters, parseAbi, encodeFunctionResult, keccak256 } from 'viem';
import { digest } from '../liquidity/state.js';
import { parseObservation, parseFrame, type MarketObservation, type MicrostructureFrame } from '../liquidity/l2-contracts.js';
import { buildMicrostructureFrame, executableDepth } from '../liquidity/l2-metrics.js';
import { EvidenceJournal, L2ContextEngine, materializeFrames, replayEvidence } from '../liquidity/l2-ingestion.js';
import { BinanceDepthBook, decimalAtoms, hyperliquidBook, decodePoolSwap, fastFeedObservations, secureEndpoint } from '../liquidity/l2-sources.js';
import { L2AgentServer, serveL2Stdio } from '../liquidity/l2-agent.js';
import { L2RiskJournal, runL2Candidates, validatedPrediction } from '../liquidity/l2-execution.js';
import { evaluateL2, predictL2, trainL2Model, forwardOutcome, type TrainingExample } from '../liquidity/l2-prediction.js';
import { LiquidityRuntime, type RouteCandidate } from '../liquidity/runtime.js';
import type { PoolStateEnvelope } from '../liquidity/projection.js';
import { SnapshotStore } from '../liquidity/state.js';
import { AttemptJournal } from '../liquidity/journal.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { retainL2Segments } from '../liquidity/l2-storage.js';
import { CETUS_L2_SWAP_BCS, decodeCetusL2Swap, captureArbitrumL2 } from '../liquidity/l2-sources.js';

const token0 = `0x${'1'.repeat(40)}`, token1 = `0x${'2'.repeat(40)}`, poolId = `arbitrum:42161:0x${'3'.repeat(40)}`;
const HOUR = 3600000000000n, DAY = 24n*HOUR, time = 1792032180000000000n;
function pool(height = '2'): PoolStateEnvelope {
  return { schemaVersion: '4.0',identity: { chain: 'arbitrum',network: '42161',height,blockHash: `0x${BigInt(height).toString(16).padStart(64,'0')}` },poolId,poolAddress: `0x${'3'.repeat(40)}`,adapterRevision: 'independent-v2',revisionHash: `0x${'4'.repeat(64)}`,token0,token1,decimals0: 6,decimals1: 6,stateClass: 'canonical',appliedOperations: [],state: { protocol: 'uniswap-v2',reserve0: '1000000000',reserve1: '1000000000',feeNumerator: '1',feeDenominator: '1' } };
}
function observation(at = time,height = '2',cursor = '2'): MarketObservation {
  const p = pool(height);
  return parseObservation({ schemaVersion: '1.0',eventId: `state-${height}`,sourceId: 'fixture',cursor,generation: 'generation-1',poolId,identity: p.identity,parentDigest: `0x${(BigInt(height)-1n).toString(16).padStart(64,'0')}`,status: 'node-confirmed',eventTimeNs: at.toString(),receivedTimeNs: at.toString(),evidence: `fixture:${height}`,payload: { kind: 'pool',pool: p,flowComplete: true } });
}
function frame(at = time): MicrostructureFrame {
  return buildMicrostructureFrame(observation(at),[observation(at-HOUR,'1','1')]);
}
function rehash(f: MicrostructureFrame): MicrostructureFrame {
  const { frameId: _,...body } = f; return { ...body,frameId: digest(body) };
}
const seam = (edge: string,marker: string) => console.log(JSON.stringify({ edgeId: edge,marker,scope: 'local-protocol-and-runtime',status: 'passed' }));
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of items) result.push(item); return result; }

test('EDGE-01 evidence journal rejects gaps, substitution, corruption and torn writes; replay is idempotent',async () => {
  const dir = await mkdtemp(join(tmpdir(),'l2-journal-'));
  try {
    const journal = new EvidenceJournal(join(dir,'raw.jsonl')), first = observation(time-HOUR,'1','1'), last = observation();
    await journal.append(first); await journal.append(last);
    assert.equal(await journal.append(last),'duplicate');
    await assert.rejects(journal.append({ ...last,eventId: 'other',cursor: '4' }),/SOURCE_GAP/);
    await assert.rejects(journal.append({ ...last,evidence: 'substituted' }),/EVENT_SUBSTITUTION/);
    const engine = await replayEvidence(journal); assert.equal(engine.snapshot().length,1);
    assert.equal(engine.apply(last),null);
    assert.throws(() => engine.apply(observation(time-1n,'3','3')),/NON_MONOTONIC/);
    const output = join(dir,'frames.jsonl');
    assert.equal((await materializeFrames(journal,output)).frames,2);
    const bytes = await readFile(output,'utf8');
    assert.equal((await materializeFrames(journal,output)).frames,0); assert.equal(await readFile(output,'utf8'),bytes);
    await appendFile(journal.path,'{'); await assert.rejects(replayEvidence(journal),/TORN_WRITE/);
    seam('EDGE-01','l2_source_recovered_or_rejected');
  } finally { await rm(dir,{ recursive: true,force: true }); }
});
test('EDGE-01 loopback RPC capture and actual follow/replay CLI preserve successful swap provenance',async () => {
  const dir = await mkdtemp(join(tmpdir(),'l2-rpc-')), p = pool('1'), hash = p.identity.chain === 'arbitrum' ? p.identity.blockHash : '';
  const abi = parseAbi(['function token0() view returns(address)','function token1() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function decimals() view returns(uint8)']);
  const swapAbi = parseAbi(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
  const topics = encodeEventTopics({ abi: swapAbi,eventName: 'Swap',args: { sender: token0 as `0x${string}`,to: token1 as `0x${string}` } });
  const data = encodeAbiParameters([{ type: 'uint256' },{ type: 'uint256' },{ type: 'uint256' },{ type: 'uint256' }],[100n,0n,0n,99n]);
  const server = createServer(async (request,response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const handle = (rpc: { id: number; method: string; params: unknown[] }) => {
      let result: unknown;
      if (rpc.method === 'eth_chainId') result = '0xa4b1';
      else if (rpc.method === 'eth_getBlockByNumber') result = { number: '0x1',hash,parentHash: `0x${'0'.repeat(64)}`,timestamp: `0x${Math.floor(Date.now()/1000).toString(16)}`,transactions: [] };
      else if (rpc.method === 'eth_getCode') result = '0x6000';
      else if (rpc.method === 'eth_getLogs') result = [{ address: p.poolAddress,blockHash: hash,blockNumber: '0x1',transactionHash: `0x${'a'.repeat(64)}`,transactionIndex: '0x0',logIndex: '0x0',removed: false,topics,data }];
      else if (rpc.method === 'eth_call') {
        const call = rpc.params[0] as { data: string };
        result = call.data === '0x0dfe1681' ? encodeFunctionResult({ abi,functionName: 'token0',result: token0 as `0x${string}` }) : call.data === '0xd21220a7' ? encodeFunctionResult({ abi,functionName: 'token1',result: token1 as `0x${string}` }) : call.data === '0x313ce567' ? encodeFunctionResult({ abi,functionName: 'decimals',result: 6 }) : encodeFunctionResult({ abi,functionName: 'getReserves',result: [1000000000n,1000000000n,1] });
      } else return { jsonrpc: '2.0',id: rpc.id,error: { code: -32601,message: 'unsupported fixture method' } };
      return { jsonrpc: '2.0',id: rpc.id,result };
    };
    const rpc = JSON.parse(raw); response.setHeader('content-type','application/json'); response.end(JSON.stringify(Array.isArray(rpc) ? rpc.map(handle) : handle(rpc)));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const capture = { rpcUrl: `http://127.0.0.1:${address.port}`,sourceId: 'rpc-fixture',generation: 'g',cursor: '1',blockNumber: '1',pools: [{ address: p.poolAddress as `0x${string}`,expectedCodeHash: keccak256('0x6000'),protocol: 'uniswap-v2' as const,adapterRevision: 'fixture',feeNumerator: '997',feeDenominator: '1000' }],allowanceOwners: [],routers: [] };
    const observed = await captureArbitrumL2(capture); assert.equal(observed.length,2); assert.equal(observed[0].payload.kind,'trade'); assert.equal(observed[1].parentDigest,`0x${'0'.repeat(64)}`);
    const configPath = join(dir,'follow.json'), journalPath = join(dir,'raw.jsonl'), outputPath = join(dir,'derived.jsonl');
    await writeFile(configPath,JSON.stringify({ schemaVersion: '1.0',journalPath,outputPath,source: { kind: 'arbitrum',capture } }));
    const follow = await promisify(execFile)(process.execPath,['dist/liquidity/cli.js','l2-follow',configPath]); assert.equal(JSON.parse(follow.stdout).frames,1);
    const replayPath = join(dir,'replay.json'); await writeFile(replayPath,JSON.stringify({ schemaVersion: '1.0',journalPath,outputPath }));
    const replay = await promisify(execFile)(process.execPath,['dist/liquidity/cli.js','l2-replay',replayPath]); assert.equal(JSON.parse(replay.stdout).frames,0);
    const engine = await replayEvidence(new EvidenceJournal(journalPath)); assert.equal(engine.snapshot()[0].metrics.volume1hQuoteAtoms,'99');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir,{ recursive: true,force: true }); }
});
test('generation invalidation removes frames and rejects old state, provisional trades never become canonical flow',() => {
  const engine = new L2ContextEngine(); const old = observation(); engine.apply(old);
  engine.apply({ ...old,eventId: 'provisional',identity: null,parentDigest: null,status: 'provisional',payload: { kind: 'trade',side: 'sell',baseAtoms: '100',quoteAtoms: '100' } });
  assert.equal(engine.snapshot()[0].metrics.tradeCount,0);
  assert.throws(() => engine.apply({ ...old,eventId: 'replacement',generation: 'new' }),/INVALIDATION_REQUIRED/);
  engine.apply({ ...old,eventId: 'invalidate',payload: { kind: 'invalidate',generation: old.generation,reason: 'same-height-reorg' } });
  assert.equal(engine.snapshot().length,0); assert.throws(() => engine.apply(old),/INVALIDATED_GENERATION/);
  engine.apply({ ...old,generation: 'new' }); assert.equal(engine.snapshot()[0].generation,'new');
});
test('reorg evidence halts the old generation and a replacement snapshot remains replayable',async () => {
  const dir = await mkdtemp(join(tmpdir(),'l2-reorg-'));
  try {
    const journal = new EvidenceJournal(join(dir,'raw.jsonl'));
    await journal.append(observation(time-HOUR,'1','1')); await journal.append(observation());
    const bad = { ...observation(time+1n,'3','3'),parentDigest: `0x${'f'.repeat(64)}` };
    await journal.append(bad);
    const halted = await replayEvidence(journal); assert.equal(halted.snapshot().length,0); assert.equal(halted.diagnostics()[poolId],'L2_PARENT_DIVERGENCE');
    await journal.append({ ...observation(time+2n,'4','1'),generation: 'replacement' });
    const recovered = await replayEvidence(journal); assert.equal(recovered.snapshot()[0].generation,'replacement'); assert.equal(recovered.snapshot()[0].quality.complete,false);
    assert.equal((await materializeFrames(journal,join(dir,'derived.jsonl'))).rejected,1);
  } finally { await rm(dir,{ recursive: true,force: true }); }
});
test('incremental tails verify only new records, detect full-row corruption, and resume a materialized prefix',async () => {
  const dir = await mkdtemp(join(tmpdir(),'l2-tail-'));
  try {
    const journal = new EvidenceJournal(join(dir,'raw.jsonl')), reader = journal.reader(), output = join(dir,'out.jsonl');
    await journal.append(observation(time-HOUR,'1','1'));
    assert.equal((await collect(reader.read())).length,1);
    assert.equal((await collect(reader.read())).length,0);
    await materializeFrames(journal,output);
    await new EvidenceJournal(journal.path).append(observation());
    assert.equal((await collect(reader.read())).length,1); assert.equal(reader.count,2);
    assert.equal((await materializeFrames(journal,output)).frames,1); assert.equal((await materializeFrames(journal,output)).frames,0);
    const complete = (await readFile(journal.path,'utf8')).trim().split('\n');
    const changed = JSON.parse(complete[0]); changed.observation.evidence = 'tampered-complete-row'; complete[0] = JSON.stringify(changed);
    await writeFile(journal.path,complete.join('\n')+'\n'); await assert.rejects(replayEvidence(new EvidenceJournal(journal.path)),/DIVERGENCE/);
  } finally { await rm(dir,{ recursive: true,force: true }); }
});
test('dedup retention is bounded by active history and does not exhaust across invalidated generations',() => {
  const engine = new L2ContextEngine(1,2);
  for (let i = 0; i < 5; i++) {
    const o = { ...observation(time+BigInt(i)*HOUR),generation: `generation-${i}` };
    engine.apply(o); engine.apply({ ...o,eventId: `invalidate-${i}`,payload: { kind: 'invalidate',generation: o.generation,reason: 'rotation' } });
  }
  assert.equal(engine.snapshot().length,0);
});
test('EDGE-02 exact V2 and CLMM depth use independent bounds; allowance capacity cannot double count owners',() => {
  const p = pool(), depth = executableDepth(p,200,'bid');
  const input = BigInt(depth.inputAtoms.value!);
  // Independent constant-product endpoint with no fee: y' / x' <= 0.98.
  const reaches = (amount: bigint) => { const y = 1000000000n-1000000000n*amount/(1000000000n+amount); return y*100n <= (1000000000n+amount)*98n; };
  assert.ok(reaches(input)); assert.equal(reaches(input-1n),false);
  assert.ok(Number(input) > 10152000 && Number(input) < 10153000);
  const v3: PoolStateEnvelope = { ...p,state: { protocol: 'uniswap-v3',sqrtPriceX96: '79228162514264337593543950336',tick: 0,liquidity: '1000000000000',feePips: 3000,tickSpacing: 1,unlocked: true,bitmapWords: [-1,0].map(wordPosition => ({ wordPosition,bitmap: '0' })),initializedTicks: [],lowerTick: -200,upperTick: 200 } };
  assert.notEqual(executableDepth(v3,100,'bid').inputAtoms.value,null);
  assert.equal(executableDepth(v3,500,'bid').inputAtoms.value,null);
  const now = observation(), owner = `0x${'5'.repeat(40)}`;
  const allowances = [token0,token1].map((router,i) => parseObservation({ ...now,eventId: `allow-${i}`,payload: { kind: 'allowance',owner,router,balanceAtoms: '1000',allowanceAtoms: ((1n<<256n)-1n).toString() } }));
  const f = buildMicrostructureFrame(now,[observation(time-HOUR,'1','1'),...allowances]);
  assert.equal(f.metrics.allowanceCapacityQuoteAtoms.value,'1000'); assert.equal(parseFrame(f).frameId,f.frameId);
  assert.throws(() => parseFrame({ ...f,receivedTimeNs: Number(time) }),/INVALID_FRAME/);
  assert.throws(() => parseObservation({ ...now,eventTimeNs: (time+1n).toString() }),/FUTURE/);
  seam('EDGE-02','l2_math_units_and_coverage_proven');
});
test('Cetus X64 and DeepBook price scaling remain separate from V3 Q96',() => {
  const suiDigest = toBase58(new Uint8Array(32).fill(7));
  const identity = { chain: 'sui' as const,network: 'mainnet' as const,height: '2',checkpointDigest: suiDigest };
  const p: PoolStateEnvelope = { ...pool(),identity,poolId: 'sui:mainnet:cetus',poolAddress: `0x${'3'.repeat(64)}`,revisionHash: suiDigest,token0: `0x${'0'.repeat(63)}2::sui::SUI`,token1: `0x${'0'.repeat(63)}3::coin::COIN`,state: { protocol: 'cetus',sqrtPriceX64: '18446744073709551616',tick: 0,liquidity: '1000000000000',feePips: 3000,tickSpacing: 1,lowerTick: -600,upperTick: 600,complete: true,initializedTicks: [] } };
  assert.notEqual(executableDepth(p,200,'ask').inputAtoms.value,null);
  const book = { schemaVersion: '4.0' as const,revision: 'deepbook-v3-input-fee' as const,packageDigest: suiDigest,checkpointDigest: suiDigest,lotSize: '1',minSize: '1',tickSize: '1',takerFee: '1000000',timestampMs: (time/1000000n).toString(),complete: true,bids: [{ orderId: '1',price: '999000000',remainingBase: '1000000',expiresAtMs: (time/1000000n+10000n).toString() }],asks: [{ orderId: '2',price: '1001000000',remainingBase: '2000000',expiresAtMs: (time/1000000n+10000n).toString() }] };
  const o = parseObservation({ ...observation(),poolId: 'sui:mainnet:deepbook',identity,parentDigest: suiDigest,status: 'checkpoint-certified',payload: { kind: 'deepbook',book,baseAsset: p.token0,quoteAsset: p.token1,decimalsBase: 6,decimalsQuote: 6,flowComplete: true } });
  const f = buildMicrostructureFrame(o,[]); assert.deepEqual(f.metrics.spot,{ numerator: '1',denominator: '1' }); assert.equal(f.metrics.turnover1h.value,null);
});
test('Cetus event decoder preserves native reported amounts and rejects trailing or malformed BCS',() => {
  const bytes = CETUS_L2_SWAP_BCS.serialize({ atob: true,pool: `0x${'3'.repeat(64)}`,partner: `0x${'0'.repeat(64)}`,amount_in: '123',amount_out: '456',ref_amount: '0',fee_amount: '1',vault_a_amount: '1000',vault_b_amount: '1000',before_sqrt_price: '18446744073709551616',after_sqrt_price: '18446744073709551615',steps: '1' }).toBytes();
  assert.equal(bytes.length,153); assert.deepEqual(decodeCetusL2Swap(bytes),{ poolAddress: `0x${'3'.repeat(64)}`,side: 'sell',baseAtoms: '123',quoteAtoms: '456' });
  assert.throws(() => decodeCetusL2Swap(Buffer.concat([bytes,Buffer.from([0])])),/INVALID_CETUS/);
});
test('closed-segment retention honors pins, hashes, dry-run and exact raw/derived retention windows',async () => {
  const dir = await mkdtemp(join(tmpdir(),'l2-retain-'));
  try {
    const bytes = '{}\n', hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(dir,'raw.jsonl'),bytes); await writeFile(join(dir,'derived.jsonl'),bytes);
    const segments = [{ fileName: 'raw.jsonl',kind: 'raw' as const,createdTimeNs: (time-8n*DAY).toString(),sha256: hash },{ fileName: 'derived.jsonl',kind: 'derived' as const,createdTimeNs: (time-8n*DAY).toString(),sha256: hash }];
    assert.deepEqual((await retainL2Segments(dir,segments,[],time.toString())).expired,['raw.jsonl']);
    assert.equal(await readFile(join(dir,'raw.jsonl'),'utf8'),bytes);
    assert.equal((await retainL2Segments(dir,segments,[hash],time.toString(),false)).expired.length,0);
    await retainL2Segments(dir,segments,[],time.toString(),false);
    await assert.rejects(readFile(join(dir,'raw.jsonl'))); assert.equal(await readFile(join(dir,'derived.jsonl'),'utf8'),bytes);
  } finally { await rm(dir,{ recursive: true,force: true }); }
});
test('market depth handles Binance sequence gaps, exact decimal precision and Hyperliquid snapshots',() => {
  const book = new BinanceDepthBook(6); book.snapshot({ lastUpdateId: 10,bids: [['1','2']],asks: [['2','3']] });
  assert.equal(book.apply({ U: 9,u: 10,b: [],a: [] }),'duplicate');
  book.apply({ U: 11,u: 12,b: [['1','0'],['0.9','1']],a: [] }); assert.equal(book.book().bids[0].price,'900000000');
  assert.throws(() => book.apply({ U: 14,u: 14,b: [],a: [] }),/RESYNC/); assert.throws(() => book.book(),/RESYNC/);
  assert.equal(decimalAtoms('1.000001',6),'1000001'); assert.throws(() => decimalAtoms('1.0000001',6),/PRECISION/);
  const snapshot = hyperliquidBook({ coin: 'SUI',time: 1000,levels: [[{ px: '1',sz: '2' }],[{ px: '2',sz: '3' }]] },'SUI',9);
  assert.equal(snapshot.bids[0].quantity,'2000000000'); assert.equal(snapshot.complete,false);
  assert.throws(() => secureEndpoint('http://example.com'),/INSECURE/);
});
test('external basis requires matching asset bindings and fresh causal observations',() => {
  const o = observation();
  const market = parseObservation({ ...o,eventId: 'market',sourceId: 'external',identity: null,parentDigest: null,status: 'external',payload: { kind: 'market-book',venue: 'binance',baseAsset: token0,quoteAsset: token1,bids: [{ price: '1099000000',quantity: '1000000' }],asks: [{ price: '1101000000',quantity: '1000000' }],complete: false } });
  const f = buildMicrostructureFrame(o,[market]); assert.deepEqual(f.metrics.marketBasis.value,{ numerator: '200000000',denominator: '2000000000' });
  assert.equal(buildMicrostructureFrame(o,[{ ...market,payload: { ...market.payload,...{ quoteAsset: 'wrong' } } } as MarketObservation]).metrics.marketBasis.value,null);
  assert.equal(buildMicrostructureFrame(o,[{ ...market,eventTimeNs: (time-3000000000n).toString(),receivedTimeNs: (time-3000000000n).toString() }]).metrics.marketBasis.value,null);
});
test('public JSON Schema and runtime validators agree on observation/frame boundaries',async () => {
  const schema = JSON.parse(await readFile('schemas/level-2.schema.json','utf8'));
  const analytics = JSON.parse(await readFile('schemas/liquidity-analytics.schema.json','utf8'));
  const validate = new Ajv2020({ strict: true,allErrors: true }).addSchema(analytics,'liquidity-analytics.schema.json').compile(schema);
  for (const value of [observation(),frame()]) {
    assert.equal(validate(value),true,JSON.stringify(validate.errors));
    assert.equal(validate({ ...value,unknown: true }),false);
  }
  assert.equal(validate({ ...observation(),receivedTimeNs: Number(time) }),false);
});
test('receipt swap normalization uses signed asset flow and Fast Feed stays provisional',() => {
  const abi = parseAbi(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)']);
  const topics = encodeEventTopics({ abi,eventName: 'Swap',args: { sender: token0 as `0x${string}`,recipient: token1 as `0x${string}` } }) as [`0x${string}`,...`0x${string}`[]];
  const data = encodeAbiParameters([{ type: 'int256' },{ type: 'int256' },{ type: 'uint160' },{ type: 'uint128' },{ type: 'int24' }],[-100n,120n,1n,1n,0]);
  assert.deepEqual(decodePoolSwap(data,topics),{ side: 'buy',baseAtoms: '100',quoteAtoms: '120' });
  const observations = fastFeedObservations({ version: 1,timestamp_ms: Number(time/1000000n),transaction: { tx_hash: `0x${'a'.repeat(64)}`,receipt: { status: '0x1',logs: [{ address: pool().poolAddress,data,topics }] } } },{ sourceId: 'fast',generation: 'g',cursor: '1',network: '42161',pools: { [pool().poolAddress]: poolId } },time.toString());
  assert.equal(observations.length,1); assert.equal(observations[0].status,'provisional'); assert.equal(observations[0].identity,null);
});

test('EDGE-03 MCP handshake, freshness, strict arguments and real CLI subprocess preserve protocol framing',async () => {
  const now = BigInt(Date.now())*1000000n, dir = await mkdtemp(join(tmpdir(),'l2-mcp-'));
  try {
    const journal = new EvidenceJournal(join(dir,'raw.jsonl'));
    await journal.append(observation(now-HOUR,'1','1')); await journal.append(observation(now));
    const engine = await replayEvidence(journal), server = new L2AgentServer(engine,() => now.toString());
    const initialize = { jsonrpc: '2.0',id: 1,method: 'initialize',params: { protocolVersion: '2025-11-25',capabilities: {},clientInfo: { name: 'test',version: '1' } } };
    assert.ok(JSON.stringify(await server.handle({ jsonrpc: '2.0',id: 0,method: 'tools/list' })).includes('NOT_INITIALIZED'));
    await server.handle(initialize); await server.handle({ jsonrpc: '2.0',method: 'notifications/initialized' });
    const inspect = { jsonrpc: '2.0',id: 2,method: 'tools/call',params: { name: 'l2_inspect_pool_microstructure',arguments: { pool_id: poolId } } };
    assert.ok(JSON.stringify(await server.handle(inspect)).includes('frameId'));
    assert.ok(JSON.stringify(await server.handle({ ...inspect,params: { ...inspect.params,arguments: { pool_id: poolId,send: true } } })).includes('isError":true'));
    assert.throws(() => engine.inspect(poolId,(now+3000000000n).toString()),/STALE/);
    const uri = `l2://arbitrum/${engine.snapshot()[0].identity.network}/pool/${encodeURIComponent(poolId)}/state`;
    await server.handle({ jsonrpc: '2.0',id: 8,method: 'resources/subscribe',params: { uri } });
    const nextObservation = observation(now+1n,'3','3');
    engine.apply(nextObservation);
    assert.equal(server.replaceEngine(engine).length,1,'same-engine mutation must notify subscribed resources');
    assert.equal(server.replaceEngine(engine).length,0,'unchanged frame must not notify twice');
    const config = join(dir,'config.json'); await writeFile(config,JSON.stringify({ schemaVersion: '1.0',journalPath: journal.path }));
    const input = [initialize,{ jsonrpc: '2.0',method: 'notifications/initialized' },{ jsonrpc: '2.0',id: 2,method: 'tools/list' }].map(value => JSON.stringify(value)).join('\n')+'\n';
    const result = spawnSync(process.execPath,['dist/liquidity/cli.js','l2-serve',config],{ input,encoding: 'utf8',timeout: 15000 });
    assert.equal(result.status,0,result.stderr); const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line)); assert.equal(messages.length,2); assert.equal(messages[1].result.tools.length,3);
    const output: string[] = []; await serveL2Stdio(server,(async function*() { yield Buffer.from('{bad}\n'); })(),async line => { output.push(line); });
    assert.equal(JSON.parse(output[0]).error.code,-32700);
    seam('EDGE-03','l2_agent_contract_and_causality_proven');
  } finally { await rm(dir,{ recursive: true,force: true }); }
});
test('chronological training rejects outcome substitution and temporal leakage; insufficient evidence cannot promote',() => {
  const template = frame(), examples: TrainingExample[] = [];
  for (let day = 0; day <= 42; day++) for (let j = 0; j < 3; j++) {
    const at = time+BigInt(day)*DAY+BigInt(j)*HOUR, y = j-1;
    let f = structuredClone(template); f.receivedTimeNs = at.toString(); f.identity.height = String(day*3+j+2); f.quality.windowEndNs = at.toString(); f.quality.windowStartNs = (at-HOUR).toString(); f.metrics.skew2pct = { value: { numerator: String(y),denominator: '1' },reason: null }; f = rehash(f);
    examples.push({ frame: f,outcome: { schemaVersion: '1.0',predictionId: digest([day,j]),frameId: f.frameId,cutoffNs: f.receivedTimeNs,observedTimeNs: (at+60000000000n).toString(),horizon: '1m',identity: { ...f.identity,height: String(day*3+j+3) },price: { numerator: String(10000+y*100),denominator: '10000' },markoutBps: y*100,netValueAtoms: null,baselineNetValueAtoms: null,evidence: 'independent-future-fixture' },shadowEvidence: null });
  }
  const model = trainL2Model(examples.slice(0,20),'arbitrum','1m');
  assert.throws(() => predictL2(model,examples[0].frame),/LEAKING_MODEL/);
  const prediction = predictL2(model,examples.at(-1)!.frame); assert.equal(prediction.admission,'research'); assert.ok(Math.abs(prediction.probabilities.reduce((a,b) => a+b,0)-1) < 1e-12);
  const { report } = evaluateL2(examples,'arbitrum','1m'); assert.equal(report.admitted,false); assert.ok(report.reasons.includes('NO_INDEPENDENT_NET_BENEFIT'));
  assert.throws(() => validatedPrediction(prediction,report,report.reportId),/UNADMITTED/);
  const bad = structuredClone(examples); bad[0].outcome.markoutBps = 999;
  assert.throws(() => trainL2Model(bad,'arbitrum','1m'),/SUBSTITUTION/);
  assert.equal(forwardOutcome(prediction,examples.at(-1)!.frame,[]),null);
});
test('positive synthetic holdout proves promotion wiring, purge and calibration availability without claiming market alpha',async () => {
  const template = frame(), examples: TrainingExample[] = [];
  for (let day = 0; day <= 42; day++) for (let j = 0; j < 30; j++) {
    const at = day === 13 && j === 29 ? time+14n*DAY-10000000000n : time+BigInt(day)*DAY+BigInt(j)*600000000000n, y = j%3-1;
    let f = structuredClone(template); f.receivedTimeNs = at.toString(); f.identity.height = String(day*30+j+2); f.quality.windowEndNs = at.toString(); f.quality.windowStartNs = (at-HOUR).toString(); f.metrics.skew2pct = { value: { numerator: '0',denominator: '1' },reason: null }; f.metrics.printDecay = { value: { numerator: String(y+1),denominator: '1' },reason: null }; f.metrics.printCounts = { recent: 3,baseline: 3 }; f.metrics.tradeCount = 6; f = rehash(f);
    examples.push({ frame: f,outcome: { schemaVersion: '1.0',predictionId: digest([day,j]),frameId: f.frameId,cutoffNs: f.receivedTimeNs,observedTimeNs: (at+60000000000n).toString(),horizon: '1m',identity: { ...f.identity,height: String(day*30+j+3) },price: { numerator: String(10000+y*100),denominator: '10000' },markoutBps: y*100,netValueAtoms: '2',baselineNetValueAtoms: '1',evidence: 'synthetic-outcome-not-production' },shadowEvidence: { source: 'shadow-runtime',candidateDigest: digest(['candidate',day,j]),baselineCandidateDigest: digest(['baseline',day,j]),profitAsset: 'arbitrum:42161:USDC' } });
  }
  const { model,report } = evaluateL2(examples,'arbitrum','1m');
  assert.equal(report.folds[0].train,419); // One outcome crosses the training boundary.
  assert.equal(report.admitted,true,JSON.stringify(report.reasons));
  assert.throws(() => predictL2(model,examples[30*30].frame),/LEAKING_MODEL/); // Within consumed calibration.
  const prediction = predictL2(model,examples.at(-1)!.frame);
  assert.equal(validatedPrediction(prediction,report,report.reportId).admission,'validated');
  assert.throws(() => validatedPrediction(prediction,{ ...report,netImprovement95: [0,0] },report.reportId),/UNADMITTED/);
  assert.throws(() => validatedPrediction(prediction,report,digest('wrong-pin')),/UNADMITTED/);
  const changedTest = structuredClone(examples);
  for (const e of changedTest) if (BigInt(e.frame.receivedTimeNs) >= time+35n*DAY) { e.outcome.markoutBps = -e.outcome.markoutBps; e.outcome.price.numerator = String(10000+e.outcome.markoutBps); }
  assert.equal(evaluateL2(changedTest,'arbitrum','1m').model.modelId,model.modelId);
  const schema = JSON.parse(await readFile('schemas/level-2.schema.json','utf8')), analytics = JSON.parse(await readFile('schemas/liquidity-analytics.schema.json','utf8'));
  const validate = new Ajv2020({ strict: true }).addSchema(analytics,'liquidity-analytics.schema.json').compile(schema);
  for (const value of [model,report,prediction,examples[0].outcome]) assert.equal(validate(value),true,JSON.stringify(validate.errors));
});
test('EDGE-04 invalid context never reaches execution and experimental prediction cannot bypass model admission',async () => {
  const f = frame(), c: RouteCandidate = { identity: f.identity,stateDigest: digest('state'),poolIds: [poolId],adapterId: 'test',adapterRevision: '1',payloadDigest: digest('payload'),borrowAmount: '1',profitAsset: 'arbitrum:42161:token',minProfit: '1',maxGasCost: '1',expiresAtMs: Number(time/1000000n)+1000 };
  let calls = 0;
  const runtime = { run: async (candidates: RouteCandidate[]) => { calls += candidates.length; return []; } } as unknown as LiquidityRuntime;
  const policy = { concurrency: 1,maxCandidates: 1,maxDailyLoss: '1',minProfit: '1',budgetAssets: { 'arbitrum:42161': c.profitAsset },mode: 'shadow' as const };
  const binding = { candidateDigest: digest(c),frameId: f.frameId,prediction: null,report: null,approvedReportId: null,expiresAtNs: (time+1000000000n).toString() };
  const result = await runL2Candidates(runtime,[c],[binding],[f],policy,(time+3000000000n).toString());
  assert.equal(calls,0); assert.equal(result[0].status,'rejected');
  await runL2Candidates(runtime,[c],[binding],[f],policy,time.toString()); assert.equal(calls,1);
  seam('EDGE-04','l2_execution_binding_rejected_before_send');
});
test('risk reflection that changes during final resource lookup prevents the real runtime signing lane',async () => {
  const dir = await mkdtemp(join(tmpdir(),'l2-gate-'));
  try {
    const f = frame(), risk = new L2RiskJournal(join(dir,'risk.jsonl'));
    const event = { eventId: 'initial',lane: 'arbitrum:42161',source: 'receipt-fixture',status: 'profitable' as const,unexpectedSlippageBps: 0,receiptDigest: digest('receipt') };
    const riskState = await risk.reflect(event), nowMs = Number(time/1000000n);
    const c: RouteCandidate = { identity: f.identity,stateDigest: digest('state'),poolIds: [poolId],adapterId: 'test',adapterRevision: '1',payloadDigest: digest('payload'),borrowAmount: '1',profitAsset: 'arbitrum:42161:token',minProfit: '1',maxGasCost: '1',expiresAtMs: nowMs+1000 };
    const state = new SnapshotStore(2000); state.apply({ schemaVersion: '3.0',identity: f.identity,sourceId: 'fixture',cursor: '1',observedAtMs: nowMs,complete: true,poolIds: [poolId],stateDigest: c.stateDigest });
    let signs = 0, sends = 0;
    const proof = { candidateDigest: digest(c),payloadDigest: c.payloadDigest,stateDigest: c.stateDigest,success: true,profitAfterDebt: '10',conservativeGasCostInProfitAsset: '1' };
    const adapter = { admission: { chain: 'arbitrum' as const,network: '42161',revision: '1',expiresAtMs: nowMs+1000,evidence: { schema: 'local',math: 'local',simulation: 'local',canary: 'fixture-only' } },simulate: async () => proof,preflight: async () => proof,resource: async () => { await risk.reflect({ ...event,eventId: 'unknown-during-rpc',status: 'unknown',receiptDigest: digest('unknown-receipt') }); return 'nonce-1'; },sign: async () => { signs++; throw new Error('UNEXPECTED_SIGN'); },submit: async () => { sends++; return ''; },receipt: async () => null };
    const runtime = new LiquidityRuntime(state,new AttemptJournal(join(dir,'attempts.jsonl')),new Map([['test',adapter]]),() => nowMs);
    const result = await runL2Candidates(runtime,[c],[{ candidateDigest: digest(c),frameId: f.frameId,prediction: null,report: null,approvedReportId: null,expiresAtNs: (time+1000000000n).toString(),riskSizing: { riskDigest: digest(riskState),unscaledMaximum: '1' } }],[f],{ concurrency: 1,maxCandidates: 1,maxDailyLoss: '100',minProfit: '1',budgetAssets: { 'arbitrum:42161': c.profitAsset },mode: 'auto' },time.toString(),risk,() => time.toString());
    assert.equal(signs,0); assert.equal(sends,0); assert.ok(result.some(d => d.code === 'L2_RISK_RESIZING_OR_RECONCILIATION_REQUIRED'));
  } finally { await rm(dir,{ recursive: true,force: true }); }
});
test('EDGE-05 risk reflection survives restart, halves size, restores only after five clean receipts, and retains unknown-PNL halt',async () => {
  const dir = await mkdtemp(join(tmpdir(),'l2-risk-'));
  try {
    let journal = new L2RiskJournal(join(dir,'risk.jsonl'));
    const event = { eventId: 'first',lane: 'arbitrum:42161',source: 'authoritative-receipt-fixture',status: 'defect' as const,unexpectedSlippageBps: 26,receiptDigest: digest('receipt') };
    assert.equal((await journal.reflect(event)).multiplierBps,5000);
    journal = new L2RiskJournal(journal.path);
    for (let i = 0; i < 4; i++) assert.equal((await journal.reflect({ ...event,eventId: `good-${i}`,status: 'profitable',unexpectedSlippageBps: 0,receiptDigest: digest(`receipt-${i}`) })).multiplierBps,5000);
    assert.equal((await journal.reflect({ ...event,eventId: 'duplicate-profit',status: 'profitable',unexpectedSlippageBps: 0,receiptDigest: digest('receipt-0') })).cleanTrades,4);
    assert.equal((await journal.reflect({ ...event,eventId: 'fifth',status: 'profitable',unexpectedSlippageBps: 0,receiptDigest: digest('fifth') })).multiplierBps,10000);
    await journal.reflect({ ...event,eventId: 'unknown',status: 'unknown',receiptDigest: digest('unknown') });
    assert.equal((await journal.reflect({ ...event,eventId: 'after-unknown',status: 'profitable',unexpectedSlippageBps: 0,receiptDigest: digest('after-unknown') })).halted,true);
    await assert.rejects(journal.reflect({ ...event,status: 'profitable' }),/SUBSTITUTION/);
    seam('EDGE-05','l2_accounting_reflection_halts_or_reconciles');
  } finally { await rm(dir,{ recursive: true,force: true }); }
});
