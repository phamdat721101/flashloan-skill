import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { digest } from '../liquidity/state.js';

export interface Asset { namespace: 'eip155' | 'sui'; networkId: string; assetId: string; decimals: number }
export interface Ratio { numerator: string; denominator: string }
export interface Identity { namespace: 'eip155' | 'sui'; networkId: string; height: string; stateHashOrDigest: string; finality: 'provisional' | 'node-confirmed' | 'checkpoint-certified' }
export interface EvidenceRef { kind: 'discovery' | 'canonical-state' | 'counterfactual-model' | 'native-quote' | 'native-simulation' | 'receipt' | 'configuration'; contentHash: string; sourceId: string; locator: string; observedAtNs: string; expiresAtNs: string | null }
export type Available<T> = { value: T; reason: null } | { value: null; reason: string };
export type EvidenceClass = 'PARAMETRIC' | 'SNAPSHOT_MODEL' | 'NATIVE_SIM' | 'RECEIPT';
export interface Header { schemaVersion: '5.0' | '5.1' | '5.2'; recordType: string; runId: string }
export interface RunRequest extends Header {
  mode: 'research' | 'unsigned-simulation'; networkId: string | null; assetLocators: Array<Omit<Asset,'decimals'>>;
  borrowAsset: Omit<Asset,'decimals'> | null; riskProfileRef: EvidenceRef | null; principalCapRaw: string | null;
  requestedMinProfitUsd: Ratio | null; requestedPriceImpactBps: number | null; networkCostEvidenceRef: EvidenceRef | null;
  valuationEvidenceRef: EvidenceRef | null; watchDurationMs: number; caller: string | null; executor: string | null;
  executorMode: 'existing' | 'fixture'; rotationMode: 'report-only'; requestedMinDeploymentBps: number | null;
  requestedMinBranchWeightBps: number | null; requestedMinPrincipalUsd: Ratio | null; requestedMinBranchUsd: Ratio | null;
  inventoryMinLiquidityUsd: Ratio | null; roundId?: string; previousRoundRef?: string | null; watchPools?: string[];
  fundingOptionRef?: EvidenceRef;
  triggerGridRaw?: string[]; recalledLessons?: Array<{lessonId: string; versionHash: string; status: string}>;
}
export interface WatchLimits {
  watchMode?: 'off' | 'shadow' | 'band'; maxTriggerToSimulationBlocks?: number; bandTtlBlocks?: number;
  bandRebuildTicks?: number; bandMaxEvaluationsPerRow?: number; bandMaxEvaluationsTotal?: number;
  watchQueueCapacity?: number; watchMaxSolves?: number;
}
export interface Policy extends Header, WatchLimits {
  profileRef: EvidenceRef; policyHash: string; mode: 'research' | 'unsigned-simulation' | 'authorized-execution';
  principalCapRaw: string; minimumPrincipalRaw: string; minProfitRaw: string; profitComparison: 'gt';
  maxPriceImpactBps: number; minDeploymentBps: number; minBranchWeightBps: number; maxHopsPerBranch: number;
  maxBranches: number; maxAttempts: number; deadlineMs: number; maxStateAgeNs: string; maxDailyLossRaw: string;
  executionAuthorizationRef: EvidenceRef | null; borrowAsset: Asset; minimumBranchRaw: string; maxTotalSwaps: number;
  valuationEvidenceRef: EvidenceRef; networkCostEvidenceRef: EvidenceRef;
}
export interface StateBundle extends Header { identity: Identity; stateDigest: string; poolEvidence: EvidenceRef[]; lenderEvidence: EvidenceRef; coverageComplete: boolean; coverageReasons: string[] }
export interface Search {
  attempted: number; accepted: number; rejected: number; uniqueAmounts: number; retries: number; maxAttempts: number;
  elapsedMs: number; deadlineMs: number; domainMinimumRaw: string; domainMaximumRaw: string; quantumRaw: string;
  evaluatedDomainHash: string; coverageComplete: boolean; termination: 'candidate-found' | 'grid-complete' | 'domain-certified' | 'attempt-budget' | 'time-budget' | 'coverage-exhausted' | 'cancelled' | 'invalid-input';
  optimality: 'best-found' | 'grid-complete' | 'domain-certified'; rejections: Array<{code: string; count: number}>;
  inflight: number; domainEvidenceRef: EvidenceRef; certificateRef: EvidenceRef | null; gridPointCount: string | null;
}
export interface Branch { branchId: string; allocatedRaw: string; weightBps: number; tokenPath: Asset[]; poolPath: string[]; hopCount: number; stateMutationOrder: string[] }
export interface Cost { asset: Asset; amountRaw: Available<string>; basis: 'fee-estimate' | 'measured' | 'research-assumption'; includedInSwapOutput: boolean; evidence: EvidenceRef }
export interface Plan extends Header {
  planHash: string; stateDigest: string; policyHash: string; borrowAsset: Asset; principalRaw: string; unusedPrincipalRaw: string;
  branches: Branch[]; outputAfterEmbeddedFeesRaw: string; flashFeeRaw: string; costs: Cost[]; netProfitRaw: Available<string>;
  search: Search; evidence: EvidenceRef[]; executionContextHash: string; unsignedPayloadRef: EvidenceRef | null;
}
export interface NativeProof extends Header {
  candidateHash: string; stateDigest: string; policyHash: string; payloadHash: string; executorCodeOrPackageHash: string;
  adapterRevision: string; fidelity: 'existing-native' | 'fixture-native' | 'counterfactual-model' | 'not-attempted';
  success: boolean; repaymentProven: boolean; terminalBalanceBasis: 'before-debt-with-unused' | 'after-debt-with-unused' | 'unknown';
  terminalBalanceRaw: Available<string>; revertDataRef: EvidenceRef | null; overrideRefs: EvidenceRef[]; resultEvidence: EvidenceRef; executionContextHash: string;
}
export interface Ledger extends Header {
  asset: Asset; principalRaw: string; deployedRaw: string; unusedPrincipalRaw: string; swapProceedsRaw: string;
  terminalBeforeDebtRaw: string; flashFeeRaw: string; networkCostRaw: string; otherExternalCostsRaw: string;
  surplusAfterDebtRaw: string; simulatedNetRaw: string; operatorPrefundRaw: string; executorOpeningBalanceRaw: string;
  realizedNetRaw: Available<string>; evidence: EvidenceRef[];
}
export interface Report extends Header {
  outcome: 'SIMULATED_OPPORTUNITY' | 'NO_OPPORTUNITY' | 'INCONCLUSIVE' | 'COVERAGE_BLOCKED' | 'INPUT_BLOCKED' | 'POLICY_UNSUPPORTED' | 'TOOL_ERROR' | 'RECONCILED';
  policyHash: string | null; stateDigest: string | null; inventoryRefs: string[]; solverRef: string | null;
  simulationRef: string | null; ledgerRef: string | null; receiptRef: EvidenceRef | null; changedState: string[]; reasons: string[];
  evidenceClass?: EvidenceClass; readinessRef?: string | null; patternRef?: string | null; entryBandRef?: string | null;
  triggerRef?: string | null; legAttributionRef?: string | null; integrityRef?: string | null; recallRef?: string | null;
}
let validator: Ajv2020 | undefined;
const ids = ['urn:flashloan:contracts:5.0','urn:flashloan:contracts:5.1','urn:flashloan:contracts:5.1-additions','urn:flashloan:contracts:5.2','urn:flashloan:contracts:v6'];
function validators(): Ajv2020 {
  if (!validator) {
    const a = new Ajv2020({ strict: true, allErrors: true });
    for (const file of ['flashloan-evidence-v5.schema.json','flashloan-evidence-v5.1.schema.json','flashloan-evidence-v5.1-additions.schema.json','flashloan-evidence-v5.2.schema.json','flashloan-v6.schema.json']) a.addSchema(JSON.parse(readFileSync(new URL(`../../schemas/${file}`, import.meta.url),'utf8')));
    for (const id of ids) a.getSchema(id);
    validator = a;
  }
  return validator;
}
/** Validates without coercion/default insertion; callers never trust a cast before this boundary. */
export class EvidenceValidationError extends Error { readonly code='SCHEMA_INVALID_ARTIFACT'; }
export function validateRecord<T>(definition: string, value: unknown, version: '5.0' | '5.1' | '5.2' | 'v6' = '5.1'): T {
  const a = validators(), id = version === 'v6' ? ids[4] : version === '5.2' ? ids[3] : version === '5.0' ? ids[0] : a.getSchema(`${ids[2]}#/$defs/${definition}`) ? ids[2] : ids[1];
  const check = a.getSchema(`${id}#/$defs/${definition}`);
  if (!check || !check(value)) throw new EvidenceValidationError(`SCHEMA_INVALID_ARTIFACT:${definition}:${JSON.stringify((check?.errors ?? []).slice(0,8))}`);
  return structuredClone(value) as T;
}
export function recordHash(value: unknown, selfHash?: string): string {
  if (!selfHash) return digest(value);
  return digest(Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([key]) => key !== selfHash)));
}
export const sameAsset = (a: Omit<Asset,'decimals'>, b: Omit<Asset,'decimals'>) => a.namespace === b.namespace && a.networkId === b.networkId && (a.namespace === 'eip155' ? a.assetId.toLowerCase() === b.assetId.toLowerCase() : a.assetId === b.assetId);
export function fresh(ref: EvidenceRef, nowNs: bigint, maxAgeNs: bigint): void {
  if (BigInt(ref.observedAtNs) > nowNs || nowNs - BigInt(ref.observedAtNs) > maxAgeNs || ref.expiresAtNs !== null && nowNs >= BigInt(ref.expiresAtNs)) throw new Error('STALE_EVIDENCE');
}
