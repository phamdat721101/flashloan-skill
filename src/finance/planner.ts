import {
  CONTRACT_DIGEST, assetKey, canonicalDigest, compareQuantity, financeHash, insist, intersectConstraints, planHash, requestDigest,
  type Account, type Amount, type Constraints, type Cost, type EvidenceRef, type EvmPayload, type EvmPosition, type Intent, type Network, type Observation, type Permission, type Plan, type XrplLoan, type XrplPayload,
} from './contracts.js';

/** Comparison action as published on the wire (Comparison.actions[]). */
export interface ComparisonAction {
  actionId: string; intent: 'hold' | Intent; admissible: boolean; blockedReasons: string[]; spend: Amount[]; receive: Amount[]; costs: Cost[];
  maxDebtAfter: Amount[]; minCollateralAfter: Amount[]; minSupplyAfter: Amount[]; assumptions: string[];
}
export interface Comparison { positionRef: string; observation: Observation; actions: ComparisonAction[]; coverage: { complete: boolean; missing: Array<{ capability: string; reasonCode: string }>; cursor: string | null } }
export const MAX_CANDIDATES = 8;

/**
 * Deterministic comparison. `hold` is always the zero-action baseline. A candidate is admissible only
 * with complete state, fresh cost evidence and explicit bounds; unknown prices never become zero fees.
 */
export function compare(position: EvmPosition | XrplLoan, intent: 'hold' | Intent, constraints: Constraints, opts: { costs: Cost[] | null; amount: Amount | null; complete: boolean }): Comparison {
  const hold: ComparisonAction = { actionId: financeHash('action', { positionRef: position.positionId, intent: 'hold' }), intent: 'hold', admissible: true, blockedReasons: [], spend: [], receive: [], costs: [], maxDebtAfter: [], minCollateralAfter: [], minSupplyAfter: [], assumptions: ['No transaction; position keeps accruing interest and price risk.'] };
  const actions = [hold];
  if (intent !== 'hold') {
    const reasons: string[] = [];
    if (!opts.complete) reasons.push('COVERAGE_INCOMPLETE');
    if (position.kind === 'xrpl-loan') reasons.push('CAPABILITY_UNAVAILABLE:xls-66-writes-out-of-v1');
    if (!opts.costs) reasons.push('COST_UNKNOWN');
    if (!opts.amount) reasons.push('MISSING_BOUND:amount');
    const spend = opts.amount && (intent === 'repay' || intent === 'earn') ? [opts.amount] : [];
    const receive = opts.amount && (intent === 'withdraw' || intent === 'borrow') ? [opts.amount] : [];
    for (const s of spend) { const b = constraints.maxSpend.find(x => assetKey(x.asset) === assetKey(s.asset)); if (!b) reasons.push('MISSING_BOUND:maxSpend'); else if (compareQuantity(s.quantity, b.quantity) > 0) reasons.push('POLICY_REJECTED:spend'); }
    for (const c of opts.costs ?? []) { const b = constraints.maxCosts.find(x => assetKey(x.asset) === assetKey(c.maximum.asset)); if (!b) reasons.push('MISSING_BOUND:maxCosts'); else if (compareQuantity(c.maximum.quantity, b.quantity) > 0) reasons.push('POLICY_REJECTED:cost'); }
    if (intent === 'earn' && constraints.minSupplyAfter.length === 0) reasons.push('MISSING_BOUND:minSupplyAfter');
    if ((intent === 'repay' || intent === 'protect') && constraints.maxDebtAfter.length === 0) reasons.push('MISSING_BOUND:maxDebtAfter');
    if (intent === 'protect') reasons.push(...(position.kind === 'evm-collateralized' && position.account.family === 'evm' && position.account.model === 'smart-account' ? [] : ['UNSUPPORTED_ACCOUNT_MODEL:protect-requires-position-owning-smart-account']));
    actions.push({
      actionId: financeHash('action', { positionRef: position.positionId, intent, amount: opts.amount }), intent, admissible: reasons.length === 0, blockedReasons: [...new Set(reasons)].slice(0, 20),
      spend, receive, costs: opts.costs ?? [], maxDebtAfter: constraints.maxDebtAfter, minCollateralAfter: constraints.minCollateralAfter, minSupplyAfter: constraints.minSupplyAfter,
      assumptions: ['Protocol rounding applies; savings are not guaranteed.', ...(opts.costs ? [] : ['Fee evidence unavailable; no cost is assumed to be zero.'])],
    });
  }
  insist(actions.length <= MAX_CANDIDATES, 'INVALID_INPUT', 'candidates');
  return { positionRef: position.positionId, observation: position.observation, actions, coverage: { complete: opts.complete, missing: opts.complete ? [] : [{ capability: 'position', reasonCode: 'COVERAGE_INCOMPLETE' }], cursor: null } };
}

/** Research Plan (service side reference). Its planHash binds every field; it never carries authority. */
export function buildPlan(input: {
  request: unknown; network: Network; account: Account; positionRef: string | null; comparisonRef: string | null; intent: Intent; adapterRef: string; observation: Observation;
  requested: Constraints; policy: Constraints; permissions: Permission[]; costs: Cost[]; payload: EvmPayload | XrplPayload; expiresAt: string; evidence: EvidenceRef[];
}): Plan {
  const body: Omit<Plan, 'planHash'> = {
    schemaVersion: 'finance.plan/1', requestDigest: requestDigest(input.request), contractDigest: CONTRACT_DIGEST, network: input.network, account: input.account,
    positionRef: input.positionRef, comparisonRef: input.comparisonRef, intent: input.intent, adapterRef: input.adapterRef, observation: input.observation,
    requestedConstraints: input.requested, effectiveConstraints: intersectConstraints(input.policy, input.requested), permissions: input.permissions, costs: input.costs,
    nativePayload: input.payload, expiresAt: input.expiresAt, evidence: input.evidence, execution: false,
  };
  return { ...body, planHash: planHash(body) } as Plan;
}
export const comparisonRef = (c: Comparison) => canonicalDigest(c);
