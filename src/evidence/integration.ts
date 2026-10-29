import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { deriveV4PoolId } from '../state-adapters.js';
import { uint } from '../liquidity/state.js';
import type { RejectReason } from '../evm/pool-universe.js';

/** Contract `urn:flashloan-integration:1` (docs/features/flashloan-v7-integration.md §5). Bytes are vendor-pinned; never edit. */
export const INTEGRATION_SCHEMA_SHA256 = '1de7fced7a55bccf7fc5c45ab41934087344054961238a48484598944256aaaf';
export type IntegrationDef = 'Intent' | 'ResolvedPool' | 'PoolResolutionRequest' | 'PoolResolutionReport' | 'ExecutorManifest' | 'AdmissionBundle'
  | 'Policy' | 'Cost' | 'Readiness' | 'CandidateLedger' | 'Plan' | 'ExecutionEvidence' | 'Result' | 'Asset' | 'State' | 'EvidenceRef';
export type Hash = `sha256:${string}`;

const LEGACY_REJECTS: readonly RejectReason[] = ['NOT_ELIGIBLE', 'WRONG_CHAIN', 'NOT_EVM_CONTRACT', 'NO_CODE', 'UNSUPPORTED_ADAPTER', 'FACTORY_UNKNOWN',
  'TOKEN_MISMATCH', 'DECIMALS_UNREADABLE', 'ZERO_LIQUIDITY', 'DENYLISTED', 'DUPLICATE', 'PAIR_CAP', 'SINGLE_POOL_PAIR'];
/** Closed registry (erratum E3). Legacy universe reasons are re-exported, not redeclared. */
export const REASON_CODES = new Set<string>([...LEGACY_REJECTS,
  'UNRESOLVED_POOL_KEY', 'POOL_ID_MISMATCH', 'MANAGER_CODE_DRIFT', 'MANAGER_UNMAPPED', 'UNSUPPORTED_HOOK', 'UNSUPPORTED_DYNAMIC_FEE', 'STATE_UNINITIALIZED', 'REORGED_INITIALIZATION',
  'UNSUPPORTED_NATIVE_CURRENCY', 'UNSUPPORTED_TOKEN_BEHAVIOR', 'CODEC_UNAVAILABLE', 'SPLIT_UNSUPPORTED',
  'INPUT_BLOCKED_PROFILE', 'INPUT_BLOCKED_AUTHORIZATION', 'INPUT_BLOCKED_VALUATION',
  'MANAGER_MAPPING_REQUIRED', 'UNINITIALIZED_POOL', 'BLOCK_REORG', 'RESOLUTION_BUDGET', 'UNSUPPORTED_HOOK_OR_FEE', 'POLICY_UNSUPPORTED_FIELD', 'CONSTRAINT_ASSET_MISMATCH',
  'INSUFFICIENT_NET_PROFIT', 'PRICE_IMPACT_EXCEEDED', 'LENDER_CAPACITY', 'COST_EVIDENCE_EXPIRED', 'NO_ROUTE',
  'DEFERRED_RPC_BUDGET', 'DEFERRED_EVALUATION_BUDGET', 'DEADLINE_EXCEEDED', 'PLAN_EXPORT_BUDGET',
  'ADMISSION_MISSING', 'ADMISSION_BINDING_MISMATCH', 'ADMISSION_EXPIRED', 'PRODUCER_UNTRUSTED', 'ADMISSION_FIXTURE',
  'STATE_CHANGED', 'NONCE_DRIFT', 'CHAIN_BUDGET_EXHAUSTED', 'POLICY_BOUND_EXCEEDED', 'BINDING_MISMATCH', 'CANCELLED', 'PNL_UNKNOWN_HALT', 'UNRESOLVED_BUDGET_RESERVATION', 'OPERATOR_UNKNOWN', 'VERSION_UNSUPPORTED',
  // assessReadiness reasons, carried verbatim into execution-readiness/1
  'GAS_UNAVAILABLE', 'GAS_BUDGET_UNAVAILABLE', 'ADAPTER_NOT_ADMITTED', 'STATE_NOT_CANONICAL', 'ATTEMPT_JOURNAL_UNAVAILABLE', 'GAS_BALANCE_UNAVAILABLE',
  'EXECUTOR_BALANCES_UNAVAILABLE', 'BUDGET_UNAVAILABLE', 'CANONICALITY_UNAVAILABLE', 'OPERATOR_CONTEXT_UNAVAILABLE', 'EXECUTOR_CONTEXT_UNAVAILABLE', 'RESEARCH_MODE']);
export type ReasonCode = string;

export class IntegrationValidationError extends Error { readonly code = 'SCHEMA_INVALID_ARTIFACT'; }
export class IntegrationError extends Error { constructor(readonly reason: ReasonCode, detail = '') { super(detail ? `${reason}:${detail}` : reason); } }
const fail = (message: string): never => { throw new IntegrationValidationError(message); };

let ajv: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();
/** Own instance: strictTypes off (erratum E2) and an RFC3339-UTC date-time without a new dependency (E1). */
function check(def: IntegrationDef): ValidateFunction {
  if (!ajv) {
    const bytes = readFileSync(new URL('../../schemas/flashloan-integration-v1.schema.json', import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== INTEGRATION_SCHEMA_SHA256) throw new IntegrationError('VERSION_UNSUPPORTED', 'integration schema hash');
    ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
    ajv.addFormat('date-time', /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/);
    ajv.addSchema(JSON.parse(bytes.toString('utf8')));
  }
  let fn = compiled.get(def);
  if (!fn) { fn = ajv.getSchema(`urn:flashloan-integration:1#/$defs/${def}`) ?? fail(`UNKNOWN_DEF:${def}`); compiled.set(def, fn); }
  return fn;
}

/** Shape (Ajv) then the owning semantic rules. Returns a clone; callers never trust a cast before this boundary. */
export function validateIntegration<T>(def: IntegrationDef, value: unknown): T {
  const fn = check(def);
  if (!fn(value)) fail(`SCHEMA_INVALID_ARTIFACT:${def}:${JSON.stringify((fn.errors ?? []).slice(0, 8))}`);
  walkBounds(value, def);
  SEMANTIC[def]?.(value as never);
  return structuredClone(value) as T;
}

/** Erratum E4/E3: regex-valid widths are bounded to uint256/int256 and reason codes are closed. */
function walkBounds(v: unknown, path: string): void {
  if (Array.isArray(v)) { v.forEach((x, i) => walkBounds(x, `${path}[${i}]`)); return; }
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string' && (/Raw$/.test(k) || k === 'blockNumber')) {
      if (x.startsWith('-')) { if (BigInt(x) <= -(1n << 255n)) fail(`INTEGER_OUT_OF_RANGE:${path}.${k}`); }
      else if (/^(0|[1-9][0-9]*)$/.test(x)) { try { uint(x); } catch { fail(`INTEGER_OUT_OF_RANGE:${path}.${k}`); } }
    }
    if (k === 'reasonCode' && typeof x === 'string' && !REASON_CODES.has(x)) fail(`UNKNOWN_REASON_CODE:${x}`);
    if (k === 'reasonCodes' && Array.isArray(x)) for (const c of x) if (!REASON_CODES.has(c)) fail(`UNKNOWN_REASON_CODE:${c}`);
    walkBounds(x, `${path}.${k}`);
  }
}

interface AssetLike { assetId: string; chainId: string; kind: 'native' | 'erc20'; address: string | null }
/** Rule 1: AssetId equals chain/kind/address; native only as slip44:60 on reviewed ETH-native chains. */
export function validateAsset(a: AssetLike) {
  const expected = a.kind === 'native' ? `${a.chainId}/slip44:60` : `${a.chainId}/erc20:${a.address}`;
  if (a.assetId !== expected) fail(`ASSET_IDENTITY_MISMATCH:${a.assetId}`);
}
type Pool = { chainId: string; poolId: `0x${string}`; key: { currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}` };
  asset0: AssetLike; asset1: AssetLike; state: { chainId: string } };
/** Rule 1: ordered currencies map to asset0/asset1, and poolId is the ABI-encoded PoolKey hash (not JSON). */
export function validateResolvedPool(p: Pool) {
  validateAsset(p.asset0); validateAsset(p.asset1);
  if (p.asset0.chainId !== p.chainId || p.asset1.chainId !== p.chainId || p.state.chainId !== p.chainId) fail('WRONG_CHAIN');
  const currency = (a: AssetLike) => a.kind === 'native' ? '0x0000000000000000000000000000000000000000' : a.address;
  if (currency(p.asset0) !== p.key.currency0 || currency(p.asset1) !== p.key.currency1) fail('POOL_ASSET_MISMATCH');
  if (deriveV4PoolId(p.key) !== p.poolId) fail('POOL_ID_MISMATCH');
}
type Ledger = { items: Array<{ outcome: string; routeIds: string[]; assetId: string; reasonCode: string | null; nextDependency: string | null }>; counts: Record<string, number> };
const OUTCOME_COUNT: Record<string, string> = { DISCOVERED: 'discovered', RESOLVED: 'resolved', EVALUATED: 'evaluated', REJECTED: 'rejected', DEFERRED_BUDGET: 'deferred', INCOMPLETE_DATA: 'incomplete', UNSUPPORTED: 'unsupported' };
/** Rule 3: unique targets, exclusive counts that sum to requested, EVALUATED only with route evidence, dependencies on blocked rows. */
export function validateCandidateLedgerV2(l: Ledger) {
  if (new Set(l.items.map(i => i.assetId)).size !== l.items.length) fail('LEDGER_DUPLICATE_TARGET');
  const tally: Record<string, number> = Object.fromEntries(Object.values(OUTCOME_COUNT).map(k => [k, 0]));
  for (const i of l.items) {
    tally[OUTCOME_COUNT[i.outcome]]++;
    if (i.outcome === 'EVALUATED' && i.routeIds.length === 0) fail('EVALUATED_WITHOUT_ROUTE');
    if (['DEFERRED_BUDGET', 'INCOMPLETE_DATA', 'UNSUPPORTED'].includes(i.outcome) && (!i.reasonCode || !i.nextDependency)) fail(`BLOCKED_WITHOUT_DEPENDENCY:${i.assetId}`);
  }
  for (const [k, n] of Object.entries(tally)) if (l.counts[k] !== n) fail(`LEDGER_COUNT_MISMATCH:${k}`);
  if (l.counts.requested !== l.items.length) fail('LEDGER_REQUESTED_MISMATCH');
}
type PlanLike = { principalRaw: string; deployedRaw: string; unusedPrincipalRaw: string; swapProceedsRaw: string; lenderFeeRaw: string; terminalBeforeDebtRaw: string;
  surplusAfterDebtRaw: string; netLowerBoundRaw: string; branches: Array<{ branchId: string; allocationRaw: string; actions: Array<{ kind: string; tokenIn: string; tokenOut: string; poolId: string | null }> }> };
/** Rule 5 accounting identities that do not need the Cost record; verifyPlanV7 adds the cost-dependent net. */
export function validatePlanAccounting(p: PlanLike) {
  const n = (x: string) => BigInt(x);
  if (n(p.principalRaw) !== n(p.deployedRaw) + n(p.unusedPrincipalRaw)) fail('PRINCIPAL_SPLIT_MISMATCH');
  if (p.branches.reduce((s, b) => s + n(b.allocationRaw), 0n) !== n(p.deployedRaw)) fail('BRANCH_ALLOCATION_MISMATCH');
  if (p.branches.some(b => n(b.allocationRaw) === 0n)) fail('ZERO_BRANCH_ALLOCATION');
  if (new Set(p.branches.map(b => b.branchId)).size !== p.branches.length) fail('DUPLICATE_BRANCH');
  if (n(p.terminalBeforeDebtRaw) !== n(p.swapProceedsRaw) + n(p.unusedPrincipalRaw)) fail('TERMINAL_MISMATCH');
  if (n(p.surplusAfterDebtRaw) !== n(p.terminalBeforeDebtRaw) - n(p.principalRaw) - n(p.lenderFeeRaw)) fail('SURPLUS_MISMATCH');
  for (const b of p.branches) b.actions.forEach((a, i) => {
    if (i > 0 && b.actions[i - 1].tokenOut !== a.tokenIn) fail(`ACTION_CHAIN_BROKEN:${b.branchId}`);
    if ((a.kind === 'SWAP') !== (a.poolId !== null)) fail(`ACTION_POOL_SENTINEL:${b.branchId}`);
  });
}
type CostLike = { networkNativeUpperRaw: string; gasReservationNativeRaw: string };
/** Rule 6: the reservation covers the modeled worst-case native cost; it is never itself the cost. */
export function validateCost(c: CostLike) {
  if (BigInt(c.networkNativeUpperRaw) > BigInt(c.gasReservationNativeRaw)) fail('RESERVATION_BELOW_COST');
}
type Evidence = { kind: string; fixture: boolean; fidelity: string; success: boolean; overrideRefs: unknown[]; repaymentProven: boolean; custodyProven: boolean };
/** Rule 7: fixtures carry fixture fidelity; reconciled receipts prove repayment and custody. */
export function validateExecutionEvidence(e: Evidence) {
  if (e.fixture !== (e.fidelity === 'fixture')) fail('FIXTURE_FIDELITY_MISMATCH');
  if (e.kind === 'RECEIPT_RECONCILED' && (!e.repaymentProven || !e.custodyProven)) fail('RECEIPT_UNPROVEN');
}
type ResultLike = { status: string; ledger: Ledger; plan: unknown; executionEvidence: Evidence | null; nextDependencies: string[]; readiness: { pnlState: string } };
/** Evidence class per status: a model ranking is not a simulation, and an unknown receipt carries no realized value. */
export function validateResult(r: ResultLike) {
  validateCandidateLedgerV2(r.ledger);
  const e = r.executionEvidence;
  if (r.status === 'MODEL_OPPORTUNITY' && !r.plan) fail('MODEL_WITHOUT_PLAN');
  if (r.status === 'SIMULATED_OPPORTUNITY' && !(r.plan && e?.kind === 'NATIVE_SIM' && e.success && !e.fixture && e.fidelity === 'existing-native' && e.overrideRefs.length === 0)) fail('SIMULATION_EVIDENCE_REQUIRED');
  if (r.status === 'RECEIPT_RECONCILED' && e?.kind !== 'RECEIPT_RECONCILED') fail('RECEIPT_EVIDENCE_REQUIRED');
  if (r.status === 'SUBMITTED_UNKNOWN' && (e?.kind === 'RECEIPT_RECONCILED' || r.readiness.pnlState === 'KNOWN')) fail('UNKNOWN_SUBMISSION_REALIZED');
  if (['INPUT_BLOCKED', 'COVERAGE_BLOCKED', 'POLICY_UNSUPPORTED', 'VERSION_UNSUPPORTED', 'INCONCLUSIVE'].includes(r.status) && r.nextDependencies.length === 0) fail('BLOCKED_WITHOUT_DEPENDENCY');
}
const SEMANTIC: Partial<Record<IntegrationDef, (v: never) => void>> = {
  Asset: validateAsset, ResolvedPool: validateResolvedPool, CandidateLedger: validateCandidateLedgerV2, Plan: validatePlanAccounting,
  Cost: validateCost, ExecutionEvidence: validateExecutionEvidence, Result: validateResult,
  PoolResolutionReport: (r: { resolved: Pool[] }) => r.resolved.forEach(validateResolvedPool)
};

/** Canonical JSON (digest()'s sorted keys) restricted to safe integers and well-formed strings (erratum E5). */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]));
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new IntegrationError('UNSAFE_NUMBER');
  if (typeof v === 'string' && /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)) throw new IntegrationError('INVALID_UNICODE');
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v;
  throw new IntegrationError('INVALID_CANONICAL_INPUT');
}
export const canonicalBytes = (value: unknown) => Buffer.from(JSON.stringify(canonical(value)), 'utf8');
export type HashDomain = 'flash/effective-policy/1' | 'flash/executor-manifest/1' | 'flash/execution-plan/1' | 'flash/route-cost/1' | 'flash/abi/1' | 'flash/candidate/1';
/** sha256(utf8(domain) || 0x0a || canonical(value)), prefixed. Exact-byte artifacts use sha256Bytes instead. */
export function domainHash(domain: HashDomain | string, value: unknown): Hash {
  return `sha256:${createHash('sha256').update(`${domain}\n`, 'utf8').update(canonicalBytes(value)).digest('hex')}`;
}
export const sha256Bytes = (bytes: Uint8Array): Hash => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const without = <T extends object, K extends keyof T>(v: T, ...keys: K[]) => Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k as K))) as Omit<T, K>;

/** Rule 9: one counter per round; every resolver page, retry and quote worker charges the same budget. */
export class RoundCounters {
  rpc = 0; evaluations = 0;
  constructor(readonly limits: { maxRpcCalls: number; maxEvaluations: number }, readonly deadlineAt: number, private readonly now: () => number = Date.now) {}
  charge(kind: 'rpc' | 'evaluations', n = 1) {
    if (this.now() > this.deadlineAt) throw new IntegrationError('DEADLINE_EXCEEDED');
    const limit = kind === 'rpc' ? this.limits.maxRpcCalls : this.limits.maxEvaluations;
    if (this[kind] + n > limit) throw new IntegrationError(kind === 'rpc' ? 'DEFERRED_RPC_BUDGET' : 'DEFERRED_EVALUATION_BUDGET');
    this[kind] += n;
  }
}

/** v7 SK-10: sibling manifest (erratum E6: the v6 FlashloanVersions schema is closed and vendor-pinned). Any drift or a closed gate is VERSION_UNSUPPORTED. */
export interface IntegrationVersions { schema: 'flashloan-integration-versions/1'; baseVersions: { path: string; sha256: string }; prompt: { id: string; sha256: string };
  contract: { id: string; path: string; sha256: string }; codecs: Record<string, string>; admissionProducers: { path: string; sha256: string }; features: { integrationV7: boolean } }
export function checkIntegrationVersions(raw: unknown, observed: { baseVersionsBytes: Uint8Array; promptBytes: Uint8Array; contractBytes: Uint8Array; producersBytes: Uint8Array }): IntegrationVersions {
  const v = raw as IntegrationVersions, hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  if (!v || v.schema !== 'flashloan-integration-versions/1' || !v.features || typeof v.features.integrationV7 !== 'boolean') throw new IntegrationError('VERSION_UNSUPPORTED', 'integration manifest');
  if (v.contract?.sha256 !== INTEGRATION_SCHEMA_SHA256 || hex(observed.contractBytes) !== v.contract.sha256) throw new IntegrationError('VERSION_UNSUPPORTED', 'contract schema drift');
  if (hex(observed.baseVersionsBytes) !== v.baseVersions?.sha256 || hex(observed.promptBytes) !== v.prompt?.sha256 || hex(observed.producersBytes) !== v.admissionProducers?.sha256) throw new IntegrationError('VERSION_UNSUPPORTED', 'installed release drift');
  if (!v.features.integrationV7) throw new IntegrationError('VERSION_UNSUPPORTED', 'integrationV7 gate is off');
  return v;
}
