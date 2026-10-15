import { digest, uint } from './state.js';
import { parseFrame, ns, type MicrostructureFrame, type PredictionRecord } from './l2-contracts.js';
import type { EvaluationReport } from './l2-prediction.js';
import type { LiquidityRuntime, RouteCandidate, RuntimePolicy, LiquidityDecision } from './runtime.js';
import { ExecutionLock } from '../execution-lock.js';
import { readSourceLines } from './ingestion.js';
import { durableAppend } from './l2-ingestion.js';

export interface ExecutionContextBinding {
  candidateDigest: string; frameId: string; prediction: PredictionRecord | null;
  report: EvaluationReport | null; approvedReportId: string | null; expiresAtNs: string;
  riskSizing?: { riskDigest: string; unscaledMaximum: string };
}
export function validatedPrediction(prediction: PredictionRecord,report: EvaluationReport,approvedReportId: string): PredictionRecord {
  const { reportId,...body } = report;
  const { predictionId,...predictionBody } = prediction;
  if (predictionId !== digest(predictionBody) || reportId !== digest(body) || approvedReportId !== reportId || !report.admitted || report.reasons.length || report.testCount < 500 || report.testDays < 14 || report.brierImprovement95[0] <= 0 || report.netImprovement95 === null || report.netImprovement95[0] <= 0 || report.modelId !== prediction.modelId || report.chain !== prediction.chain || report.horizon !== prediction.horizon) throw new Error('L2_UNADMITTED_PREDICTION');
  const next = { ...predictionBody,admission: 'validated' as const,reason: null };
  return { ...next,predictionId: digest(next) };
}

/** Optional evaluation ordering only. The existing runtime still selects exact
 * simulated net profit and owns admission, signing, submission and accounting.
 */
export async function runL2Candidates(runtime: LiquidityRuntime,candidates: readonly RouteCandidate[],bindings: readonly ExecutionContextBinding[],rawFrames: readonly MicrostructureFrame[],policy: RuntimePolicy,nowNs: string,riskJournal?: L2RiskJournal,currentTime = () => (BigInt(Date.now())*1000000n).toString()): Promise<LiquidityDecision[]> {
  const frames = new Map(rawFrames.map(f => { const parsed = parseFrame(f); return [parsed.frameId,parsed] as const; }));
  const now = ns(nowNs), rejected: LiquidityDecision[] = [], eligible: Array<{ candidate: RouteCandidate; score: number; order: number }> = [];
  if (bindings.length !== candidates.length || new Set(bindings.map(b => b.candidateDigest)).size !== bindings.length) throw new Error('L2_BINDING_COUNT');
  const risks = riskJournal ? (await riskJournal.state()).states : null;
  for (const [order,candidate] of candidates.entries()) {
    const id = digest(candidate), binding = bindings.find(b => b.candidateDigest === id), frame = binding ? frames.get(binding.frameId) : undefined;
    try {
      if (!binding || !frame || !frame.quality.complete || digest(candidate.identity) !== digest(frame.identity) || !candidate.poolIds.includes(frame.poolId) || now >= ns(binding.expiresAtNs)) throw new Error('L2_INVALID_EXECUTION_BINDING');
      const age = now-ns(frame.receivedTimeNs), limit = frame.identity.chain === 'arbitrum' ? 2000000000n : 5000000000n;
      if (age < 0n || age > limit) throw new Error('L2_STALE_STATE');
      if (policy.mode === 'auto') {
        const risk = risks?.get(`${candidate.identity.chain}:${candidate.identity.network}`);
        if (!risk || risk.halted || !binding.riskSizing || binding.riskSizing.riskDigest !== digest(risk) || uint(candidate.borrowAmount) > uint(binding.riskSizing.unscaledMaximum)*BigInt(risk.multiplierBps)/10000n) throw new Error('L2_RISK_RESIZING_OR_RECONCILIATION_REQUIRED');
      }
      let score = 0;
      if (binding.prediction) {
        const p = binding.prediction;
        if (p.frameId !== frame.frameId || p.cutoffNs !== frame.receivedTimeNs || p.poolId !== frame.poolId || p.chain !== frame.identity.chain) throw new Error('L2_PREDICTION_BINDING');
        if (binding.report && binding.approvedReportId) {
          validatedPrediction(p,binding.report,binding.approvedReportId);
          if (!Number.isFinite(p.expectedMarkoutBps)) throw new Error('L2_INVALID_SCORE');
          score = Math.abs(p.expectedMarkoutBps);
        }
      }
      eligible.push({ candidate,score,order });
    } catch (error) { rejected.push({ candidateDigest: id,status: 'rejected',code: error instanceof Error ? error.message : 'L2_BINDING_REJECTED' }); }
  }
  eligible.sort((a,b) => b.score-a.score || a.order-b.order);
  const admissionGate = async (candidate: RouteCandidate,signal: AbortSignal) => {
    if (signal.aborted) throw new Error('L2_ADMISSION_CANCELLED');
    const binding = bindings.find(b => b.candidateDigest === digest(candidate))!, frame = frames.get(binding.frameId)!;
    const now = ns(currentTime()), age = now-ns(frame.receivedTimeNs);
    if (now >= ns(binding.expiresAtNs) || age < 0n || age > (frame.identity.chain === 'arbitrum' ? 2000000000n : 5000000000n)) throw new Error('L2_STALE_STATE');
    const risk = riskJournal ? (await riskJournal.state()).states.get(`${candidate.identity.chain}:${candidate.identity.network}`) : undefined;
    if (signal.aborted) throw new Error('L2_ADMISSION_CANCELLED');
    if (policy.mode === 'auto' && (!risk || risk.halted || !binding.riskSizing || binding.riskSizing.riskDigest !== digest(risk) || uint(candidate.borrowAmount) > uint(binding.riskSizing.unscaledMaximum)*BigInt(risk.multiplierBps)/10000n)) throw new Error('L2_RISK_RESIZING_OR_RECONCILIATION_REQUIRED');
  };
  return [...rejected,...await runtime.run(eligible.map(e => e.candidate),policy,admissionGate)];
}

export interface ReflectionEvent {
  eventId: string; lane: string; source: string; status: 'profitable' | 'revert' | 'defect' | 'unknown';
  unexpectedSlippageBps: number; receiptDigest: string;
}
export interface RiskReflection { lane: string; multiplierBps: number; cleanTrades: number; halted: boolean }
/** Risk changes are journaled and replayable. Unknown accounting never restores size. */
export class L2RiskJournal {
  constructor(readonly path: string) {}
  async state(): Promise<{ states: Map<string,RiskReflection>; ids: Map<string,string>; receipts: Map<string,string>; tail: string | null }> {
    const states = new Map<string,RiskReflection>(), ids = new Map<string,string>(), receipts = new Map<string,string>(); let tail: string | null = null, count = 0;
    try { for await (const line of readSourceLines(this.path,65536)) {
      const row = JSON.parse(line);
      if (++count > 100000 || row.previousDigest !== tail || row.recordDigest !== digest({ event: row.event,state: row.state,previousDigest: tail })) throw new Error('L2_CORRUPT_RISK_JOURNAL');
      const expected = this.reduce(row.event,states.get(row.event.lane));
      const key = `${row.event.lane}:${row.event.receiptDigest}`, { eventId: _,...receipt } = row.event;
      if (digest(expected) !== digest(row.state) || ids.has(row.event.eventId) || receipts.has(key)) throw new Error('L2_CORRUPT_RISK_JOURNAL');
      receipts.set(key,digest(receipt)); ids.set(row.event.eventId,digest(row.event)); states.set(row.event.lane,expected); tail = row.recordDigest;
    } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { states,ids,receipts,tail };
  }
  private reduce(event: ReflectionEvent,prior?: RiskReflection): RiskReflection {
    if (!event || Object.keys(event).sort().join(',') !== 'eventId,lane,receiptDigest,source,status,unexpectedSlippageBps' || !/^(arbitrum:(42161|421614)|sui:(mainnet|testnet|localnet))$/.test(event.lane) || typeof event.eventId !== 'string' || !event.eventId || !event.source || !/^[a-f0-9]{64}$/.test(event.receiptDigest) || !['profitable','revert','defect','unknown'].includes(event.status) || !Number.isFinite(event.unexpectedSlippageBps) || event.unexpectedSlippageBps < 0) throw new Error('L2_INVALID_REFLECTION');
    const state = prior ? { ...prior } : { lane: event.lane,multiplierBps: 10000,cleanTrades: 0,halted: false };
    if (event.status === 'unknown') { state.halted = true; state.cleanTrades = 0; }
    else if (event.status !== 'profitable' || event.unexpectedSlippageBps > 25) { state.multiplierBps = 5000; state.cleanTrades = 0; }
    else if (!state.halted) { state.cleanTrades = Math.min(5,state.cleanTrades+1); if (state.cleanTrades >= 5) state.multiplierBps = 10000; }
    return state;
  }
  async reflect(event: ReflectionEvent): Promise<RiskReflection> {
    return new ExecutionLock(`${this.path}.lock`).runExclusive(async () => {
      const current = await this.state();
      if (current.ids.has(event.eventId)) {
        if (current.ids.get(event.eventId) !== digest(event)) throw new Error('L2_REFLECTION_SUBSTITUTION');
        return current.states.get(event.lane)!;
      }
      const receiptKey = `${event.lane}:${event.receiptDigest}`, { eventId: _,...receipt } = event;
      if (current.receipts.has(receiptKey)) {
        if (current.receipts.get(receiptKey) !== digest(receipt)) throw new Error('L2_RECEIPT_SUBSTITUTION');
        return current.states.get(event.lane)!;
      }
      const state = this.reduce(event,current.states.get(event.lane)), body = { event,state,previousDigest: current.tail };
      await durableAppend(this.path,{ ...body,recordDigest: digest(body) }); return state;
    });
  }
}
