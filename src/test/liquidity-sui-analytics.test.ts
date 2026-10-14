import assert from 'node:assert/strict';
import test from 'node:test';
import { bcs, TypeTagSerializer } from '@mysten/sui/bcs';
import { deriveDynamicFieldID, normalizeSuiAddress, normalizeStructTag, toBase58 } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import { CETUS_POOL_BCS, CETUS_TICK_FIELD_BCS, decodeCetusCheckpoint, suiObjectDigest, type CetusDecodeConfig, type PinnedSuiObject } from '../sui/cetus.js';
import { prepareSuiTrade, type SuiTradeBinding } from '../sui/route.js';
import { quoteDeepBookExactInput, type DeepBookBookState } from '../sui/deepbook.js';
import { cetusSqrtPriceAtTick } from '../liquidity/cetus-math.js';
import { digest } from '../liquidity/state.js';
import type { PoolStateEnvelope } from '../liquidity/projection.js';
import type { SizingRequest } from '../liquidity/sizing.js';
import { runLiquidityAnalytics } from '../liquidity/analytics.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { sizeConditionalCycle, type ConditionalVenue } from '../liquidity/sizing.js';
import { assertSuiReferencesAtCheckpoint } from '../liquidity/sources.js';

async function assertSchema(value: unknown): Promise<void> {
  const validate = new Ajv2020({ strict: true,allErrors: true }).compile(JSON.parse(await readFile('schemas/liquidity-analytics.schema.json','utf8')));
  assert.equal(validate(value),true,JSON.stringify(validate.errors));
}

const id = (n: number) => normalizeSuiAddress('0x' + n.toString(16)), hash = toBase58(new Uint8Array(32).fill(1));
const sui = normalizeStructTag('0x2::sui::SUI'), other = normalizeStructTag(`${id(20)}::coin::COIN`);
function object(objectId: string,objectType: string,contents: Uint8Array,owner: Parameters<typeof bcs.Object.serialize>[0]['owner'] = { Shared: { initialSharedVersion: '1' } }): PinnedSuiObject {
  const tag = TypeTagSerializer.parseFromStr(objectType,true); if (!('struct' in tag)) throw new Error('fixture type must be a struct');
  const bytes = bcs.Object.serialize({ data: { Move: { type: { Other: tag.struct },hasPublicTransfer: false,version: '2',contents } },owner,previousTransaction: hash,storageRebate: '0' }).toBytes();
  return { objectId,version: '2',digest: suiObjectDigest(bytes),objectType,objectBcsBase64: Buffer.from(bytes).toString('base64') };
}
function fixture() {
  const origin = id(30), stl = id(31), poolId = id(40), tableId = id(41), none = { is_none: true,v: '0' }, score = (tick: number) => String(tick + 443636);
  const pack = (address: string,origins: Array<{ moduleName: string; datatypeName: string; package: string }>,linkage = new Map<string,{ upgradedId: string; upgradedVersion: string }>()) => {
    const bytes = bcs.Object.serialize({ data: { Package: { id: address,version: '2',moduleMap: new Map(),typeOriginTable: origins,linkageTable: linkage } },owner: { Immutable: true },previousTransaction: hash,storageRebate: '0' }).toBytes();
    return { objectId: address,version: '2',digest: suiObjectDigest(bytes),objectType: 'package',objectBcsBase64: Buffer.from(bytes).toString('base64') };
  };
  const packages = [pack(origin,['Pool','Tick'].map(name => ({ moduleName: name.toLowerCase(),datatypeName: name,package: origin })),new Map([[stl,{ upgradedId: stl,upgradedVersion: '2' }]])),pack(stl,[{ moduleName: 'skip_list',datatypeName: 'Node',package: stl }])];
  const contents = CETUS_POOL_BCS.serialize({ id: poolId,coin_a: '1000000000',coin_b: '1000000000',tick_spacing: 1,fee_rate: '3000',liquidity: '1000000',current_sqrt_price: cetusSqrtPriceAtTick(0).toString(),current_tick_index: 0,fee_growth_global_a: '0',fee_growth_global_b: '0',fee_protocol_coin_a: '0',fee_protocol_coin_b: '0',
    tick_manager: { tick_spacing: 1,ticks: { id: tableId,head: [{ is_none: false,v: score(-60) }],tail: { is_none: false,v: score(60) },level: '1',max_level: '16',list_p: '2',size: '2',random: { seed: '1' } } },
    rewarder_manager: { rewarders: [],points_released: '0',points_growth_global: '0',last_updated_time: '1' },position_manager: { tick_spacing: 1,position_index: '0',positions: { id: id(42),head: [],tail: [],size: '0' } },is_pause: false,index: '1',url: '' }).toBytes();
  const nodes = [-60,60].map((tick,index) => {
    const objectId = deriveDynamicFieldID(tableId,{ u64: null },bcs.u64().serialize(score(tick)).toBytes()), type = normalizeStructTag(`0x2::dynamic_field::Field<u64,${stl}::skip_list::Node<${origin}::tick::Tick>>`);
    const bytes = CETUS_TICK_FIELD_BCS.serialize({ id: objectId,name: score(tick),value: { score: score(tick),nexts: [index ? none : { is_none: false,v: score(60) }],prev: index ? { is_none: false,v: score(-60) } : none,value: { index: Number(BigInt.asUintN(32,BigInt(tick))),sqrt_price: cetusSqrtPriceAtTick(tick).toString(),liquidity_net: BigInt.asUintN(128,index ? -1000000n : 1000000n).toString(),liquidity_gross: '1000000',fee_growth_outside_a: '0',fee_growth_outside_b: '0',points_growth_outside: '0',rewards_growth_outside: [] } } }).toBytes();
    return object(objectId,type,bytes,{ ObjectOwner: tableId });
  });
  const objects = [...packages,object(poolId,normalizeStructTag(`${origin}::pool::Pool<${sui},${other}>`),contents),...nodes].sort((a,b) => a.objectId.localeCompare(b.objectId));
  const refs = objects.map(({ objectId,version,digest }) => ({ objectId,version,digest }));
  const checkpoint = { schemaVersion: '3.0' as const,identity: { chain: 'sui' as const,network: 'mainnet' as const,height: '1',checkpointDigest: hash },chainIdentifier: hash,completeForDeclaredObjectSet: true,objects: refs,missingObjectIds: [],stateDigest: digest(refs) };
  const config: CetusDecodeConfig = { layout: 'cetus-interface-1.2.0',packageId: origin,typeOrigin: origin,moveStlOrigin: stl,packagePins: Object.fromEntries(packages.map(p => [p.objectId,p.digest])),poolId,coinAType: sui,coinBType: other,decimalsA: 9,decimalsB: 9,lowerTick: -200,upperTick: 200 };
  return { checkpoint,objects,config };
}
test('Cetus BCS decoder verifies object hashes, origins, linked tick coverage and signed values', async () => {
  // Independently computed with Python hashlib.blake2b(digest_size=32).
  assert.equal(suiObjectDigest(Buffer.from('abc')),'3Xu23fBcy3UMH651PYjpRjzceo27ZzjcqEb51n569Ds3');
  const f = fixture(), decoded = decodeCetusCheckpoint(f.checkpoint,f.objects,f.config);
  await assertSchema({ schemaVersion: '4.0',...f }); await assertSchema(decoded);
  assert.equal(decoded.pool.state.protocol,'cetus'); assert.equal(decoded.pool.state.liquidity,'1000000');
  assert.deepEqual('initializedTicks' in decoded.pool.state ? decoded.pool.state.initializedTicks.map(t => t.liquidityNet) : [],['1000000','-1000000']);
  const modified = structuredClone(f.objects), target = modified.find(o => o.objectId === f.config.poolId)!;
  const bytes = Buffer.from(target.objectBcsBase64,'base64'); bytes[bytes.length - 2] ^= 1; target.objectBcsBase64 = bytes.toString('base64');
  assert.throws(() => decodeCetusCheckpoint(f.checkpoint,modified,f.config),/INVALID_CETUS_BCS/);
  const missing = f.objects.filter(o => o.objectId === f.config.poolId || o.objectType === 'package'), refs = missing.map(({ objectId,version,digest }) => ({ objectId,version,digest }));
  assert.throws(() => decodeCetusCheckpoint({ ...f.checkpoint,objects: refs,stateDigest: digest(refs) },missing,f.config),/COVERAGE_GAP/);
  assert.throws(() => decodeCetusCheckpoint(f.checkpoint,f.objects,{ ...f.config,typeOrigin: id(90) }),/REVISION_MISMATCH/);
  const edge = decodeCetusCheckpoint(f.checkpoint,f.objects,{ ...f.config,upperTick: 60 });
  if (edge.pool.state.protocol === 'cetus') assert.equal(edge.pool.state.initializedTicks.at(-1)!.tick,60);
  assert.deepEqual(await runLiquidityAnalytics('decode-cetus',{ schemaVersion: '4.0',...f }),decoded);
});
test('Sui preparation resolves a Cetus PTB offline with one lender receipt and terminal guard', async () => {
  const f = fixture(), decoded = decodeCetusCheckpoint(f.checkpoint,f.objects,f.config), first: PoolStateEnvelope = { ...decoded.pool,state: { ...decoded.pool.state,protocol: 'cetus',sqrtPriceX64: cetusSqrtPriceAtTick(1000).toString(),tick: 1000,liquidity: '1000000000',feePips: 3000,tickSpacing: 1,lowerTick: 800,upperTick: 1200,complete: true,initializedTicks: [] } };
  const second: PoolStateEnvelope = { ...decoded.pool,poolId: `sui:mainnet:${id(50)}`,poolAddress: id(50),state: { ...decoded.pool.state,protocol: 'cetus',sqrtPriceX64: cetusSqrtPriceAtTick(0).toString(),tick: 0,liquidity: '1000000000',feePips: 3000,tickSpacing: 1,lowerTick: -200,upperTick: 200,complete: true,initializedTicks: [] } };
  const pools = [first,second], request: SizingRequest = { schemaVersion: '4.0',snapshotDigest: digest(pools),borrowAsset: sui,route: [{ poolId: first.poolId,tokenIn: sui },{ poolId: second.poolId,tokenIn: other }],minimum: '1000',maximum: '100000',quantum: '1000',lenderAvailable: '100000',flashFeeNumerator: '0',flashFeeDenominator: '1',costInBorrowAsset: '100',costEvidenceDigest: digest('fixture'),minProfit: '1' };
  const snapshot = { schemaVersion: '3.0' as const,identity: first.identity,sourceId: 'fixture',cursor: '1',observedAtMs: 1000,complete: true,poolIds: pools.map(p => p.poolId),stateDigest: digest(pools) };
  const objects = [40,50,60,61,6].map(n => ({ objectId: id(n),version: '2',digest: hash,initialSharedVersion: '1' }));
  const binding: SuiTradeBinding = { lender: { kind: 'deepbook-v3',packageId: id(70),poolId: id(60),baseType: sui,quoteType: other,side: 'base' },sender: id(80),gas: { objectId: id(81),version: '2',digest: hash },gasPrice: '1',gasBudget: '100',expirationEpoch: '2',objects: [...objects,...[82,83].map(n => ({ objectId: id(n),version: '2',digest: hash }))],venues: pools.map(p => ({ poolId: p.poolId,packageId: f.config.packageId,globalConfigId: id(61),adapterRevision: p.adapterRevision,packageDigest: p.revisionHash })),guard: { packageId: id(84),operatorCapId: id(82),pauseCapId: id(83) },adapterId: 'fixture',adapterRevision: 'fixture',expiresAtMs: 2000,maxGasCost: '100' };
  const prepared = await prepareSuiTrade(pools,request,snapshot,binding); assert.ok(prepared.transactionBytesBase64 && prepared.candidate);
  await assertSchema({ schemaVersion: '4.0',pools,request,snapshot,binding }); await assertSchema(prepared);
  const data = Transaction.from(Buffer.from(prepared.transactionBytesBase64,'base64')).getData();
  assert.equal(data.sender,binding.sender); assert.equal(data.gasData.payment![0].objectId,binding.gas.objectId);
  const calls = data.commands.filter(c => c.$kind === 'MoveCall').map(c => c.MoveCall);
  assert.equal(calls.filter(c => c.function === 'borrow_flashloan_base').length,1); assert.equal(calls.filter(c => c.function === 'return_flashloan_base').length,1);
  assert.equal(calls.filter(c => c.function === 'flash_swap').length,2); assert.equal(calls.at(-1)!.function,'assert_min_profit_and_transfer_with_pause');
  assert.equal(data.commands.some(c => c.$kind === 'TransferObjects'),false);
  assert.deepEqual(await runLiquidityAnalytics('prepare-sui',{ schemaVersion: '4.0',pools,request,snapshot,binding }),prepared);
  await assert.rejects(prepareSuiTrade(pools,request,snapshot,{ ...binding,objects: binding.objects.filter(o => o.objectId !== id(6)) }),/UNRESOLVED/);
  await assert.rejects(prepareSuiTrade(pools,{ ...request,minProfit: '999999999' },snapshot,{ ...binding,lender: { kind: 'unknown',assetType: sui } as unknown as SuiTradeBinding['lender'] }),/LENDER_MISMATCH/);
});
test('DeepBook input-fee quotes respect native lots, price priority, expiry, max fills and immutable books', async () => {
  const order = (orderId: number,price: string,remainingBase = '1000',expiresAtMs = '100') => ({ orderId: String(orderId),price,remainingBase,expiresAtMs });
  const state: DeepBookBookState = { schemaVersion: '4.0',revision: 'deepbook-v3-input-fee',packageDigest: hash,checkpointDigest: hash,lotSize: '10',minSize: '10',tickSize: '1',takerFee: '1000000',timestampMs: '100',complete: true,bids: [order(1,'2000000000')],asks: [order(2,'3000000000')] };
  const before = structuredClone(state), sell = quoteDeepBookExactInput(state,true,'1001'), buy = quoteDeepBookExactInput(state,false,'3004');
  await assertSchema({ schemaVersion: '4.0',state,baseToQuote: true,amountIn: '1001' }); await assertSchema(sell);
  assert.equal(sell.amountOut,'1980'); assert.equal(sell.feeAmount,'1'); assert.equal(sell.unspentInput,'10');
  assert.equal(buy.amountOut,'1000'); assert.equal(buy.feeAmount,'3'); assert.equal(buy.unspentInput,'1'); assert.deepEqual(state,before);
  assert.equal(quoteDeepBookExactInput({ ...state,bids: [order(1,'2000000000','1000','99')] },true,'1001').amountOut,'0');
  const expired = Array.from({ length: 100 },(_,i) => order(i + 1,'2000000000','1000','99'));
  assert.equal(quoteDeepBookExactInput({ ...state,bids: [...expired,order(101,'1000000000')],asks: [order(102,'3000000000')] },true,'1001').amountOut,'0');
  assert.throws(() => quoteDeepBookExactInput({ ...state,complete: false },true,'1001'),/INVALID_DEEPBOOK/);
  assert.throws(() => quoteDeepBookExactInput({ ...state,bids: [order(1,'1000000000'),order(3,'2000000000')] },true,'1001'),/INVALID_DEEPBOOK_ORDER/);
});
test('conditional DeepBook cycle sizing exhausts small native domains and retains base remainders', async () => {
  const book = (bid: string,ask: string): DeepBookBookState => ({ schemaVersion: '4.0',revision: 'deepbook-v3-input-fee',packageDigest: hash,checkpointDigest: hash,lotSize: '10',minSize: '10',tickSize: '1',takerFee: '0',timestampMs: '100',complete: true,bids: [{ orderId: '1',price: bid,remainingBase: '5000',expiresAtMs: '1000' }],asks: [{ orderId: '2',price: ask,remainingBase: '5000',expiresAtMs: '1000' }] });
  const identity = { chain: 'sui' as const,network: 'mainnet' as const,height: '1',checkpointDigest: hash }, venues: ConditionalVenue[] = [book('2000000000','3000000000'),book('900000000','1000000000')].map((state,index) => ({ poolId: `sui:mainnet:book${index}`,identity,token0: sui,token1: other,kind: 'deepbook',state,feeResolutions: [] }));
  const request: SizingRequest = { schemaVersion: '4.0',snapshotDigest: digest(venues),borrowAsset: sui,route: [{ poolId: venues[0].poolId,tokenIn: sui },{ poolId: venues[1].poolId,tokenIn: other }],minimum: '10',maximum: '200',quantum: '10',lenderAvailable: '200',flashFeeNumerator: '0',flashFeeDenominator: '1',costInBorrowAsset: '1',costEvidenceDigest: digest('fixture'),minProfit: '1' };
  const result = sizeConditionalCycle(venues,request);
  assert.equal(result.status,'selected'); assert.equal(result.direction,'forward'); assert.equal(result.amountIn,'200'); assert.equal(result.netProfit,'199'); assert.equal(result.evaluations,40); assert.equal(result.optimality,'certified');
  await assertSchema({ schemaVersion: '4.0',venues,request }); await assertSchema(result);
  assert.deepEqual(await runLiquidityAnalytics('size-conditional',{ schemaVersion: '4.0',venues,request }),result);
  const stale = structuredClone(venues); (stale[0].state as DeepBookBookState).checkpointDigest = toBase58(new Uint8Array(32).fill(2));
  assert.throws(() => sizeConditionalCycle(stale,{ ...request,snapshotDigest: digest(stale) }),/CHECKPOINT_MISMATCH/);
});
test('Sui source proof refuses stale or not-yet-checkpointed object versions', async () => {
  const ref = { objectId: id(40),version: '2',digest: hash }, latest = { ...ref,previousTransaction: hash };
  await assertSuiReferencesAtCheckpoint([ref],'10',{ latest: async () => latest,committedAt: async () => '8' });
  await assert.rejects(assertSuiReferencesAtCheckpoint([ref],'10',{ latest: async () => ({ ...latest,version: '3' }),committedAt: async () => '8' }),/PROOF_UNAVAILABLE/);
  await assert.rejects(assertSuiReferencesAtCheckpoint([ref],'10',{ latest: async () => latest,committedAt: async () => '11' }),/PROOF_UNAVAILABLE/);
});
