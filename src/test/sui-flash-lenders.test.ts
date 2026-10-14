import assert from 'node:assert/strict';
import test from 'node:test';
import { Transaction } from '@mysten/sui/transactions';
import { appendFlashBorrow, type FlashLender } from '../sui/flash-lenders.js';

const lenders: FlashLender[] = [
  { kind: 'deepbook-v3', packageId: '0x1', poolId: '0x2', baseType: '0x2::sui::SUI', quoteType: '0x3::usdc::USDC', side: 'base' },
  { kind: 'deepbook-v3', packageId: '0x1', poolId: '0x2', baseType: '0x2::sui::SUI', quoteType: '0x3::usdc::USDC', side: 'quote' },
  { kind: 'navi', packageId: '0x1', poolId: '0x2', assetType: '0x2::sui::SUI', flashConfigId: '0x3', storageId: '0x4' },
  { kind: 'scallop', packageId: '0x1', marketId: '0x2', assetType: '0x2::sui::SUI', versionId: '0x3' }
];
for (const lender of lenders) test(`compiler ${lender.kind} ${'side' in lender ? lender.side : ''} consumes its own receipt once and splits exact debt`, () => {
  const tx = new Transaction(), fee = lender.kind === 'deepbook-v3' ? '0' : '2';
  const loan = appendFlashBorrow(tx, lender, { principal: '100', fee, repayment: fee === '0' ? '100' : '102' });
  const remainder = loan.repay(loan.coin);
  assert.throws(() => loan.repay(loan.coin), /ALREADY_CONSUMED/);
  const commands = tx.getData().commands;
  assert.equal(commands.filter(c => c.$kind === 'SplitCoins').length, 1);
  const calls = commands.filter(c => c.$kind === 'MoveCall').map(c => c.MoveCall!);
  assert.ok(calls[0].function.includes('borrow') || calls[0].function.includes('flash_loan'));
  if (lender.kind === 'navi') {
    assert.ok(remainder); assert.equal(calls.filter(c => c.function === 'flash_repay_with_ctx').length, 1);
    assert.equal(calls.filter(c => c.function === 'from_balance').length, 2);
  } else {
    assert.equal(remainder, undefined); assert.ok(calls.at(-1)!.function.includes(lender.kind === 'scallop' ? 'repay' : 'return'));
  }
  assert.equal(commands.filter(c => c.$kind === 'TransferObjects').length, 0);
});

test('rejects invalid debt, u64 overflow, unsupported lender and missing flash-loan evidence assumptions', () => {
  const tx = new Transaction();
  assert.throws(() => appendFlashBorrow(tx, lenders[0], { principal: '100', fee: '1', repayment: '101' }), /INVALID_DEEPBOOK/);
  assert.throws(() => appendFlashBorrow(tx, lenders[2], { principal: '100', fee: '2', repayment: '101' }), /INVALID_FLASH_DEBT/);
  assert.throws(() => appendFlashBorrow(tx, lenders[0], { principal: (1n << 64n).toString(), fee: '0', repayment: '100' }), /OUT_OF_RANGE/);
  assert.throws(() => appendFlashBorrow(tx, { ...lenders[0], kind: 'suilend' } as unknown as FlashLender, { principal: '100', fee: '0', repayment: '100' }), /UNSUPPORTED/);
});
