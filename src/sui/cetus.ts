import { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag } from '@mysten/sui/utils';
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
