import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag } from '@mysten/sui/utils';
import { decimal } from './manifest.js';
import type { Decimal, SuiAddress, SuiObjectRef } from './types.js';
import { uint, digest, isSuiDigest } from '../liquidity/state.js';

const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;

export interface DeepBookOrder { orderId: string; price: string; remainingBase: string; expiresAtMs: string }
export interface DeepBookBookState {
  schemaVersion: '4.0'; revision: 'deepbook-v3-input-fee'; packageDigest: string; checkpointDigest: string;
  lotSize: string; minSize: string; tickSize: string; takerFee: string; timestampMs: string;
  complete: boolean; bids: DeepBookOrder[]; asks: DeepBookOrder[];
}
export interface DeepBookQuote {
  schemaVersion: '4.0'; snapshotDigest: string; amountIn: string; amountOut: string; consumedInput: string; unspentInput: string;
  feeAsset: 'input'; feeAmount: string; deepFeeAmount: '0'; fills: number; baseToQuote: boolean;
  nextState: DeepBookBookState; nextStateDigest: string;
}
/** Mirror Book.get_quantity_out with input-token fees, 1e9 scaling and 100 scanned orders.
 * DEEP-funded swaps require a separate admitted fee-price model and are never approximated here.
 */
export function quoteDeepBookExactInput(raw: DeepBookBookState, baseToQuote: boolean, amountIn: string): DeepBookQuote {
  const state = structuredClone(raw), scale = 1000000000n;
  if (!state || Object.keys(state).sort().join(',') !== 'asks,bids,checkpointDigest,complete,lotSize,minSize,packageDigest,revision,schemaVersion,takerFee,tickSize,timestampMs' || state.schemaVersion !== '4.0' || state.revision !== 'deepbook-v3-input-fee' || state.complete !== true || typeof baseToQuote !== 'boolean' || !isSuiDigest(state.packageDigest) || !isSuiDigest(state.checkpointDigest) || !Array.isArray(state.bids) || !Array.isArray(state.asks) || state.bids.length + state.asks.length > 10000) throw new Error('INVALID_DEEPBOOK_BOOK_STATE');
  const lot = uint(state.lotSize,64), min = uint(state.minSize,64), tick = uint(state.tickSize,64), taker = uint(state.takerFee,64), now = uint(state.timestampMs,64), input = uint(amountIn,64);
  if (!lot || !min || min % lot || !tick || taker >= scale || !input) throw new Error('INVALID_DEEPBOOK_BOOK_STATE');
  const ids = new Set<string>();
  for (const [orders,isBid] of [[state.bids,true],[state.asks,false]] as const) {
    let prior: bigint | undefined;
    for (const order of orders) {
      if (!order || Object.keys(order).sort().join(',') !== 'expiresAtMs,orderId,price,remainingBase') throw new Error('INVALID_DEEPBOOK_ORDER');
      const price = uint(order.price,64), size = uint(order.remainingBase,64); uint(order.orderId,128); uint(order.expiresAtMs,64);
      if (!price || price % tick || !size || size % lot || ids.has(order.orderId) || (prior !== undefined && (isBid ? price > prior : price < prior))) throw new Error('INVALID_DEEPBOOK_ORDER');
      ids.add(order.orderId); prior = price;
    }
  }
  const feeRate = taker * 1250000000n / scale, side = baseToQuote ? state.bids : state.asks;
  let remaining = input, output = 0n, fees = 0n, fills = 0;
  const matched = new Map<string,bigint>();
  if (!baseToQuote || input * scale / (scale + feeRate) >= min) {
    for (const order of side) {
      if (!remaining || fills >= 100) break;
      if (now <= uint(order.expiresAtMs,64)) {
        const available = remaining * scale / (scale + feeRate), price = uint(order.price,64), size = uint(order.remainingBase,64);
        let quantity = baseToQuote ? available : available * scale / price;
        quantity = (quantity < size ? quantity : size) / lot * lot;
        if (!quantity) break;
        const quote = quantity * price / scale, used = baseToQuote ? quantity : quote, fee = used * feeRate / scale;
        if (used + fee > remaining) throw new Error('DEEPBOOK_MATH_INVARIANT');
        remaining -= used + fee; fees += fee; output += baseToQuote ? quote : quantity; matched.set(order.orderId,quantity);
      }
      fills++;
    }
  }
  if ((!baseToQuote && output < min) || (baseToQuote && input - remaining > 0n && input - remaining < min)) { remaining = input; output = 0n; fees = 0n; matched.clear(); }
  uint(output.toString(),64);
  const update = (orders: DeepBookOrder[]) => orders.map(order => ({ ...order,remainingBase: (uint(order.remainingBase,64) - (matched.get(order.orderId) ?? 0n)).toString() })).filter(order => order.remainingBase !== '0');
  state.bids = update(state.bids); state.asks = update(state.asks);
  return { schemaVersion: '4.0',snapshotDigest: digest(raw),amountIn,amountOut: output.toString(),consumedInput: (input - remaining).toString(),unspentInput: remaining.toString(),feeAsset: 'input',feeAmount: fees.toString(),deepFeeAmount: '0',fills,baseToQuote,nextState: state,nextStateDigest: digest(state) };
}

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
