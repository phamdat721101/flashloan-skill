import { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag } from '@mysten/sui/utils';
import { deriveDynamicFieldID, normalizeSuiAddress, toBase58 } from '@mysten/sui/utils';
import { blake2b } from '@noble/hashes/blake2b';
import { bcs, TypeTagSerializer } from '@mysten/sui/bcs';
import { digest, isSuiDigest, parseStateIdentity, uint, type StateIdentity } from '../liquidity/state.js';
import { parsePoolState, type PoolStateEnvelope } from '../liquidity/projection.js';
import { cetusSqrtPriceAtTick } from '../liquidity/cetus-math.js';
import type { SuiVersionedRef } from '../liquidity/sui-state.js';
import { decimal } from './manifest.js';
import type { Decimal, SuiAddress, SuiObjectRef } from './types.js';

const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;

export interface CetusPoolCanary {
  network: 'mainnet';
  packageId: SuiAddress;
  packageDigest: string;
  verifiedCheckpoint: Decimal;
  globalConfigId: SuiAddress;
  poolId: SuiAddress;
  coinAType: string;
  coinBType: string;
  feeRate: Decimal;
}

export interface CetusPoolSnapshot {
  checkpoint: Decimal;
  packageDigest: string;
  pool: SuiObjectRef;
  poolType: string;
  isPaused: boolean;
  feeRate: Decimal;
  liquidity: Decimal;
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function assertAddress(value: string, field: string): asserts value is SuiAddress {
  if (!ADDRESS.test(value)) throw new Error(`${field} must be a Sui address`);
}

/** Loads only revision-pinned, public Cetus CLMM inputs. A signer or fee coin is deliberately excluded. */
export function loadCetusPoolCanary(env: NodeJS.ProcessEnv = process.env): CetusPoolCanary {
  const canary: CetusPoolCanary = {
    network: 'mainnet',
    packageId: required(env.SUI_CETUS_PACKAGE_ID, 'SUI_CETUS_PACKAGE_ID') as SuiAddress,
    packageDigest: required(env.SUI_CETUS_PACKAGE_DIGEST, 'SUI_CETUS_PACKAGE_DIGEST'),
    verifiedCheckpoint: required(env.SUI_CETUS_VERIFIED_CHECKPOINT, 'SUI_CETUS_VERIFIED_CHECKPOINT'),
    globalConfigId: required(env.SUI_CETUS_GLOBAL_CONFIG_ID, 'SUI_CETUS_GLOBAL_CONFIG_ID') as SuiAddress,
    poolId: required(env.SUI_CETUS_POOL_ID, 'SUI_CETUS_POOL_ID') as SuiAddress,
    coinAType: required(env.SUI_CETUS_COIN_A_TYPE, 'SUI_CETUS_COIN_A_TYPE'),
    coinBType: required(env.SUI_CETUS_COIN_B_TYPE, 'SUI_CETUS_COIN_B_TYPE'),
    feeRate: required(env.SUI_CETUS_FEE_RATE, 'SUI_CETUS_FEE_RATE')
  };
  validateCetusPoolCanary(canary);
  return canary;
}

/** Validates the static inputs used to admit one Cetus shared pool into a route. */
export function validateCetusPoolCanary(canary: CetusPoolCanary): void {
  if (canary.network !== 'mainnet') throw new Error('Cetus pool canary currently supports mainnet only');
  assertAddress(canary.packageId, 'packageId');
  assertAddress(canary.globalConfigId, 'globalConfigId');
  assertAddress(canary.poolId, 'poolId');
  if (!canary.packageDigest) throw new Error('packageDigest is required');
  if (!canary.coinAType.includes('::') || !canary.coinBType.includes('::')) {
    throw new Error('coinAType and coinBType must be normalized Move types');
  }
  if (decimal(canary.verifiedCheckpoint, 'verifiedCheckpoint') === 0n) {
    throw new Error('verifiedCheckpoint must be positive');
  }
  if (decimal(canary.feeRate, 'feeRate') === 0n) throw new Error('feeRate must be positive');
}

/** Reads live Cetus package, pool, and checkpoint evidence without preparing a transaction or signer. */
export async function snapshotCetusPoolCanary(
  client: SuiGrpcClient,
  canary: CetusPoolCanary
): Promise<CetusPoolSnapshot> {
  validateCetusPoolCanary(canary);
  const [packageResult, poolResult, checkpointResult] = await Promise.all([
    client.getObject({ objectId: canary.packageId }),
    client.getObject({ objectId: canary.poolId, include: { json: true } }),
    client.ledgerService.getCheckpoint({ checkpointId: { oneofKind: undefined } }).response
  ]);
  const packageObject = packageResult.object;
  const poolObject = poolResult.object;
  const checkpoint = checkpointResult.checkpoint?.sequenceNumber;
  const pool = poolObject?.json;
  if (!packageObject?.digest) throw new Error('Cetus package object could not be resolved');
  if (!poolObject?.version || !poolObject.digest || !poolObject.type || !checkpoint || !pool) {
    throw new Error('Cetus pool or checkpoint could not be resolved');
  }
  if (typeof pool.is_pause !== 'boolean' || typeof pool.fee_rate !== 'string' || typeof pool.liquidity !== 'string') {
    throw new Error('Cetus pool JSON projection is incomplete');
  }
  return {
    checkpoint: checkpoint.toString(),
    packageDigest: packageObject.digest,
    pool: { id: canary.poolId, version: poolObject.version.toString(), digest: poolObject.digest },
    poolType: poolObject.type,
    isPaused: pool.is_pause,
    feeRate: pool.fee_rate,
    liquidity: pool.liquidity
  };
}

/** Fails closed on a stale package, a different pool type, a paused pool, or fee/liquidity drift. */
export function assertCetusPoolCanarySnapshot(canary: CetusPoolCanary, snapshot: CetusPoolSnapshot): void {
  validateCetusPoolCanary(canary);
  if (decimal(snapshot.checkpoint, 'snapshot.checkpoint') < decimal(canary.verifiedCheckpoint, 'verifiedCheckpoint')) {
    throw new Error('snapshot checkpoint predates Cetus verification');
  }
  if (snapshot.packageDigest !== canary.packageDigest) throw new Error('Cetus package digest mismatch');
  if (snapshot.pool.id.toLowerCase() !== canary.poolId.toLowerCase()) throw new Error('Cetus pool identity mismatch');
  const expectedPoolType = normalizeStructTag(`${canary.packageId}::pool::Pool<${canary.coinAType},${canary.coinBType}>`);
  if (normalizeStructTag(snapshot.poolType) !== expectedPoolType) throw new Error('Cetus pool type mismatch');
  if (snapshot.isPaused) throw new Error('Cetus pool is paused');
  if (snapshot.feeRate !== canary.feeRate) throw new Error('Cetus pool fee rate mismatch');
  if (decimal(snapshot.liquidity, 'snapshot.liquidity') === 0n) throw new Error('Cetus pool has no liquidity');
}

// Exact layouts from Cetus clmm-interface 1.2.0 and move-stl. A changed layout
// requires a new revision adapter; no latest JSON projection is substituted.
const optionU64 = bcs.struct('OptionU64',{ is_none: bcs.bool(),v: bcs.u64() });
const skipList = bcs.struct('SkipList',{ id: bcs.Address,head: bcs.vector(optionU64),tail: optionU64,level: bcs.u64(),max_level: bcs.u64(),list_p: bcs.u64(),size: bcs.u64(),random: bcs.struct('Random',{ seed: bcs.u64() }) });
const optionId = bcs.vector(bcs.Address);
export const CETUS_POOL_BCS = bcs.struct('Pool',{
  id: bcs.Address,coin_a: bcs.u64(),coin_b: bcs.u64(),tick_spacing: bcs.u32(),fee_rate: bcs.u64(),liquidity: bcs.u128(),current_sqrt_price: bcs.u128(),current_tick_index: bcs.u32(),
  fee_growth_global_a: bcs.u128(),fee_growth_global_b: bcs.u128(),fee_protocol_coin_a: bcs.u64(),fee_protocol_coin_b: bcs.u64(),
  tick_manager: bcs.struct('TickManager',{ tick_spacing: bcs.u32(),ticks: skipList }),
  rewarder_manager: bcs.struct('RewarderManager',{ rewarders: bcs.vector(bcs.struct('Rewarder',{ reward_coin: bcs.string(),emissions_per_second: bcs.u128(),growth_global: bcs.u128() })),points_released: bcs.u128(),points_growth_global: bcs.u128(),last_updated_time: bcs.u64() }),
  position_manager: bcs.struct('PositionManager',{ tick_spacing: bcs.u32(),position_index: bcs.u64(),positions: bcs.struct('LinkedTable',{ id: bcs.Address,head: optionId,tail: optionId,size: bcs.u64() }) }),
  is_pause: bcs.bool(),index: bcs.u64(),url: bcs.string()
});
export const CETUS_TICK_FIELD_BCS = bcs.struct('Field',{
  id: bcs.Address,name: bcs.u64(),value: bcs.struct('Node',{ score: bcs.u64(),nexts: bcs.vector(optionU64),prev: optionU64,value: bcs.struct('Tick',{
    index: bcs.u32(),sqrt_price: bcs.u128(),liquidity_net: bcs.u128(),liquidity_gross: bcs.u128(),fee_growth_outside_a: bcs.u128(),fee_growth_outside_b: bcs.u128(),points_growth_outside: bcs.u128(),rewards_growth_outside: bcs.vector(bcs.u128())
  }) })
});
export interface CetusDecodeConfig {
  layout: 'cetus-interface-1.2.0'; packageId: string; typeOrigin: string; moveStlOrigin: string;
  packagePins: Record<string,string>; poolId: string; coinAType: string; coinBType: string;
  decimalsA: number; decimalsB: number; lowerTick: number; upperTick: number;
}
export interface CheckpointObjectSet {
  schemaVersion: '3.0'; identity: StateIdentity; chainIdentifier: string; completeForDeclaredObjectSet: boolean;
  objects: SuiVersionedRef[]; missingObjectIds: string[]; stateDigest: string;
}
export type PinnedSuiObject = SuiVersionedRef & { objectType: string; objectBcsBase64: string };
export function suiObjectDigest(bytes: Uint8Array): string {
  return toBase58(blake2b(Buffer.concat([Buffer.from('Object::'),bytes]),{ dkLen: 32 }));
}
/** Decode the entire linked tick table at checkpoint-proven versions, then select a covered window. */
export function decodeCetusCheckpoint(raw: CheckpointObjectSet, observations: PinnedSuiObject[], config: CetusDecodeConfig): { schemaVersion: '4.0'; pool: PoolStateEnvelope; stateRefs: SuiVersionedRef[]; coverageDigest: string } {
  if (!raw || Object.keys(raw).sort().join(',') !== 'chainIdentifier,completeForDeclaredObjectSet,identity,missingObjectIds,objects,schemaVersion,stateDigest' || !Array.isArray(raw.objects) || !Array.isArray(raw.missingObjectIds) || !Array.isArray(observations)) throw new Error('INCOMPLETE_CETUS_OBJECT_SET');
  const identity = parseStateIdentity(raw.identity);
  if (raw.schemaVersion !== '3.0' || identity.chain !== 'sui' || !isSuiDigest(raw.chainIdentifier) || raw.completeForDeclaredObjectSet !== true || raw.missingObjectIds.length || digest(raw.objects) !== raw.stateDigest || !observations.length || observations.length > 10000 || observations.length !== raw.objects.length || new Set(observations.map(o => o.objectId)).size !== observations.length) throw new Error('INCOMPLETE_CETUS_OBJECT_SET');
  if (!config || Object.keys(config).sort().join(',') !== 'coinAType,coinBType,decimalsA,decimalsB,layout,lowerTick,moveStlOrigin,packageId,packagePins,poolId,typeOrigin,upperTick' || config.layout !== 'cetus-interface-1.2.0' || !config.packagePins || !Object.keys(config.packagePins).length || Object.keys(config.packagePins).length > 16) throw new Error('INVALID_CETUS_DECODER_CONFIG');
  for (const id of [config.poolId,config.packageId,config.typeOrigin,config.moveStlOrigin,...Object.keys(config.packagePins)]) if (normalizeSuiAddress(id) !== id) throw new Error('INVALID_CETUS_DECODER_CONFIG');
  if (!isSuiDigest(config.packagePins[config.packageId]) || normalizeStructTag(config.coinAType) !== config.coinAType || normalizeStructTag(config.coinBType) !== config.coinBType) throw new Error('INVALID_CETUS_DECODER_CONFIG');
  const refs = new Map(raw.objects.map(ref => [ref.objectId,ref]));
  if (refs.size !== raw.objects.length) throw new Error('INCOMPLETE_CETUS_OBJECT_SET');
  const decoded = new Map(observations.map(o => {
    const ref = refs.get(o.objectId);
    if (!ref || ref.version !== o.version || ref.digest !== o.digest || !isSuiDigest(o.digest) || typeof o.objectBcsBase64 !== 'string' || o.objectBcsBase64.length > 350000) throw new Error('CETUS_OBJECT_REF_MISMATCH');
    const bytes = Buffer.from(o.objectBcsBase64,'base64');
    if (bytes.toString('base64') !== o.objectBcsBase64 || suiObjectDigest(bytes) !== o.digest) throw new Error('INVALID_CETUS_BCS');
    const object = bcs.Object.parse(bytes);
    if (!Buffer.from(bcs.Object.serialize(object).toBytes()).equals(bytes)) throw new Error('INVALID_CETUS_BCS');
    const value = object.data;
    if (value.$kind === 'Move') {
      if (value.Move.version !== o.version || value.Move.type.$kind !== 'Other' || normalizeStructTag(TypeTagSerializer.tagToString({ struct: value.Move.type.Other })) !== normalizeStructTag(o.objectType) || Buffer.from(value.Move.contents).subarray(0,32).toString('hex') !== o.objectId.slice(2)) throw new Error('CETUS_OBJECT_TYPE_MISMATCH');
    } else if (value.Package.id !== o.objectId || value.Package.version !== o.version || o.objectType !== 'package') throw new Error('CETUS_OBJECT_TYPE_MISMATCH');
    return [o.objectId,object] as const;
  }));
  for (const [id,pin] of Object.entries(config.packagePins)) if (!isSuiDigest(pin) || refs.get(id)?.digest !== pin || decoded.get(id)?.data.$kind !== 'Package') throw new Error('CETUS_PACKAGE_REVISION_MISMATCH');
  const code = decoded.get(config.packageId)!.data.Package!;
  if (!['Pool','Tick'].every(name => code.typeOriginTable.some(origin => origin.moduleName === (name === 'Pool' ? 'pool' : 'tick') && origin.datatypeName === name && origin.package === config.typeOrigin))) throw new Error('CETUS_PACKAGE_REVISION_MISMATCH');
  const stlId = code.linkageTable.get(config.moveStlOrigin)?.upgradedId ?? config.moveStlOrigin;
  const stl = decoded.get(stlId)?.data;
  if (!config.packagePins[stlId] || stl?.$kind !== 'Package' || !stl.Package.typeOriginTable.some(origin => origin.moduleName === 'skip_list' && origin.datatypeName === 'Node' && origin.package === config.moveStlOrigin)) throw new Error('CETUS_PACKAGE_REVISION_MISMATCH');
  const source = decoded.get(config.poolId);
  if (!source || source.data.$kind !== 'Move' || normalizeStructTag(TypeTagSerializer.tagToString({ struct: source.data.Move.type.Other! })) !== normalizeStructTag(`${config.typeOrigin}::pool::Pool<${config.coinAType},${config.coinBType}>`)) throw new Error('CETUS_OBJECT_TYPE_MISMATCH');
  const bytes = Uint8Array.from(source.data.Move.contents), pool = CETUS_POOL_BCS.parse(bytes);
  if (!Buffer.from(CETUS_POOL_BCS.serialize(pool).toBytes()).equals(Buffer.from(bytes)) || pool.id !== config.poolId || pool.is_pause || pool.tick_manager.tick_spacing !== pool.tick_spacing || pool.position_manager.tick_spacing !== pool.tick_spacing || pool.position_manager.positions.head.length > 1 || pool.position_manager.positions.tail.length > 1 || pool.rewarder_manager.rewarders.length > 3) throw new Error('INVALID_CETUS_POOL_BCS');
  const table = pool.tick_manager.ticks, count = uint(table.size,64);
  if (count > 10000n || table.head.length > 64 || table.level > table.max_level || BigInt(table.head.length) > BigInt(table.max_level)) throw new Error('INVALID_CETUS_TICK_TABLE');
  const type = normalizeStructTag(`0x2::dynamic_field::Field<u64,${config.moveStlOrigin}::skip_list::Node<${config.typeOrigin}::tick::Tick>>`);
  const ticks: Array<{ tick: number; liquidityGross: string; liquidityNet: string }> = [], visited = new Set<string>();
  let score = table.head[0] && !table.head[0].is_none ? table.head[0].v : null, previous: string | null = null;
  while (score !== null) {
    if (visited.size >= Number(count) || visited.has(score)) throw new Error('INVALID_CETUS_TICK_TABLE');
    visited.add(score);
    const id = deriveDynamicFieldID(table.id,{ u64: null },bcs.u64().serialize(score).toBytes()), object = decoded.get(id);
    if (!object || object.data.$kind !== 'Move' || object.owner.$kind !== 'ObjectOwner' || object.owner.ObjectOwner !== table.id || normalizeStructTag(TypeTagSerializer.tagToString({ struct: object.data.Move.type.Other! })) !== type) throw new Error('CETUS_TICK_COVERAGE_GAP');
    const nodeBytes = Uint8Array.from(object.data.Move.contents), field = CETUS_TICK_FIELD_BCS.parse(nodeBytes), node = field.value, tick = node.value;
    const index = Number(BigInt.asIntN(32,BigInt(tick.index))), net = BigInt.asIntN(128,BigInt(tick.liquidity_net));
    if (!Buffer.from(CETUS_TICK_FIELD_BCS.serialize(field).toBytes()).equals(Buffer.from(nodeBytes)) || field.id !== id || field.name !== score || node.score !== score || !node.nexts.length || node.nexts.length > 64 || (node.prev.is_none ? null : node.prev.v) !== previous || BigInt(score) !== BigInt(index + 443636) || BigInt(tick.sqrt_price) !== cetusSqrtPriceAtTick(index) || (ticks.length && ticks.at(-1)!.tick >= index)) throw new Error('INVALID_CETUS_TICK_TABLE');
    ticks.push({ tick: index,liquidityGross: tick.liquidity_gross,liquidityNet: net.toString() });
    previous = score; score = node.nexts[0].is_none ? null : node.nexts[0].v;
  }
  if (BigInt(ticks.length) !== count || (table.tail.is_none ? null : table.tail.v) !== previous) throw new Error('CETUS_TICK_COVERAGE_GAP');
  const envelope = parsePoolState({ schemaVersion: '4.0',identity,poolId: `sui:${identity.network}:${config.poolId}`,poolAddress: config.poolId,adapterRevision: config.layout,revisionHash: config.packagePins[config.packageId],token0: config.coinAType,token1: config.coinBType,decimals0: config.decimalsA,decimals1: config.decimalsB,stateClass: 'canonical',appliedOperations: [],state: { protocol: 'cetus',sqrtPriceX64: pool.current_sqrt_price,tick: Number(BigInt.asIntN(32,BigInt(pool.current_tick_index))),liquidity: pool.liquidity,feePips: Number(pool.fee_rate),tickSpacing: pool.tick_spacing,lowerTick: config.lowerTick,upperTick: config.upperTick,complete: true,initializedTicks: ticks.filter(t => t.tick >= config.lowerTick && t.tick <= config.upperTick) } });
  return { schemaVersion: '4.0',pool: envelope,stateRefs: structuredClone(raw.objects),coverageDigest: digest({ checkpoint: identity,table,ticks,refs: raw.objects }) };
}
