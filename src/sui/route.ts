import { decimal } from './manifest.js';
import type { Decimal, RouteCommand, SuiRoutePlan, SwapLeg } from './types.js';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import { appendFlashBorrow, type FlashLender } from './flash-lenders.js';
import { parsePoolState } from '../liquidity/projection.js';
import { compareRouteDirections, parseSizingRequest, sizingToCandidate, type RouteComparison } from '../liquidity/sizing.js';
import { digest, isSuiDigest, parseSnapshot, uint, type LiquiditySnapshot } from '../liquidity/state.js';
import type { RouteCandidate } from '../liquidity/runtime.js';
import { cetusSqrtPriceAtTick } from '../liquidity/cetus-math.js';

export interface RouteCompilationInput {
  borrowAmount: Decimal;
  fee: Decimal;
  finalBaseAmount: Decimal;
  minProfitBase: Decimal;
  legs: SwapLeg[];
}

/** Builds a deterministic intermediate representation, never a pre-signed BCS transaction. */
export function compileReferenceRoute(input: RouteCompilationInput): SuiRoutePlan {
  if (input.legs.length === 0 || input.legs.length > 3) throw new Error('route must contain one to three swap legs');
  const borrow = decimal(input.borrowAmount, 'borrowAmount');
  const fee = decimal(input.fee, 'fee');
  const finalBase = decimal(input.finalBaseAmount, 'finalBaseAmount');
  const minProfit = decimal(input.minProfitBase, 'minProfitBase');
  if (borrow === 0n) throw new Error('borrowAmount must be positive');
  input.legs.forEach((leg, index) => {
    if (decimal(leg.minAmountOut, `legs[${index}].minAmountOut`) === 0n) throw new Error('every leg requires a non-zero minAmountOut');
  });
  const repayment = borrow + fee;
  if (finalBase < repayment + minProfit) throw new Error('final base amount cannot repay debt and meet min profit');
  const profit = finalBase - repayment;
  const commands: RouteCommand[] = [
    { kind: 'borrow', receipt: 'loan-receipt' },
    ...input.legs.map((leg) => ({ kind: 'swap' as const, minAmountOut: leg.minAmountOut })),
    { kind: 'split-repayment', repayment: repayment.toString(), profit: profit.toString() },
    { kind: 'repay', receipt: 'loan-receipt', amount: repayment.toString() },
    { kind: 'merge-profit' },
    { kind: 'guard-transfer', minProfit: input.minProfitBase }
  ];
  const plan = { repayment: repayment.toString(), profit: profit.toString(), commands };
  assertTerminalCustody(plan);
  return plan;
}

/** Ensures the only post-repayment base-asset sink is the terminal guard. */
export function assertTerminalCustody(plan: SuiRoutePlan): void {
  const borrows = plan.commands.filter((command) => command.kind === 'borrow');
  const repays = plan.commands.filter((command) => command.kind === 'repay');
  if (borrows.length !== 1 || repays.length !== 1 || repays[0].receipt !== borrows[0].receipt) {
    throw new Error('plan must contain one matched borrow and repay receipt');
  }
  const repayIndex = plan.commands.findIndex((command) => command.kind === 'repay');
  const afterRepayment = plan.commands.slice(repayIndex + 1);
  if (afterRepayment.length !== 2 || afterRepayment[0].kind !== 'merge-profit' || afterRepayment[1].kind !== 'guard-transfer') {
    throw new Error('post-repayment base assets must merge into the sole terminal guard input');
  }
}

export interface SuiTradeBinding {
  lender: FlashLender; sender: string; gas: { objectId: string; version: string; digest: string }; gasPrice: string; gasBudget: string; expirationEpoch: string;
  objects: Array<{ objectId: string; version: string; digest: string; initialSharedVersion?: string }>;
  venues: Array<{ poolId: string; packageId: string; globalConfigId: string; adapterRevision: string; packageDigest: string }>;
  guard: { packageId: string; operatorCapId: string; pauseCapId: string };
  adapterId: string; adapterRevision: string; expiresAtMs: number; maxGasCost: string;
}
export interface PreparedSuiTrade {
  schemaVersion: '4.0'; comparison: RouteComparison; transactionBytesBase64: string | null; routeHash: string | null; candidate: RouteCandidate | null;
}
/** Resolve an unsigned Cetus flash-swap PTB entirely from pinned object references. No RPC or signer. */
export async function prepareSuiTrade(inputs: unknown, request: unknown, rawSnapshot: LiquiditySnapshot, binding: SuiTradeBinding): Promise<PreparedSuiTrade> {
  if (!Array.isArray(inputs) || inputs.length > 3) throw new Error('INVALID_SIZING_POOLS');
  const pools = inputs.map(parsePoolState), checked = parseSizingRequest(request), snapshot = parseSnapshot(rawSnapshot);
  if (pools.some(pool => pool.identity.chain !== 'sui' || pool.state.protocol !== 'cetus' || pool.stateClass !== 'canonical') || !snapshot.complete || snapshot.stateDigest !== digest(pools) || pools.some(pool => digest(pool.identity) !== digest(snapshot.identity) || !snapshot.poolIds.includes(pool.poolId))) throw new Error('UNSUPPORTED_SUI_TRADE_STATE');
  if (!binding || Object.keys(binding).sort().join(',') !== 'adapterId,adapterRevision,expirationEpoch,expiresAtMs,gas,gasBudget,gasPrice,guard,lender,maxGasCost,objects,sender,venues' || !Number.isSafeInteger(binding.expiresAtMs) || binding.expiresAtMs <= snapshot.observedAtMs || ![binding.adapterId,binding.adapterRevision].every(v => typeof v === 'string' && v.length > 0 && v.length <= 128) || !uint(binding.maxGasCost,64) || uint(binding.maxGasCost,64) > uint(checked.costInBorrowAsset) || !uint(binding.gasBudget,64) || uint(binding.gasBudget,64) > uint(binding.maxGasCost,64) || !uint(binding.gasPrice,64) || !Array.isArray(binding.objects) || binding.objects.length > 1000 || !Array.isArray(binding.venues) || binding.venues.length !== pools.length) throw new Error('INVALID_SUI_TRADE_BINDING');
  uint(binding.expirationEpoch,64);
  const addr = (id: string) => { if (typeof id !== 'string' || !/^0x[0-9a-f]{64}$/.test(id) || normalizeSuiAddress(id) !== id) throw new Error('INVALID_SUI_TRADE_BINDING'); return id; };
  addr(binding.sender);
  for (const ref of [binding.gas,...binding.objects]) {
    if (!ref || Object.keys(ref).some(k => !['objectId','version','digest','initialSharedVersion'].includes(k)) || !isSuiDigest(ref.digest) || !uint(ref.version,64)) throw new Error('INVALID_SUI_TRADE_OBJECT');
    addr(ref.objectId); if ('initialSharedVersion' in ref && (!uint(ref.initialSharedVersion,64) || uint(ref.initialSharedVersion,64) > uint(ref.version,64))) throw new Error('INVALID_SUI_TRADE_OBJECT');
  }
  if (new Set(binding.objects.map(o => o.objectId)).size !== binding.objects.length || binding.objects.some(o => o.objectId === binding.gas.objectId)) throw new Error('INVALID_SUI_TRADE_OBJECT');
  const venues = new Map(binding.venues.map(v => {
    if (!v || Object.keys(v).sort().join(',') !== 'adapterRevision,globalConfigId,packageDigest,packageId,poolId') throw new Error('INVALID_SUI_TRADE_VENUE');
    addr(v.packageId); addr(v.globalConfigId);
    const pool = pools.find(p => p.poolId === v.poolId);
    if (!pool || pool.adapterRevision !== v.adapterRevision || pool.revisionHash !== v.packageDigest || !isSuiDigest(v.packageDigest)) throw new Error('SUI_TRADE_REVISION_MISMATCH');
    return [v.poolId,v] as const;
  }));
  if (venues.size !== pools.length || !binding.guard || Object.keys(binding.guard).sort().join(',') !== 'operatorCapId,packageId,pauseCapId') throw new Error('INVALID_SUI_TRADE_VENUE');
  Object.values(binding.guard).forEach(addr);
  if (!binding.lender || !['deepbook-v3','navi','scallop'].includes(binding.lender.kind)) throw new Error('SUI_TRADE_LENDER_MISMATCH');
  const lenderFields = binding.lender.kind === 'deepbook-v3' ? ['kind','packageId','poolId','baseType','quoteType','side'] : binding.lender.kind === 'navi' ? ['kind','packageId','poolId','assetType','flashConfigId','storageId'] : ['kind','packageId','marketId','assetType','versionId'];
  if (Object.keys(binding.lender).sort().join(',') !== lenderFields.sort().join(',')) throw new Error('SUI_TRADE_LENDER_MISMATCH');
  for (const [field,value] of Object.entries(binding.lender)) {
    if (field.endsWith('Id')) addr(value);
    if (field.endsWith('Type') && (typeof value !== 'string' || normalizeStructTag(value) !== value)) throw new Error('SUI_TRADE_LENDER_MISMATCH');
  }
  if (binding.lender.kind === 'deepbook-v3' && !['base','quote'].includes(binding.lender.side)) throw new Error('SUI_TRADE_LENDER_MISMATCH');
  const lenderAsset = binding.lender.kind === 'deepbook-v3' ? binding.lender.side === 'base' ? binding.lender.baseType : binding.lender.quoteType : binding.lender.assetType;
  if (normalizeStructTag(lenderAsset) !== checked.borrowAsset || checked.borrowAsset !== normalizeStructTag('0x2::sui::SUI') || (binding.lender.kind === 'deepbook-v3' && uint(checked.flashFeeNumerator))) throw new Error('SUI_TRADE_LENDER_MISMATCH');
  const comparison = compareRouteDirections(pools,checked), selected = comparison.selected, selectedRequest = comparison.selectedRequest;
  if (!selected || !selectedRequest) return { schemaVersion: '4.0',comparison,transactionBytesBase64: null,routeHash: null,candidate: null };
  const routeHash = digest({ snapshot: snapshot.stateDigest,request: selectedRequest,amount: selected.amountIn,venues: binding.venues,lender: binding.lender,guard: binding.guard });
  const tx = new Transaction(); tx.setSender(binding.sender); tx.setGasOwner(binding.sender); tx.setGasPrice(uint(binding.gasPrice,64)); tx.setGasBudget(uint(binding.gasBudget,64)); tx.setGasPayment([binding.gas]); tx.setExpiration({ Epoch: binding.expirationEpoch });
  // Pre-register every input so SDK transaction.object calls never resolve via RPC.
  for (const ref of binding.objects) {
    if (ref.initialSharedVersion !== undefined) tx.sharedObjectRef({ objectId: ref.objectId,initialSharedVersion: ref.initialSharedVersion,mutable: ref.objectId !== normalizeSuiAddress('0x6') && !binding.venues.some(v => v.globalConfigId === ref.objectId) });
    else tx.objectRef(ref);
  }
  const loan = appendFlashBorrow(tx,binding.lender,{ principal: selected.amountIn,fee: selected.flashFee,repayment: selected.repayment });
  let coin = loan.coin;
  for (let i = 0; i < selected.legs.length; i++) {
    const leg = selectedRequest.route[i], pool = pools.find(p => p.poolId === leg.poolId)!, venue = venues.get(leg.poolId)!, quote = selected.legs[i];
    if (pool.state.protocol !== 'cetus') throw new Error('UNSUPPORTED_SUI_TRADE_STATE');
    const a2b = quote.tokenIn === pool.token0, types = [pool.token0,pool.token1];
    // Fixed exact quotes: intermediate surplus cannot disappear outside terminal custody.
    const [input] = tx.splitCoins(coin,[tx.pure.u64(quote.amountIn)]);
    tx.moveCall({ target: '0x2::coin::destroy_zero',typeArguments: [quote.tokenIn],arguments: [coin] });
    const inputBalance = tx.moveCall({ target: '0x2::coin::into_balance',typeArguments: [quote.tokenIn],arguments: [input] });
    const limit = cetusSqrtPriceAtTick(a2b ? pool.state.lowerTick : pool.state.upperTick);
    const [a,b,receipt] = tx.moveCall({ target: `${venue.packageId}::pool::flash_swap`,typeArguments: types,arguments: [tx.object(venue.globalConfigId),tx.object(pool.poolAddress),tx.pure.bool(a2b),tx.pure.bool(true),tx.pure.u64(quote.amountIn),tx.pure.u128(limit),tx.object('0x6')] });
    const zero = tx.moveCall({ target: '0x2::balance::zero',typeArguments: [quote.tokenOut],arguments: [] });
    tx.moveCall({ target: `${venue.packageId}::pool::repay_flash_swap`,typeArguments: types,arguments: [tx.object(venue.globalConfigId),tx.object(pool.poolAddress),a2b ? inputBalance : zero,a2b ? zero : inputBalance,receipt] });
    tx.moveCall({ target: '0x2::balance::destroy_zero',typeArguments: [quote.tokenIn],arguments: [a2b ? a : b] });
    coin = tx.moveCall({ target: '0x2::coin::from_balance',typeArguments: [quote.tokenOut],arguments: [a2b ? b : a] });
  }
  const remainder = loan.repay(coin); if (remainder) tx.mergeCoins(coin,[remainder]);
  tx.moveCall({ target: `${binding.guard.packageId}::terminal_profit_guard::assert_min_profit_and_transfer_with_pause`,typeArguments: [checked.borrowAsset],arguments: [tx.object(binding.guard.operatorCapId),tx.object(binding.guard.pauseCapId),coin,tx.pure.u64(uint(checked.minProfit,64) + uint(checked.costInBorrowAsset,64)),tx.pure.vector('u8',Array.from(Buffer.from(routeHash,'hex')))] });
  if (tx.getData().inputs.some(input => input.$kind !== 'Pure' && input.$kind !== 'Object')) throw new Error('UNRESOLVED_SUI_TRADE_OBJECT');
  const bytes = await tx.build(), transactionBytesBase64 = Buffer.from(bytes).toString('base64');
  const candidate = sizingToCandidate(pools,selectedRequest,selected,snapshot,{ ...binding,unsignedPayload: transactionBytesBase64 });
  return { schemaVersion: '4.0',comparison,transactionBytesBase64,routeHash,candidate };
}
