import { randomUUID } from 'node:crypto';
import { AttemptJournal } from './journal.js';
import { digest, isSuiDigest, SnapshotStore, uint, type StateIdentity } from './state.js';

export interface RouteCandidate {
  identity: StateIdentity;
  stateDigest: string;
  poolIds: string[];
  adapterId: string;
  adapterRevision: string;
  payloadDigest: string;
  borrowAmount: string;
  profitAsset: string;
  minProfit: string;
  maxGasCost: string;
  expiresAtMs: number;
}
export interface SimulationProof {
  candidateDigest: string;
  payloadDigest: string;
  stateDigest: string;
  success: boolean;
  profitAfterDebt: string;
  conservativeGasCostInProfitAsset: string;
}
export interface Admission {
  chain: StateIdentity['chain']; network: string; revision: string; expiresAtMs: number;
  evidence: { schema: string; math: string; simulation: string; canary: string };
}
export interface LiquidityExecutionAdapter {
  admission: Admission;
  simulate(candidate: RouteCandidate, signal?: AbortSignal): Promise<SimulationProof>;
  preflight(candidate: RouteCandidate, signal?: AbortSignal): Promise<SimulationProof>;
  resource(candidate: RouteCandidate, signal?: AbortSignal): Promise<string>;
  /** Sign only final inputs. Callers must never mutate or log the returned bytes. */
  sign(candidate: RouteCandidate, resource: string, signal?: AbortSignal): Promise<{ transactionId: string; signedBytes: Uint8Array; resource: string; payloadDigest: string }>;
  submit(signedBytes: Uint8Array, signal?: AbortSignal): Promise<string>;
  receipt(transactionId: string, signal?: AbortSignal): Promise<{ transactionId: string; source: string; executionStatus: 'success' | 'revert'; repaymentProven: boolean; profitTransferProven: boolean; profitCustodyProven?: boolean; gasCostInProfitAsset: string; profitAfterDebt: string; executionEvidence?: { kind: string; reconciliation: 'RECONCILED' | 'UNKNOWN' | 'MISMATCH'; transaction: { tx_hash: string | null } } } | null>;
}
export interface RuntimePolicy { concurrency: number; maxCandidates: number; maxDailyLoss: string; minProfit: string; budgetAssets: Record<string, string>; mode: 'shadow' | 'auto'; stepTimeoutMs?: number }
export interface LiquidityDecision { candidateDigest: string; status: 'rejected' | 'simulated' | 'reconciled' | 'halted'; code: string; attemptId?: string }

/** Simulation workers share immutable inputs; only an admitted exact proof enters the signing lane. */
export class LiquidityRuntime {
  constructor(private readonly snapshots: SnapshotStore, private readonly journal: AttemptJournal, private readonly adapters: ReadonlyMap<string, LiquidityExecutionAdapter>, private readonly now = Date.now) {}
  private async step<T>(timeout: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('ADAPTER_TIMEOUT')); controller.abort(); }, timeout); });
    try { return await Promise.race([operation(controller.signal), deadline]); }
    finally { clearTimeout(timer); }
  }
  private validate(c: RouteCandidate, a: LiquidityExecutionAdapter, p: RuntimePolicy): void {
    const time = this.now(), state = this.snapshots.current(c.identity, time), admission = a.admission;
    if (state.stateDigest !== c.stateDigest || !c.poolIds.length || c.poolIds.some(id => !state.poolIds.includes(id))) throw new Error('STATE_COVERAGE_INCOMPLETE');
    if (admission.chain !== c.identity.chain || admission.network !== c.identity.network || admission.revision !== c.adapterRevision || !Number.isSafeInteger(admission.expiresAtMs) || time >= admission.expiresAtMs || ['schema', 'math', 'simulation', 'canary'].some(k => typeof admission.evidence[k as keyof typeof admission.evidence] !== 'string' || !admission.evidence[k as keyof typeof admission.evidence])) throw new Error('UNPROVEN_CAPABILITY');
    const lane = `${c.identity.chain}:${c.identity.network}`;
    if (!c.profitAsset?.startsWith(`${lane}:`) || p.budgetAssets[lane] !== c.profitAsset) throw new Error('BUDGET_ASSET_MISMATCH');
    if (!/^[a-f0-9]{64}$/.test(c.payloadDigest) || !Number.isSafeInteger(c.expiresAtMs) || time >= c.expiresAtMs) throw new Error('EXPIRED_OR_INVALID_ROUTE');
    if (uint(c.borrowAmount) === 0n || uint(c.minProfit) < uint(p.minProfit) || uint(c.maxGasCost) === 0n) throw new Error('INVALID_ROUTE_BUDGET');
  }
  private net(c: RouteCandidate, proof: SimulationProof): bigint {
    if (!proof.success || proof.candidateDigest !== digest(c) || proof.payloadDigest !== c.payloadDigest || proof.stateDigest !== c.stateDigest) throw new Error('SIMULATION_PROOF_MISMATCH');
    const gas = uint(proof.conservativeGasCostInProfitAsset), profit = uint(proof.profitAfterDebt);
    if (gas > uint(c.maxGasCost) || profit < gas + uint(c.minProfit)) throw new Error('INSUFFICIENT_NET_PROFIT');
    return profit - gas;
  }
  async run(input: readonly RouteCandidate[], policy: RuntimePolicy, admissionGate?: (candidate: RouteCandidate, signal: AbortSignal) => Promise<void>): Promise<LiquidityDecision[]> {
    const timeout = policy.stepTimeoutMs ?? 15000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error('INVALID_RUNTIME_TIMEOUT');
    if (!Number.isSafeInteger(policy.concurrency) || policy.concurrency < 1 || policy.concurrency > 64 || !Number.isSafeInteger(policy.maxCandidates) || policy.maxCandidates < 1 || input.length > policy.maxCandidates || !['shadow', 'auto'].includes(policy.mode) || uint(policy.maxDailyLoss) === 0n || uint(policy.minProfit) === 0n) throw new Error('INVALID_RUNTIME_POLICY');
    const candidates = structuredClone(input), decisions: LiquidityDecision[] = [], eligible: Array<{ c: RouteCandidate; a: LiquidityExecutionAdapter; net: bigint }> = [];
    for (const c of candidates) { Object.freeze(c.identity); Object.freeze(c.poolIds); Object.freeze(c); }
    let cursor = 0, stopped = false;
    await Promise.all(Array.from({ length: Math.min(policy.concurrency, candidates.length) }, async () => {
      while (cursor < candidates.length && !stopped) {
        const c = candidates[cursor++], id = digest(c), a = this.adapters.get(c.adapterId);
        try {
          if (!a) throw new Error('UNSUPPORTED_CAPABILITY');
          this.validate(c, a, policy);
          const proof = await this.step(timeout, signal => a.simulate(c, signal));
          this.validate(c, a, policy);
          const net = this.net(c, proof);
          eligible.push({ c, a, net }); decisions.push({ candidateDigest: id, status: 'simulated', code: 'SIMULATION_VALID' });
        } catch (e) { if (errorCode(e) === 'ADAPTER_TIMEOUT') stopped = true; decisions.push({ candidateDigest: id, status: 'rejected', code: errorCode(e) }); }
      }
    }));
    for (; cursor < candidates.length; cursor++) decisions.push({ candidateDigest: digest(candidates[cursor]), status: 'rejected', code: 'SIMULATION_BATCH_ABORTED' });
    if (policy.mode === 'shadow') return decisions;
    const winners = new Map<string, typeof eligible[number]>();
    for (const entry of eligible.sort((x, y) => x.net === y.net ? digest(x.c).localeCompare(digest(y.c)) : x.net > y.net ? -1 : 1)) {
      const lane = `${entry.c.identity.chain}:${entry.c.identity.network}`;
      if (!winners.has(lane)) winners.set(lane, entry);
    }
    // Separate chains have separate signing resources and loss budgets. A slow
    // receipt on one lane must not prevent the other lane from progressing.
    await Promise.all(Array.from(winners, async ([lane, { c, a }]) => {
      const candidateDigest = digest(c), attemptId = randomUUID(); let prepared = false; let transactionId: string | null = null; let actualLoss: bigint | undefined;
      try {
        this.validate(c, a, policy); this.net(c, await this.step(timeout, signal => a.preflight(c, signal))); this.validate(c, a, policy);
        const resource = await this.step(timeout, signal => a.resource(c, signal));
        if (!resource || resource.length > 256) throw new Error('INVALID_SIGNING_RESOURCE');
        this.validate(c, a, policy);
        await this.journal.prepare({ id: attemptId, lane, budgetAsset: c.profitAsset, candidateDigest, resource, state: 'prepared', transactionId: null, loss: c.maxGasCost, day: new Date(this.now()).toISOString().slice(0, 10) }, uint(policy.maxDailyLoss), uint(c.maxGasCost)); prepared = true;
        this.validate(c, a, policy);
        if (admissionGate) await this.step(timeout, signal => admissionGate(c, signal));
        this.validate(c, a, policy);
        const signed = await this.step(timeout, signal => a.sign(c, resource, signal));
        const validId = c.identity.chain !== 'sui' ? /^0x[0-9a-f]{64}$/.test(signed.transactionId) : isSuiDigest(signed.transactionId);
        if (!validId || !(signed.signedBytes instanceof Uint8Array) || signed.signedBytes.length === 0 || signed.resource !== resource || signed.payloadDigest !== c.payloadDigest) throw new Error('INVALID_SIGNED_TRANSACTION');
        transactionId = signed.transactionId;
        await this.journal.transition(attemptId, 'signed', transactionId);
        this.validate(c, a, policy);
        if (admissionGate) await this.step(timeout, signal => admissionGate(c, signal));
        this.validate(c, a, policy);
        const submitted = await this.step(timeout, signal => a.submit(signed.signedBytes, signal));
        if (submitted !== transactionId) throw new Error('SUBMISSION_ID_MISMATCH');
        await this.journal.transition(attemptId, 'submitted', transactionId);
        const receipt = await this.step(timeout, signal => a.receipt(transactionId!, signal));
        if (!receipt || receipt.transactionId !== transactionId || !receipt.source || !['success', 'revert'].includes(receipt.executionStatus) || (receipt.executionStatus === 'success' && (!receipt.repaymentProven || !(receipt.profitTransferProven === true || receipt.profitCustodyProven === true)))) throw new Error('PNL_UNKNOWN');
        // v6 all-asset reconciliation, when the host supplies it, must agree before any accounting is trusted.
        const evidence = receipt.executionEvidence;
        if (evidence && (evidence.kind !== 'RECEIPT_RECONCILED' || evidence.reconciliation !== 'RECONCILED' || evidence.transaction.tx_hash?.toLowerCase() !== transactionId.toLowerCase())) throw new Error('PNL_UNKNOWN');
        const gas = uint(receipt.gasCostInProfitAsset), profit = uint(receipt.profitAfterDebt);
        if (receipt.executionStatus === 'revert' && profit !== 0n) throw new Error('PNL_UNKNOWN');
        actualLoss = gas > profit ? gas - profit : 0n;
        if (gas > uint(c.maxGasCost)) throw new Error('ACTUAL_GAS_EXCEEDED_BUDGET');
        if (receipt.executionStatus === 'success' && profit < gas + uint(c.minProfit)) throw new Error('ACTUAL_PROFIT_BELOW_FLOOR');
        await this.journal.transition(attemptId, 'reconciled', transactionId, actualLoss);
        decisions.push({ candidateDigest, status: 'reconciled', code: receipt.executionStatus === 'revert' ? 'REVERT_GAS_ACCOUNTED' : 'RECEIPT_ACCOUNTED', attemptId });
      } catch (e) {
        if (prepared) await this.journal.transition(attemptId, 'halted', transactionId, actualLoss);
        decisions.push({ candidateDigest, status: prepared ? 'halted' : 'rejected', code: errorCode(e), ...(prepared ? { attemptId } : {}) });
      }
    }));
    return decisions.sort((x, y) => x.candidateDigest.localeCompare(y.candidateDigest));
  }
}
function errorCode(e: unknown): string { return e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'ADAPTER_FAILURE'; }
