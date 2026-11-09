import {
  CONTRACT_DIGEST, FinanceError, assetKey, canonicalDigest, checkObservation, checkPlan, compareQuantity, financeHash, insist, intersectConstraints, localPlanHash,
  parseTimestamp, requireBounds, toErrorRecord, validate,
  type ApprovalGrant, type Digest, type LocalPlan, type LocalRequest, type LocalResult, type Plan, type Receipt, type Simulation,
} from './contracts.js';
import { admitAction, policyConstraints, verifyGrant, type LoadedProfile } from './config.js';
import { FinanceJournal, admitNewAction, reservedOnDay, type ActionRecord } from './journal.js';
import type { FinanceAdapter, FinanceSigner } from './adapter.js';

export interface FinanceRuntimeDeps {
  profile: LoadedProfile; adapters: Partial<Record<Plan['network'], FinanceAdapter>>; signer?: (plan: LocalPlan) => Promise<FinanceSigner>;
  journal?: FinanceJournal; now?: () => number;
}
/** Fields an LocalPlan refresh may change without a new research Plan (fee/nonce/sequence/ledger bound). */
const REFRESHABLE = new Set(['nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'Fee', 'Sequence', 'TicketSequence', 'LastLedgerSequence']);

/**
 * Local Finance state machine: import → simulate (LocalPlan) → owner grant → execute → reconcile.
 * Outcome `ok` for import/simulate never means funds moved; ambiguous sends become UNKNOWN, never a resend.
 */
export class FinanceRuntime {
  readonly journal: FinanceJournal;
  readonly now: () => number;
  constructor(readonly deps: FinanceRuntimeDeps) {
    this.now = deps.now ?? Date.now;
    this.journal = deps.journal ?? new FinanceJournal(deps.profile.stateDirectory, this.now);
  }

  async run(input: unknown): Promise<LocalResult> {
    let requestId = 'invalid';
    try {
      insist(this.deps.profile.profile.enabled, 'FEATURE_DISABLED');
      const r = validate<LocalRequest>('LocalRequest', input); requestId = r.requestId;
      insist(r.contractDigest === CONTRACT_DIGEST, 'CONTRACT_MISMATCH');
      switch (r.command) {
        case 'import-plan': return this.result(r.requestId, 'ok', { planRef: await this.importPlan(r.plan) });
        case 'simulate': return await this.simulate(r.requestId, r.planRef, r.policyRef);
        case 'execute': return await this.execute(r.requestId, r.localPlanRef, r.policyRef, r.approvalRef);
        case 'reconcile': return await this.reconcile(r.requestId, r.actionId, r.policyRef);
      }
    } catch (e) {
      const record = toErrorRecord(e);
      // Bounded stderr diagnostics: typed code/detail only, never request bodies or credentials.
      if (process.env.FINANCE_DEBUG === '1') process.stderr.write(`finance ${requestId}: ${e instanceof FinanceError ? e.message : (e as Error)?.message ?? 'error'}\n`.slice(0, 500));
      return this.result(requestId, record.code === 'SUBMISSION_UNKNOWN' ? 'unknown' : (e instanceof FinanceError ? 'blocked' : 'failed'), { errors: [record] });
    }
  }

  async importPlan(input: unknown): Promise<Digest> {
    const plan = validate<Plan>('Plan', input);
    checkPlan(plan, this.now());
    await this.journal.append('plan', plan);
    return plan.planHash;
  }

  /** Owner-host command (outside the wire request set): records a signed grant and reserves its nonce. */
  async recordGrant(input: unknown): Promise<Digest> {
    const g = validate<ApprovalGrant>('ApprovalGrant', input);
    const s = await this.journal.state();
    const local = s.localPlans.get(g.localPlanHash); insist(local, 'APPROVAL_REQUIRED', 'unknown-local-plan');
    verifyGrant(this.deps.profile, g, local.plan, this.now());
    await this.journal.append('grant', g);
    return g.grantId;
  }

  private adapter(network: Plan['network']): FinanceAdapter { const a = this.deps.adapters[network]; insist(a, 'CAPABILITY_UNAVAILABLE', `adapter:${network}`); return a; }
  private policy(policyRef: Digest) { insist(policyRef === this.deps.profile.profile.policyHash, 'POLICY_REJECTED', 'policy-ref'); }

  private async simulate(requestId: string, planRef: Digest, policyRef: Digest): Promise<LocalResult> {
    this.policy(policyRef);
    const now = this.now(), s = await this.journal.state();
    const plan = s.plans.get(planRef); insist(plan, 'INVALID_INPUT', 'unknown-plan');
    checkPlan(plan, now);
    insist(parseTimestamp(plan.expiresAt) > now, 'EXPIRED_PLAN');
    admitAction(this.deps.profile, plan.network, plan.intent, plan.account, { write: false });
    const adapter = this.adapter(plan.network);
    const pins = await adapter.admitPayload(plan);
    const fresh = await adapter.freshPayload(plan.nativePayload);
    assertOnlyRefreshable(plan.nativePayload, fresh.payload);
    checkObservation(fresh.observation, plan.network, this.now(), { admission: true });
    const effective = intersectConstraints(policyConstraints(this.deps.profile.profile, plan.network), plan.effectiveConstraints);
    const costs = [...plan.costs.filter(c => c.kind !== fresh.cost.kind), fresh.cost];
    const planned = plan.costs.find(c => c.kind === fresh.cost.kind);
    insist(!planned || compareQuantity(fresh.cost.maximum.quantity, planned.maximum.quantity) <= 0, 'STALE_STATE', 'fee-above-research-maximum');
    if (this.deps.profile.approvalKey) pins.push({ kind: 'approval-key', id: 'owner', hash: canonicalDigest(this.deps.profile.approvalKey.export({ type: 'spki', format: 'der' }).toString('hex')) });
    const expiresAt = new Date(Math.min(parseTimestamp(plan.expiresAt), parseTimestamp(fresh.observation.expiresAt), now + effective.maxStateAgeSeconds * 1000)).toISOString();
    const body: Omit<LocalPlan, 'localPlanHash'> = {
      schemaVersion: 'finance.local-plan/1', researchPlanHash: plan.planHash, policyHash: this.deps.profile.profile.policyHash, contractDigest: CONTRACT_DIGEST,
      network: plan.network, account: plan.account, adapterRef: plan.adapterRef, observation: fresh.observation, effectiveConstraints: effective, costs,
      nativePayload: fresh.payload, pins, requiredFinality: plan.network === 'xrpl' ? 'validated' : 'finalized', expiresAt,
    };
    const local = validate<LocalPlan>('LocalPlan', { ...body, localPlanHash: localPlanHash(body) });
    const sim = await adapter.simulateExact(local);
    requireBounds(effective, sim.expectedSpend, costs);
    const simulation: Simulation = {
      planHash: plan.planHash, localPlanHash: local.localPlanHash, fidelity: sim.fidelity, pass: sim.pass, expectedSpend: sim.expectedSpend, expectedReceive: sim.expectedReceive,
      nativeStateRef: sim.observation.sources[0] ?? { id: canonicalDigest(sim.observation), contentHash: canonicalDigest(sim.observation), expiresAt: sim.observation.expiresAt },
      postconditionsPass: sim.postconditionsPass, errors: sim.errors.slice(0, 20),
    };
    validate('Simulation', simulation);
    await this.journal.append('local-plan', { plan: local, simulation });
    const ok = sim.pass && sim.postconditionsPass;
    return this.result(requestId, ok ? 'ok' : 'blocked', { planRef: plan.planHash, localPlanRef: local.localPlanHash, simulation, errors: ok ? [] : [toErrorRecord(new FinanceError('SIMULATION_FAILED'))] });
  }

  private async execute(requestId: string, localPlanRef: Digest, policyRef: Digest, approvalRef: Digest): Promise<LocalResult> {
    this.policy(policyRef);
    const s0 = await this.journal.state();
    const entry = s0.localPlans.get(localPlanRef); insist(entry, 'INVALID_INPUT', 'unknown-local-plan');
    const { plan: local, simulation } = entry, research = s0.plans.get(local.researchPlanHash)!;
    insist(local.localPlanHash === localPlanHash(local), 'INVALID_INPUT', 'local-plan-hash');
    admitAction(this.deps.profile, local.network, research.intent, local.account, { write: true });
    insist(simulation.fidelity === 'native' && simulation.pass && simulation.postconditionsPass, 'SIMULATION_FAILED', 'non-native-or-failed-simulation');
    return this.journal.lease(local.account, local.network, async () => {
      const s = await this.journal.state(), now = this.now();
      insist(parseTimestamp(local.expiresAt) > now, 'EXPIRED_PLAN');
      const grant = s.grants.get(approvalRef); insist(grant, 'APPROVAL_REQUIRED', 'unknown-grant');
      insist(!s.consumedGrants.has(grant.grantId), 'APPROVAL_REPLAY');
      verifyGrant(this.deps.profile, grant, local, now);
      const reservation = local.costs.filter(c => c.payer === 'user').map(c => c.maximum);
      const day = new Date(now).toISOString().slice(0, 10);
      for (const r of reservation) {
        const cap = this.deps.profile.profile.maxDailyNativeCost.find(c => assetKey(c.asset) === assetKey(r.asset)); insist(cap && cap.quantity.kind === 'atomic' && r.quantity.kind === 'atomic', 'MISSING_BOUND', 'maxDailyNativeCost');
        insist(reservedOnDay(s, day, r.asset) + BigInt(r.quantity.value) <= BigInt(cap.quantity.value), 'POLICY_REJECTED', 'daily-cost-budget');
      }
      const sender = local.nativePayload.kind === 'evm' ? local.nativePayload.from : local.nativePayload.tx.Account;
      const nativeSequence = local.nativePayload.kind === 'evm' ? local.nativePayload.nonce : String(local.nativePayload.tx.TicketSequence ?? local.nativePayload.tx.Sequence);
      admitNewAction(s, { account: local.account, network: local.network, sender, nativeSequence }); // before any signer access
      const adapter = this.adapter(local.network);
      // Re-simulate against current state immediately before signing; no bytes are patched.
      const again = await adapter.simulateExact(local);
      insist(again.pass && again.postconditionsPass, 'SIMULATION_FAILED', 'pre-sign-simulation');
      insist(this.deps.signer, 'PERMISSION_MISSING', 'signer');
      const signer = await this.deps.signer(local);
      const signed = await signer.sign(local);
      const { transactionId } = adapter.validateSignedArtifact(local, signed);
      const actionId = financeHash('action', { localPlanHash: local.localPlanHash, grantId: grant.grantId });
      const record: ActionRecord = { actionId, sender, planHash: local.researchPlanHash, localPlanHash: local.localPlanHash, grantId: grant.grantId, account: local.account, network: local.network, state: 'SUBMITTING', transactionId, nativeSequence, reservation, day, reconciliation: 'PENDING', effects: [] };
      await this.journal.storeSigned(actionId, signed);
      await this.journal.append('action', record); // durable SUBMITTING intent before any network send
      try {
        const sent = await adapter.submitKnownArtifact(signed);
        insist(sent.toLowerCase() === transactionId.toLowerCase(), 'RECONCILIATION_MISMATCH', 'submitted-hash');
        await this.journal.append('transition', { actionId, state: 'SUBMITTED' });
      } catch (e) {
        if (e instanceof FinanceError && e.code === 'RECONCILIATION_MISMATCH') { await this.journal.append('transition', { actionId, state: 'HALTED' }); throw e; }
        await this.journal.append('transition', { actionId, state: 'UNKNOWN' });
        return this.result(requestId, 'unknown', { planRef: local.researchPlanHash, localPlanRef: local.localPlanHash, receipt: this.receipt({ ...record, state: 'UNKNOWN' }), errors: [toErrorRecord(new FinanceError('SUBMISSION_UNKNOWN'))] });
      }
      return this.result(requestId, 'ok', { planRef: local.researchPlanHash, localPlanRef: local.localPlanHash, receipt: this.receipt({ ...record, state: 'SUBMITTED' }) });
    });
  }

  /** Queries only the known reference. Never rebuilds, resends or releases a sent reservation. */
  private async reconcile(requestId: string, actionId: Digest, policyRef: Digest): Promise<LocalResult> {
    this.policy(policyRef);
    const s = await this.journal.state();
    const action = s.actions.get(actionId); insist(action, 'INVALID_INPUT', 'unknown-action');
    const local = s.localPlans.get(action.localPlanHash)!.plan;
    insist(action.transactionId, 'SUBMISSION_UNKNOWN', 'no-known-reference');
    if (['FINALIZED', 'FAILED', 'HALTED', 'EXPIRED'].includes(action.state)) return this.result(requestId, action.state === 'HALTED' ? 'blocked' : 'ok', { planRef: action.planHash, localPlanRef: action.localPlanHash, receipt: this.receipt(action) });
    const r = await this.adapter(local.network).reconcileKnownReference(local, action.transactionId);
    const state = r.reconciliation === 'MISMATCH' ? 'HALTED' : r.state;
    if (state !== action.state || r.reconciliation !== action.reconciliation) await this.journal.append('transition', { actionId, state, reconciliation: r.reconciliation, effects: r.effects });
    const updated: ActionRecord = { ...action, state, reconciliation: r.reconciliation, effects: r.effects };
    const outcome = state === 'HALTED' ? 'blocked' : state === 'UNKNOWN' ? 'unknown' : 'ok';
    const errors = state === 'HALTED' ? [toErrorRecord(new FinanceError('RECONCILIATION_MISMATCH'))] : state === 'UNKNOWN' ? [toErrorRecord(new FinanceError('SUBMISSION_UNKNOWN'))] : [];
    return this.result(requestId, outcome, { planRef: action.planHash, localPlanRef: action.localPlanHash, receipt: this.receipt(updated, r.evidence), errors });
  }

  private receipt(a: ActionRecord, evidence: Receipt['evidence'] = []): Receipt {
    return { actionId: a.actionId, planHash: a.planHash, localPlanHash: a.localPlanHash, network: a.network, transactionId: a.transactionId, state: a.state, verification: 'local-reported', effects: a.effects, reconciliation: a.reconciliation, evidence };
  }
  private result(requestId: string, outcome: LocalResult['outcome'], part: Partial<LocalResult>): LocalResult {
    const out: LocalResult = { schemaVersion: 'finance.local-result/1', contractDigest: CONTRACT_DIGEST, requestId: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId) ? requestId : 'invalid', outcome, planRef: null, localPlanRef: null, simulation: null, receipt: null, errors: [], ...part };
    return validate<LocalResult>('LocalResult', out);
  }
}

/** A refresh may change fee/nonce/sequence fields only; any other byte needs a fresh research Plan. */
function assertOnlyRefreshable(before: LocalPlan['nativePayload'], after: LocalPlan['nativePayload']): void {
  const flat = (p: LocalPlan['nativePayload']) => p.kind === 'evm' ? { ...p } as Record<string, unknown> : { kind: p.kind, networkIdentityHash: p.networkIdentityHash, ...p.tx } as Record<string, unknown>;
  const a = flat(before), b = flat(after);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!REFRESHABLE.has(k)) insist(canonicalDigest(a[k] ?? null) === canonicalDigest(b[k] ?? null), 'STALE_STATE', `payload-field-changed:${k}`);
}
