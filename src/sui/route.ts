import { decimal } from './manifest.js';
import type { Decimal, RouteCommand, SuiRoutePlan, SwapLeg } from './types.js';

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
