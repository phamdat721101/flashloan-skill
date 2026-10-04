import type { AllocationPlan, ExecutionDecision, RiskPolicy, SimulationResult } from './types.js';

export function evaluateRisk(
  plan: AllocationPlan,
  simulation: SimulationResult,
  risk: RiskPolicy,
  dailyRealizedLossUsd: number,
  now = new Date()
): ExecutionDecision {
  const reasons: string[] = [];
  if (!simulation.ok) reasons.push(simulation.reason ?? 'exact simulation failed');
  if (Number.isNaN(Date.parse(now.toISOString()))) reasons.push('clock is invalid');
  if (plan.priceImpactBps > risk.maxPriceImpactBps) reasons.push('price impact exceeds limit');
  if ((simulation.gasCostUsd ?? Number.POSITIVE_INFINITY) > risk.maxGasUsd) reasons.push('gas cost exceeds limit');
  if ((simulation.expectedNetProfitUsd ?? Number.NEGATIVE_INFINITY) < risk.minNetProfitUsd) reasons.push('net profit is below floor');
  if (dailyRealizedLossUsd >= risk.maxDailyLossUsd) reasons.push('daily loss stop is active');
  const allocated = plan.legs.reduce((total, leg) => total + leg.allocationBps, 0);
  // EDGE-04: split allocations are rejected unless they preserve the full 10,000-bps boundary.
  if (allocated !== 10_000) reasons.push('allocation legs must total 10,000 bps');
  if (!risk.borrowTiersUsd.includes(plan.borrowTierUsd)) reasons.push('borrow tier is not allowed');
  return { planId: plan.id, allowed: reasons.length === 0, reasons, simulation };
}
