import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag } from '@mysten/sui/utils';
import { decimal } from './manifest.js';
import type { Decimal, SuiAddress, SuiObjectRef } from './types.js';

const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;

export interface DeepBookFlashloanCanary {
  network: 'mainnet';
  packageId: SuiAddress;
  packageDigest: string;
  verifiedCheckpoint: Decimal;
  /** Original package that defines the Pool struct, which can differ from the current callable package. */
  poolTypeOrigin: SuiAddress;
  /** Stable shared-object identity; version and digest are captured per simulation. */
  poolId: SuiAddress;
  baseAssetType: string;
  quoteAssetType: string;
  borrowAmount: Decimal;
}

export interface DeepBookCanarySnapshot {
  checkpoint: Decimal;
  packageDigest: string;
  pool: SuiObjectRef;
  poolType: string;
}

export interface DeepBookCanarySimulation {
  snapshot: DeepBookCanarySnapshot;
  gasUsed: {
    computationCost: string;
    storageCost: string;
    storageRebate: string;
    nonRefundableStorageFee: string;
  };
}

function assertAddress(value: string, field: string): asserts value is SuiAddress {
  if (!ADDRESS.test(value)) throw new Error(`${field} must be a Sui address`);
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return value;
}

/** Loads a reviewed DeepBook canary shape. It contains public IDs only and never a signer. */
export function loadDeepBookFlashloanCanary(env: NodeJS.ProcessEnv = process.env): DeepBookFlashloanCanary {
  const canary: DeepBookFlashloanCanary = {
    network: 'mainnet',
    packageId: required(env.SUI_DEEPBOOK_PACKAGE_ID, 'SUI_DEEPBOOK_PACKAGE_ID') as SuiAddress,
    packageDigest: required(env.SUI_DEEPBOOK_PACKAGE_DIGEST, 'SUI_DEEPBOOK_PACKAGE_DIGEST'),
    verifiedCheckpoint: required(env.SUI_DEEPBOOK_VERIFIED_CHECKPOINT, 'SUI_DEEPBOOK_VERIFIED_CHECKPOINT'),
    poolTypeOrigin: required(env.SUI_DEEPBOOK_POOL_TYPE_ORIGIN, 'SUI_DEEPBOOK_POOL_TYPE_ORIGIN') as SuiAddress,
    poolId: required(env.SUI_DEEPBOOK_POOL_ID, 'SUI_DEEPBOOK_POOL_ID') as SuiAddress,
    baseAssetType: required(env.SUI_DEEPBOOK_BASE_ASSET_TYPE, 'SUI_DEEPBOOK_BASE_ASSET_TYPE'),
    quoteAssetType: required(env.SUI_DEEPBOOK_QUOTE_ASSET_TYPE, 'SUI_DEEPBOOK_QUOTE_ASSET_TYPE'),
    borrowAmount: required(env.SUI_DEEPBOOK_BORROW_AMOUNT, 'SUI_DEEPBOOK_BORROW_AMOUNT')
  };
  validateDeepBookFlashloanCanary(canary);
  return canary;
}

/** Validates the exact public DeepBook inputs needed for a non-profitable lender canary. */
export function validateDeepBookFlashloanCanary(canary: DeepBookFlashloanCanary): void {
  if (canary.network !== 'mainnet') throw new Error('DeepBook flashloan canary currently supports mainnet only');
  assertAddress(canary.packageId, 'packageId');
  assertAddress(canary.poolTypeOrigin, 'poolTypeOrigin');
  assertAddress(canary.poolId, 'poolId');
  if (!canary.packageDigest) throw new Error('packageDigest is required');
  if (!canary.baseAssetType.includes('::') || !canary.quoteAssetType.includes('::')) {
    throw new Error('baseAssetType and quoteAssetType must be normalized Move types');
  }
  if (decimal(canary.verifiedCheckpoint, 'verifiedCheckpoint') === 0n) {
    throw new Error('verifiedCheckpoint must be positive');
  }
  if (decimal(canary.borrowAmount, 'borrowAmount') === 0n) throw new Error('borrowAmount must be positive');
}

/**
 * Emits only a lender canary: borrow base, split the exact principal, return the hot potato,
 * and send the zero-value remainder back to the caller. It contains no swap or profit send path.
 */
export function buildDeepBookFlashloanCanary(
  transaction: Transaction,
  canary: DeepBookFlashloanCanary,
  recipient: SuiAddress
): void {
  validateDeepBookFlashloanCanary(canary);
  assertAddress(recipient, 'recipient');
  const [baseCoin, flashLoan] = transaction.moveCall({
    target: `${canary.packageId}::pool::borrow_flashloan_base`,
    arguments: [transaction.object(canary.poolId), transaction.pure.u64(decimal(canary.borrowAmount, 'borrowAmount'))],
    typeArguments: [canary.baseAssetType, canary.quoteAssetType]
  });
  const [repayment] = transaction.splitCoins(baseCoin, [transaction.pure.u64(decimal(canary.borrowAmount, 'borrowAmount'))]);
  transaction.moveCall({
    target: `${canary.packageId}::pool::return_flashloan_base`,
    arguments: [transaction.object(canary.poolId), repayment, flashLoan],
    typeArguments: [canary.baseAssetType, canary.quoteAssetType]
  });
  transaction.transferObjects([baseCoin], recipient);
}

/** Reads live package, pool, and checkpoint evidence without constructing a signer. */
export async function snapshotDeepBookFlashloanCanary(
  client: SuiGrpcClient,
  canary: DeepBookFlashloanCanary
): Promise<DeepBookCanarySnapshot> {
  validateDeepBookFlashloanCanary(canary);
  const [packageResult, poolResult, checkpointResult] = await Promise.all([
    client.getObject({ objectId: canary.packageId }),
    client.getObject({ objectId: canary.poolId, include: { content: true } }),
    client.ledgerService.getCheckpoint({ checkpointId: { oneofKind: undefined } }).response
  ]);
  const packageObject = packageResult.object;
  const poolObject = poolResult.object;
  const checkpoint = checkpointResult.checkpoint?.sequenceNumber;
  if (!packageObject?.digest) throw new Error('DeepBook package object could not be resolved');
  if (!poolObject?.version || !poolObject.digest || !poolObject.type || !checkpoint) {
    throw new Error('DeepBook pool or checkpoint could not be resolved');
  }
  return {
    checkpoint: checkpoint.toString(),
    packageDigest: packageObject.digest,
    pool: { id: canary.poolId, version: poolObject.version.toString(), digest: poolObject.digest },
    poolType: poolObject.type
  };
}

/** Fails closed when a reviewed package or shared-pool reference has changed. */
export function assertDeepBookCanarySnapshot(
  canary: DeepBookFlashloanCanary,
  snapshot: DeepBookCanarySnapshot
): void {
  validateDeepBookFlashloanCanary(canary);
  if (decimal(snapshot.checkpoint, 'snapshot.checkpoint') < decimal(canary.verifiedCheckpoint, 'verifiedCheckpoint')) {
    throw new Error('snapshot checkpoint predates DeepBook verification');
  }
  if (snapshot.packageDigest !== canary.packageDigest) throw new Error('DeepBook package digest mismatch');
  if (snapshot.pool.id.toLowerCase() !== canary.poolId.toLowerCase()) throw new Error('DeepBook pool identity mismatch');
  const expectedPoolType = normalizeStructTag(`${canary.poolTypeOrigin}::pool::Pool<${canary.baseAssetType},${canary.quoteAssetType}>`);
  if (normalizeStructTag(snapshot.poolType) !== expectedPoolType) throw new Error('DeepBook pool type mismatch');
}

/** Runs the exact hot-potato canary through gRPC simulation. It never signs or submits. */
export async function simulateDeepBookFlashloanCanary(
  client: SuiGrpcClient,
  canary: DeepBookFlashloanCanary,
  sender: SuiAddress,
  gasBudgetMist: bigint
): Promise<DeepBookCanarySimulation> {
  assertAddress(sender, 'sender');
  if (gasBudgetMist <= 0n) throw new Error('gasBudgetMist must be positive');
  const snapshot = await snapshotDeepBookFlashloanCanary(client, canary);
  assertDeepBookCanarySnapshot(canary, snapshot);
  const transaction = new Transaction();
  buildDeepBookFlashloanCanary(transaction, canary, sender);
  transaction.setSender(sender);
  transaction.setGasBudget(gasBudgetMist);
  const result = await client.simulateTransaction({ transaction, include: { effects: true } });
  if (result.$kind !== 'Transaction' || !result.Transaction.effects?.status.success || !result.Transaction.effects.gasUsed) {
    throw new Error('DeepBook flashloan canary simulation failed');
  }
  const gasUsed = result.Transaction.effects.gasUsed;
  return {
    snapshot,
    gasUsed: {
      computationCost: gasUsed.computationCost.toString(),
      storageCost: gasUsed.storageCost.toString(),
      storageRebate: gasUsed.storageRebate.toString(),
      nonRefundableStorageFee: gasUsed.nonRefundableStorageFee.toString()
    }
  };
}
