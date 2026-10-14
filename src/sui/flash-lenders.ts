import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { normalizeSuiAddress, normalizeStructTag } from '@mysten/sui/utils';
import { uint } from '../liquidity/state.js';

export type FlashLender =
  | { kind: 'deepbook-v3'; packageId: string; poolId: string; baseType: string; quoteType: string; side: 'base' | 'quote' }
  | { kind: 'navi'; packageId: string; poolId: string; assetType: string; flashConfigId: string; storageId: string }
  | { kind: 'scallop'; packageId: string; marketId: string; assetType: string; versionId: string };
export interface FlashDebt { principal: string; fee: string; repayment: string }
export interface FlashBorrow {
  coin: TransactionObjectArgument;
  /** Receipt remains opaque; only the matching repayment operation may consume it. */
  repay(coin: TransactionObjectArgument): TransactionObjectArgument | undefined;
}

function address(v: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new Error('INVALID_SUI_ADDRESS');
  return normalizeSuiAddress(v);
}
function type(v: string): string {
  if (!v.includes('::')) throw new Error('INVALID_ASSET_TYPE');
  return normalizeStructTag(v);
}
/** Compiler primitive only: registry admission, exact live fees and PTB simulation are mandatory upstream. */
export function appendFlashBorrow(tx: Transaction, lender: FlashLender, debt: FlashDebt): FlashBorrow {
  const principal = uint(debt.principal, 64), fee = uint(debt.fee, 64), repayment = uint(debt.repayment, 64);
  if (principal === 0n || principal + fee !== repayment) throw new Error('INVALID_FLASH_DEBT');
  const packageId = address(lender.packageId);
  let receipt: TransactionObjectArgument, coin: TransactionObjectArgument;
  let repayCoin: (value: TransactionObjectArgument) => TransactionObjectArgument | undefined;
  if (lender.kind === 'deepbook-v3') {
    if (fee !== 0n || !['base', 'quote'].includes(lender.side)) throw new Error('INVALID_DEEPBOOK_DEBT');
    const args = [type(lender.baseType), type(lender.quoteType)], pool = address(lender.poolId);
    [coin, receipt] = tx.moveCall({ target: `${packageId}::pool::borrow_flashloan_${lender.side}`, typeArguments: args, arguments: [tx.object(pool), tx.pure.u64(principal)] });
    repayCoin = value => {
      tx.moveCall({ target: `${packageId}::pool::return_flashloan_${lender.side}`, typeArguments: args, arguments: [tx.object(pool), value, receipt] });
      return undefined;
    };
  } else if (lender.kind === 'navi') {
    const args = [type(lender.assetType)], pool = address(lender.poolId);
    const [balance, ticket] = tx.moveCall({ target: `${packageId}::lending::flash_loan_with_ctx_v2`, typeArguments: args, arguments: [tx.object(address(lender.flashConfigId)), tx.object(pool), tx.pure.u64(principal), tx.object('0x5')] });
    receipt = ticket;
    coin = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: args, arguments: [balance] });
    repayCoin = value => {
      const balance = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: args, arguments: [value] });
      const remainder = tx.moveCall({ target: `${packageId}::lending::flash_repay_with_ctx`, typeArguments: args, arguments: [tx.object('0x6'), tx.object(address(lender.storageId)), tx.object(pool), receipt, balance] });
      return tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: args, arguments: [remainder] });
    };
  } else if (lender.kind === 'scallop') {
    const args = [type(lender.assetType)], version = address(lender.versionId), market = address(lender.marketId);
    [coin, receipt] = tx.moveCall({ target: `${packageId}::flash_loan::borrow_flash_loan`, typeArguments: args, arguments: [tx.object(version), tx.object(market), tx.pure.u64(principal)] });
    repayCoin = value => {
      tx.moveCall({ target: `${packageId}::flash_loan::repay_flash_loan`, typeArguments: args, arguments: [tx.object(version), tx.object(market), value, receipt] });
      return undefined;
    };
  } else throw new Error('UNSUPPORTED_FLASH_LENDER');
  let consumed = false;
  return { coin, repay: value => {
    if (consumed) throw new Error('FLASH_RECEIPT_ALREADY_CONSUMED');
    // Always split the exact debt: DeepBook rejects excess; Scallop transfers it outside the guard.
    const [exactDebt] = tx.splitCoins(value, [tx.pure.u64(repayment)]);
    const remainder = repayCoin(exactDebt); consumed = true;
    return remainder;
  } };
}
