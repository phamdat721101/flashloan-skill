import { compilePolicy, type ApprovedProfile, type RequestedConstraints } from './economics.js';
import type { Asset, EvidenceRef, Ratio, RunRequest } from './contracts.js';
import { domainHash, IntegrationError, validateIntegration, without, type Hash } from './integration.js';
import { TRADING_GAS_CAP, TRADE_SUBMISSION_CAP } from '../evm/budget.js';

/** SK-02: flash-intent/1 -> existing schema 5.2 RunRequest. No principal, lender, stablecoin or gasless default is ever manufactured. */
export interface Intent {
  schema: 'flash-intent/1'; roundId: string; chainId: string; mode: 'research' | 'simulate' | 'execute';
  selection: { movers: boolean; explicitAssets: string[]; minReportedLiquidityUsd: string; maxCandidates: number };
  requestedConstraints: RequestedConstraints | null; profileRef: unknown; authorizationRef: unknown; previousRoundRef: unknown;
  limits: { maxRpcCalls: number; maxEvaluations: number; maxPools: number; maxRoutes: number; deadlineMs: number; watchDurationMs: number };
}
export interface IntegrationProfileExtras {
  maxGasReservationNativeRaw: string; maxBlockLag: number; submissionPolicy: 'approved-private' | 'approved-direct'; allowedCapabilities: string[];
}
export interface IntentRefs {
  profile?: ApprovedProfile & { extras: IntegrationProfileExtras };
  repaymentAsset?: Asset; valuation?: { price: Ratio; ref: EvidenceRef }; networkCostRef?: EvidenceRef; authorization?: EvidenceRef;
}
export type AdaptedIntent =
  | { kind: 'ready'; intent: Intent; request: RunRequest; constraints: RequestedConstraints | null; executeAuthorized: boolean; blockers: string[] }
  | { kind: 'research-only'; intent: Intent; blockers: string[] };

/** `eip155:N` -> local networkId "N"; any other namespace or lossy form is rejected. */
export function networkIdOf(chainId: string) {
  const m = /^eip155:([1-9][0-9]*)$/.exec(chainId);
  if (!m) throw new IntegrationError('WRONG_CHAIN', chainId);
  return m[1];
}
/** Integration AssetId <-> local Asset (namespace, networkId, address). Native identities have no local ERC20 form. */
export function toLocalAsset(assetId: string, decimals: number): Asset {
  const m = /^eip155:([1-9][0-9]*)\/erc20:(0x[0-9a-f]{40})$/.exec(assetId);
  if (!m) throw new IntegrationError('UNSUPPORTED_NATIVE_CURRENCY', `${assetId} has no ERC20 repayment form`);
  return { namespace: 'eip155', networkId: m[1], assetId: m[2], decimals };
}
export const toIntegrationAssetId = (a: Pick<Asset, 'namespace' | 'networkId' | 'assetId'>) => `${a.namespace}:${a.networkId}/erc20:${a.assetId.toLowerCase()}`;
const REF_KIND: Record<EvidenceRef['kind'], string> = { configuration: 'configuration', 'canonical-state': 'canonical-state', 'native-simulation': 'native-simulation', receipt: 'receipt',
  discovery: 'source', 'counterfactual-model': 'source', 'native-quote': 'source' };
const nsIso = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace(/\.\d+Z$/, 'Z');
/** Explicit local -> shared EvidenceRef adapter: raw hex gains the sha256: prefix; timestamps become RFC3339 UTC. */
export function toIntegrationRef(ref: EvidenceRef, traceId: string) {
  const hash = /^sha256:[0-9a-f]{64}$/.test(ref.contentHash) ? ref.contentHash : /^[0-9a-f]{64}$/.test(ref.contentHash) ? `sha256:${ref.contentHash}` : null;
  if (!hash) throw new IntegrationError('VERSION_UNSUPPORTED', `content hash ${ref.contentHash} is not SHA-256`);
  return { kind: REF_KIND[ref.kind], contentHash: hash, issuedAt: nsIso(ref.observedAtNs), expiresAt: ref.expiresAtNs === null ? null : nsIso(ref.expiresAtNs), traceId, locator: ref.locator };
}

export function adaptIntent(input: unknown, refs: IntentRefs): AdaptedIntent {
  const intent = validateIntegration<Intent>('Intent', input);
  const networkId = networkIdOf(intent.chainId), blockers: string[] = [];
  if (intent.mode === 'execute' && !refs.authorization) blockers.push('INPUT_BLOCKED_AUTHORIZATION');
  if (!refs.profile) return { kind: 'research-only', intent, blockers: ['INPUT_BLOCKED_PROFILE', ...blockers] };
  if (!refs.repaymentAsset || !refs.valuation || !refs.networkCostRef) return { kind: 'research-only', intent, blockers: ['INPUT_BLOCKED_VALUATION', ...blockers] };
  const repayment = refs.repaymentAsset;
  if (repayment.networkId !== networkId) throw new IntegrationError('WRONG_CHAIN', 'repayment asset');
  const c = intent.requestedConstraints;
  if (c && c.repaymentAssetId !== toIntegrationAssetId(repayment)) throw new IntegrationError('CONSTRAINT_ASSET_MISMATCH', c.repaymentAssetId);
  const locators = [repayment, ...intent.selection.explicitAssets.filter(a => a.includes('/erc20:')).map(a => toLocalAsset(a, 0))]
    .map(({ namespace, networkId, assetId }) => ({ namespace, networkId, assetId }));
  const unique = [...new Map(locators.map(l => [l.assetId, l])).values()];
  const request: RunRequest = { schemaVersion: '5.2', recordType: 'run-request', runId: intent.roundId, roundId: intent.roundId,
    mode: intent.mode === 'research' ? 'research' : 'unsigned-simulation', networkId, assetLocators: unique,
    borrowAsset: { namespace: repayment.namespace, networkId: repayment.networkId, assetId: repayment.assetId }, riskProfileRef: refs.profile.ref,
    principalCapRaw: refs.profile.body.principalCapRaw, requestedMinProfitUsd: null, requestedPriceImpactBps: null,
    networkCostEvidenceRef: refs.networkCostRef, valuationEvidenceRef: refs.valuation.ref, watchDurationMs: intent.limits.watchDurationMs,
    caller: null, executor: null, executorMode: 'existing', rotationMode: 'report-only', requestedMinDeploymentBps: null, requestedMinBranchWeightBps: null,
    requestedMinPrincipalUsd: null, requestedMinBranchUsd: null, inventoryMinLiquidityUsd: { numerator: intent.selection.minReportedLiquidityUsd.replace('.', ''), denominator: (10n ** BigInt(intent.selection.minReportedLiquidityUsd.split('.')[1]?.length ?? 0)).toString() } };
  return { kind: 'ready', intent, request, constraints: c, executeAuthorized: intent.mode === 'execute' && !!refs.authorization, blockers };
}

/** compilePolicy is the only policy owner; this wraps its result in effective-execution-policy/1 without re-deciding any bound. */
export function compileEffectivePolicy(adapted: Extract<AdaptedIntent, { kind: 'ready' }>, refs: Required<Pick<IntentRefs, 'profile' | 'repaymentAsset' | 'valuation'>>, nowNs: bigint) {
  const local = compilePolicy(adapted.request, refs.profile, refs.repaymentAsset, refs.valuation, nowNs, adapted.constraints ?? undefined);
  const x = refs.profile.extras, a = refs.repaymentAsset, intent = adapted.intent;
  const gasCap = BigInt(x.maxGasReservationNativeRaw) < TRADING_GAS_CAP ? BigInt(x.maxGasReservationNativeRaw) : TRADING_GAS_CAP;
  // Refs embedded in the policy carry a round-independent trace id: roundId never changes effective-policy identity.
  const trace = `policy:${local.policyHash.slice(0, 16)}`;
  const compiledRef = toIntegrationRef({ ...refs.profile.ref, kind: 'configuration', contentHash: local.policyHash }, trace);
  const body = { schema: 'effective-execution-policy/1', roundId: intent.roundId, chainId: intent.chainId,
    repaymentAsset: { assetId: toIntegrationAssetId(a), chainId: intent.chainId, kind: 'erc20', address: a.assetId.toLowerCase(), decimals: a.decimals, metadataRef: toIntegrationRef(refs.valuation.ref, trace) },
    profileRef: toIntegrationRef(refs.profile.ref, trace), policyHash: '' as Hash, principalCapRaw: local.principalCapRaw, minNetProfitRaw: local.minProfitRaw, comparison: 'gt',
    maxPriceImpactBps: local.maxPriceImpactBps, maxRoutes: Math.min(local.maxBranches, intent.limits.maxRoutes), maxHopsPerRoute: local.maxHopsPerBranch,
    maxAttempts: Math.min(local.maxAttempts, TRADE_SUBMISSION_CAP), maxGasReservationNativeRaw: gasCap.toString(), maxDailyLossRaw: local.maxDailyLossRaw,
    maxStateAgeMs: Number(BigInt(local.maxStateAgeNs) / 1_000_000n), maxBlockLag: x.maxBlockLag, submissionPolicy: x.submissionPolicy, allowedCapabilities: x.allowedCapabilities,
    deadlineMs: Math.min(local.deadlineMs, intent.limits.deadlineMs), compiledPolicyHash: `sha256:${local.policyHash}` as Hash, compiledPolicyRef: compiledRef };
  body.policyHash = domainHash('flash/effective-policy/1', without(body, 'policyHash', 'roundId'));
  return { local, effective: validateIntegration<typeof body>('Policy', body) };
}
