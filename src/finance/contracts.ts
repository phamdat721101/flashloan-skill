import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { getAddress } from 'viem';
import { canonicalBytes } from '../evidence/integration.js';

/** Finance wire contract urn:openx:finance-wire:1. Structural (Ajv) and semantic checks are separate gates. */
export const CONTRACT_ID = 'urn:openx:finance-wire:1';
export const CONTRACT_DIGEST = '8046b6f9d4ef51f9419481ccee4e49c567681df9fb3f48867b9194cff3de4edb';
export const MAX_INPUT_BYTES = 256 * 1024;
export const CHAIN_IDS = { arbitrum: 42161, base: 8453, robinhood: 4663 } as const;

export type Network = 'arbitrum' | 'base' | 'robinhood' | 'xrpl';
export type EvmNetwork = keyof typeof CHAIN_IDS;
export type Digest = string;
export type Account = { family: 'evm'; address: string; chainId: 42161 | 8453 | 4663; model: 'eoa' | 'smart-account' } | { family: 'xrpl'; address: string; model: 'native' };
export type Asset =
  | { kind: 'evm-native'; network: EvmNetwork; decimals: 18 }
  | { kind: 'erc20'; network: EvmNetwork; address: string; decimals: number }
  | { kind: 'xrp'; network: 'xrpl'; decimals: 6 }
  | { kind: 'xrpl-issued'; network: 'xrpl'; currency: string; issuer: string };
export type Quantity = { kind: 'atomic'; value: string } | { kind: 'issued-decimal'; coefficient: string; exponent: number };
export interface Amount { asset: Asset; quantity: Quantity }
export interface EvidenceRef { id: Digest; contentHash: Digest; expiresAt: string | null }
export interface Observation {
  network: Network; networkIdentityHash: Digest;
  point: { kind: 'evm-block'; number: string; hash: string; finality: 'included' | 'safe' | 'finalized' } | { kind: 'xrpl-ledger'; index: string; hash: string; validated: true };
  observedAt: string; expiresAt: string; consistency: 'pinned' | 'best-effort'; fidelity: 'fixture' | 'chain-read' | 'native-simulation'; sources: EvidenceRef[];
}
export interface EvmPosition {
  kind: 'evm-collateralized'; positionId: Digest; account: Account; protocol: 'aave-v3' | 'morpho-blue'; deploymentRef: Digest; marketId: string;
  supplied: Amount[]; shareEvidence: Array<{ role: 'supply' | 'borrow'; asset: Asset; raw: string; shareModelRef: Digest }>; collateral: Amount[]; debt: Amount[];
  noDebt: boolean; healthFactor: string | null; ltv: string | null; liquidationThreshold: string | null; observation: Observation;
}
export interface XrplLoan {
  kind: 'xrpl-loan'; positionId: Digest; account: Account; loanId: string; loanBrokerId: string; assetResolutionRef: Digest; principalOutstanding: Amount; totalValueOutstanding: Amount;
  managementFeeOutstanding: Amount; periodicPayment: Amount; interestRateTenthsBps: number; paymentRemaining: number; nextDueAt: string | null; gracePeriodSeconds: number;
  loanScale: number | null; flags: Array<'defaulted' | 'impaired' | 'overpayment-allowed'>; observation: Observation;
}
export interface Coverage { complete: boolean; missing: Array<{ capability: string; reasonCode: string }>; cursor: string | null }
export interface Constraints { maxSpend: Amount[]; maxCosts: Amount[]; minReceive: Amount[]; maxDebtAfter: Amount[]; minCollateralAfter: Amount[]; minSupplyAfter: Amount[]; maxSlippageBps: number; maxStateAgeSeconds: number }
export interface Cost { kind: 'execution-gas' | 'l1-data' | 'operator' | 'lender' | 'swap' | 'product' | 'xrpl-fee'; payer: 'user' | 'sponsor'; maximum: Amount; sourceRef: EvidenceRef }
export interface EvmPayload { kind: 'evm'; chainId: 42161 | 8453 | 4663; from: string; to: string; data: string; value: string; nonce: string; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string }
export interface XrplPayload { kind: 'xrpl-payment'; networkIdentityHash: Digest; tx: { TransactionType: 'Payment'; Account: string; Destination: string; Amount: string | { currency: string; issuer: string; value: string }; Fee: string; Sequence: number; TicketSequence?: number; LastLedgerSequence: number; DestinationTag?: number; Flags: 0 } }
export type Intent = 'earn' | 'withdraw' | 'borrow' | 'repay' | 'protect' | 'payment';
export interface Permission { kind: 'erc20-allowance' | 'account-module' | 'native-signature'; target: string; asset: Asset | null; maximum: Quantity | null }
export interface Plan {
  schemaVersion: 'finance.plan/1'; planHash: Digest; requestDigest: Digest; contractDigest: Digest; network: Network; account: Account;
  positionRef: Digest | null; comparisonRef: Digest | null; intent: Intent; adapterRef: Digest; observation: Observation;
  requestedConstraints: Constraints; effectiveConstraints: Constraints; permissions: Permission[]; costs: Cost[];
  nativePayload: EvmPayload | XrplPayload; expiresAt: string; evidence: EvidenceRef[]; execution: false;
}
export interface Pin { kind: 'bytecode' | 'abi' | 'protocol-market' | 'owner-model' | 'network' | 'approval-key'; id: string; hash: Digest }
export interface LocalPlan {
  schemaVersion: 'finance.local-plan/1'; localPlanHash: Digest; researchPlanHash: Digest; policyHash: Digest; contractDigest: Digest; network: Network; account: Account;
  adapterRef: Digest; observation: Observation; effectiveConstraints: Constraints; costs: Cost[]; nativePayload: EvmPayload | XrplPayload; pins: Pin[];
  requiredFinality: 'safe' | 'finalized' | 'validated'; expiresAt: string;
}
export interface Simulation { planHash: Digest; localPlanHash: Digest; fidelity: 'fixture' | 'model' | 'native'; pass: boolean; expectedSpend: Amount[]; expectedReceive: Amount[]; nativeStateRef: EvidenceRef; postconditionsPass: boolean; errors: string[] }
export type ActionState = 'PREPARED' | 'SIMULATED' | 'AWAITING_APPROVAL' | 'SUBMITTING' | 'SUBMITTED' | 'INCLUDED' | 'CONFIRMED' | 'FINALIZED' | 'FAILED' | 'EXPIRED' | 'UNKNOWN' | 'HALTED';
export interface Receipt { actionId: Digest; planHash: Digest; localPlanHash: Digest; network: Network; transactionId: string | null; state: ActionState; verification: 'local-reported' | 'chain-verified' | 'unverified'; effects: Amount[]; reconciliation: 'PENDING' | 'MATCH' | 'MISMATCH' | 'UNKNOWN'; evidence: EvidenceRef[] }
export interface FinanceErrorRecord { code: string; retryable: boolean; recovery: string }
export interface Profile {
  schemaVersion: 'finance.profile/1'; enabled: boolean; live: boolean; networks: Network[]; intents: Intent[]; accounts: Account[]; policyHash: Digest; contractDigest: Digest;
  mcpUrl: string; mcpAuthTokenEnv: string; stateDirectory: string; signer: 'none' | 'existing-evm-host' | 'external-xrpl-host'; approvalPublicKeyRef: string | null;
  constraints: Constraints; maxDailyNativeCost: Amount[]; maxConcurrentWrites: 1; reconcileRequired: true;
}
export interface ApprovalGrant { schemaVersion: 'finance.approval/1'; grantId: Digest; contractDigest: Digest; localPlanHash: Digest; policyHash: Digest; account: Account; nonce: Digest; issuedAt: string; expiresAt: string; signature: string }
export type LocalRequest = { schemaVersion: 'finance.local-request/1'; requestId: string; contractDigest: Digest } & (
  | { command: 'import-plan'; plan: Plan }
  | { command: 'simulate'; planRef: Digest; policyRef: Digest }
  | { command: 'execute'; localPlanRef: Digest; policyRef: Digest; approvalRef: Digest }
  | { command: 'reconcile'; actionId: Digest; policyRef: Digest });
export interface LocalResult { schemaVersion: 'finance.local-result/1'; contractDigest: Digest; requestId: string; outcome: 'ok' | 'blocked' | 'failed' | 'unknown'; planRef: Digest | null; localPlanRef: Digest | null; simulation: Simulation | null; receipt: Receipt | null; errors: FinanceErrorRecord[] }

/** PRD error taxonomy plus lower-level local codes. Unknown codes are mapped to INVALID_INPUT by `toErrorRecord`. */
export const ERROR_CODES = ['FEATURE_DISABLED', 'CONTRACT_MISMATCH', 'INVALID_INPUT', 'AUTH_REQUIRED', 'OWNER_SCOPE_MISMATCH', 'WRONG_CHAIN', 'UNSUPPORTED_ACCOUNT_MODEL', 'CAPABILITY_UNAVAILABLE',
  'FEATURE_STATE_UNKNOWN', 'COVERAGE_INCOMPLETE', 'MISSING_BOUND', 'POLICY_REJECTED', 'STALE_STATE', 'EXPIRED_PLAN', 'CODE_DRIFT', 'PERMISSION_MISSING', 'RESERVE_INSUFFICIENT',
  'TRUSTLINE_REQUIRED', 'DESTINATION_TAG_REQUIRED', 'SIMULATION_UNAVAILABLE', 'SIMULATION_FAILED', 'IDEMPOTENCY_CONFLICT', 'APPROVAL_REQUIRED', 'APPROVAL_REPLAY',
  'DEPENDENCY_TIMEOUT', 'SUBMISSION_UNKNOWN', 'RECONCILIATION_MISMATCH', 'PRIVACY_BLOCKED'] as const;
export type ErrorCode = typeof ERROR_CODES[number];
const RETRYABLE = new Set<ErrorCode>(['STALE_STATE', 'DEPENDENCY_TIMEOUT', 'EXPIRED_PLAN', 'SIMULATION_UNAVAILABLE']);
const NEVER_RETRY_RECOVERY: Partial<Record<ErrorCode, string>> = {
  SUBMISSION_UNKNOWN: 'Reconcile the known transaction reference. Do not resend or reuse the nonce/sequence.',
  RECONCILIATION_MISMATCH: 'Writes are halted for this account. Review native state before any new action.',
};
export class FinanceError extends Error {
  constructor(readonly code: ErrorCode, readonly detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}
export function insist(condition: unknown, code: ErrorCode, detail?: string): asserts condition { if (!condition) throw new FinanceError(code, detail); }
/** Typed, credential-free error. Lower-level detail stays in local logs only. */
export function toErrorRecord(error: unknown): FinanceErrorRecord {
  const code: ErrorCode = error instanceof FinanceError ? error.code : 'INVALID_INPUT';
  return { code, retryable: RETRYABLE.has(code), recovery: NEVER_RETRY_RECOVERY[code] ?? (RETRYABLE.has(code) ? 'Refresh state and prepare again within the remaining deadline.' : 'Correct the request or local profile. No action was authorized.') };
}

// ---------------------------------------------------------------- strict input boundary
/**
 * Bounded strict JSON decode: fatal UTF-8, size cap, duplicate-key and prototype-key rejection.
 * JSON.parse silently keeps the last duplicate key, so a tokenizer pass checks object keys first.
 */
export function strictParse(bytes: Uint8Array, maxBytes = MAX_INPUT_BYTES): unknown {
  insist(bytes.length <= maxBytes, 'INVALID_INPUT', 'input-too-large');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new FinanceError('INVALID_INPUT', 'invalid-utf8'); }
  assertUniqueKeys(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new FinanceError('INVALID_INPUT', 'invalid-json'); }
  assertSafeNumbers(value);
  return value;
}
function assertUniqueKeys(text: string): void {
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1, raw = '';
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\') { raw += text[j] + text[j + 1]; j += 2; } else raw += text[j++]; }
      insist(j < text.length, 'INVALID_INPUT', 'invalid-json');
      const top = stack.at(-1);
      if (top && expectKey) {
        let key: string; try { key = JSON.parse(`"${raw}"`) as string; } catch { throw new FinanceError('INVALID_INPUT', 'invalid-json'); }
        insist(key !== '__proto__' && key !== 'constructor' && key !== 'prototype', 'INVALID_INPUT', 'prototype-key');
        insist(!top.has(key), 'INVALID_INPUT', 'duplicate-key');
        top.add(key); expectKey = false;
      }
      i = j;
    } else if (c === '{') { stack.push(new Set()); expectKey = true; }
    else if (c === '[') { stack.push(null); }
    else if (c === '}' || c === ']') { stack.pop(); }
    else if (c === ',') { expectKey = stack.at(-1) instanceof Set; }
  }
}
function assertSafeNumbers(v: unknown): void {
  if (typeof v === 'number') insist(Number.isSafeInteger(v), 'INVALID_INPUT', 'unsafe-number');
  else if (Array.isArray(v)) v.forEach(assertSafeNumbers);
  else if (v && typeof v === 'object') Object.values(v).forEach(assertSafeNumbers);
}

// ---------------------------------------------------------------- structural validation
let ajv: Ajv2020 | undefined;
const validators = new Map<string, ValidateFunction>();
const schemaUrl = new URL('../../schemas/finance-v1.schema.json', import.meta.url);
/** Pinned schema load: file bytes and canonical contract digest are both checked before any validation. */
export function loadContract(): { schema: Record<string, unknown>; digest: Digest } {
  const bytes = readFileSync(schemaUrl);
  const manifest = JSON.parse(readFileSync(new URL('../../config/finance/schema-version.json', import.meta.url), 'utf8')) as { contractDigest: string; fileSha256: string };
  insist(sha256Hex(bytes) === manifest.fileSha256, 'CONTRACT_MISMATCH', 'schema-file');
  const schema = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  const digest = sha256Hex(canonicalBytes(schema));
  insist(digest === CONTRACT_DIGEST && manifest.contractDigest === CONTRACT_DIGEST && schema.$id === CONTRACT_ID, 'CONTRACT_MISMATCH', 'contract-digest');
  return { schema, digest };
}
export function isUtcTimestamp(value: string): boolean { const n = Date.parse(value); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(n) && new Date(n).toISOString() === value; }
function compiler(): Ajv2020 {
  if (ajv) return ajv;
  const a = new Ajv2020({ strict: true, allErrors: true });
  // Lesson f77c6a97: register formats explicitly instead of disabling them; no ajv-formats dependency.
  a.addFormat('date-time', isUtcTimestamp);
  a.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  a.addFormat('uri', (x: string) => { try { return Boolean(new URL(x)); } catch { return false; } });
  a.addSchema(loadContract().schema);
  return (ajv = a);
}
/** Structural acceptance only. Callers must still run the semantic checks for the definition. */
export function validate<T>(definition: string, value: unknown): T {
  let fn = validators.get(definition);
  if (!fn) { fn = compiler().getSchema(`${CONTRACT_ID}#/$defs/${definition}`); insist(fn, 'INVALID_INPUT', `unknown-definition:${definition}`); validators.set(definition, fn); }
  insist(fn(value), 'INVALID_INPUT', `schema:${definition}`);
  canonicalBytes(value);
  return structuredClone(value) as T;
}
export function isValid(definition: string, value: unknown): boolean { try { validate(definition, value); return true; } catch { return false; } }

// ---------------------------------------------------------------- hashes (bare lowercase hex, finance domains)
export const sha256Hex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const canonicalDigest = (value: unknown) => sha256Hex(canonicalBytes(value));
export type FinanceDomain = 'request' | 'research-plan' | 'local-plan' | 'approval' | 'action' | 'policy' | 'adapter' | 'event';
export function financeHash(domain: FinanceDomain, value: unknown): Digest {
  return createHash('sha256').update(`openx/finance/${domain}/1\n`, 'utf8').update(canonicalBytes(normalizeForHash(value))).digest('hex');
}
const omit = <T extends object>(v: T, key: string) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== key));
export const requestDigest = (request: unknown) => financeHash('request', request);
export const planHash = (plan: Omit<Plan, 'planHash'> | Plan) => financeHash('research-plan', omit(plan, 'planHash'));
export const localPlanHash = (plan: Omit<LocalPlan, 'localPlanHash'> | LocalPlan) => financeHash('local-plan', omit(plan, 'localPlanHash'));
export const policyHash = (profile: Omit<Profile, 'policyHash'> | Profile) => financeHash('policy', omit(profile, 'policyHash'));
export function grantSigningBytes(grant: Omit<ApprovalGrant, 'grantId' | 'signature'> | ApprovalGrant): Buffer {
  return Buffer.concat([Buffer.from('openx/finance/approval/1\n', 'utf8'), canonicalBytes(normalizeForHash(omit(omit(grant, 'grantId'), 'signature')))]);
}
export const grantId = (grant: Omit<ApprovalGrant, 'grantId' | 'signature'> | ApprovalGrant) => sha256Hex(grantSigningBytes(grant));
/** EVM addresses are lowercased only after checksum validation, so hashing never depends on caller casing. */
function normalizeForHash(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizeForHash);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeForHash(x)]));
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) return evmAddress(v).toLowerCase();
  return v;
}

// ---------------------------------------------------------------- native identities
export function evmAddress(value: string): string { try { return getAddress(value); } catch { throw new FinanceError('INVALID_INPUT', 'evm-address'); } }
const RIPPLE_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
/** XRPL classic address: base58 (ripple alphabet), version byte 0x00, 20-byte account ID, double-SHA256 checksum. */
export function xrplAccountId(address: string): Buffer {
  let n = 0n;
  for (const c of address) { const i = RIPPLE_ALPHABET.indexOf(c); insist(i >= 0, 'INVALID_INPUT', 'xrpl-address'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const leading = address.match(/^r*/)![0].length;
  const bytes = Buffer.concat([Buffer.alloc(leading), Buffer.from(hex, 'hex')]);
  insist(bytes.length === 25 && bytes[0] === 0, 'INVALID_INPUT', 'xrpl-address');
  const body = bytes.subarray(0, 21), check = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4);
  insist(check.equals(bytes.subarray(21)), 'INVALID_INPUT', 'xrpl-address-checksum');
  return Buffer.from(body.subarray(1));
}
export function xrplAddress(accountId: Uint8Array): string {
  insist(accountId.length === 20, 'INVALID_INPUT', 'xrpl-account-id');
  const body = Buffer.concat([Buffer.from([0]), accountId]);
  const full = Buffer.concat([body, createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4)]);
  let n = BigInt('0x' + full.toString('hex')), out = '';
  while (n > 0n) { out = RIPPLE_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of full) { if (b !== 0) break; out = 'r' + out; }
  return out;
}

// ---------------------------------------------------------------- amounts, time and native units
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_DROPS = 100_000_000_000n * 1_000_000n;
export function uint(value: string): bigint { insist(/^(0|[1-9][0-9]{0,77})$/.test(value), 'INVALID_INPUT', 'uint'); return BigInt(value); }
/** Validates Quantity against its asset's native width and canonical form. */
export function checkAmount(amount: Amount, opts: { positive?: boolean } = {}): void {
  const { asset, quantity: q } = amount;
  if (asset.kind === 'xrpl-issued') {
    insist(q.kind === 'issued-decimal', 'INVALID_INPUT', 'issued-requires-decimal');
    xrplAccountId(asset.issuer);
    insist(!/^0+$/.test(asset.currency) && asset.currency.toUpperCase() !== 'XRP', 'INVALID_INPUT', 'reserved-currency');
    const canonical = normalizeIssued(q.coefficient, q.exponent);
    insist(canonical.coefficient === q.coefficient && canonical.exponent === q.exponent, 'INVALID_INPUT', 'non-canonical-issued');
    if (opts.positive) insist(!q.coefficient.startsWith('-') && q.coefficient !== '0', 'INVALID_INPUT', 'amount-not-positive');
    return;
  }
  insist(q.kind === 'atomic', 'INVALID_INPUT', 'atomic-required');
  const v = uint(q.value);
  insist(v <= (asset.kind === 'xrp' ? MAX_DROPS : MAX_UINT256), 'INVALID_INPUT', 'amount-width');
  if (asset.kind === 'erc20') { evmAddress(asset.address); insist(asset.decimals <= 36, 'INVALID_INPUT', 'decimals'); }
  if (opts.positive) insist(v > 0n, 'INVALID_INPUT', 'amount-not-positive');
}
/** XRPL issued value: ≤16 significant digits, exponent -96..80, canonical zero 0e0, trailing zeros stripped within range. */
export function normalizeIssued(coefficient: string, exponent: number): { coefficient: string; exponent: number } {
  insist(/^-?(0|[1-9][0-9]*)$/.test(coefficient) && Number.isSafeInteger(exponent), 'INVALID_INPUT', 'issued');
  if (/^-?0$/.test(coefficient)) return { coefficient: '0', exponent: 0 };
  let c = coefficient, e = exponent;
  while (c.endsWith('0') && e < 80) { c = c.slice(0, -1); e++; }
  insist(c.replace('-', '').length <= 16 && e >= -96 && e <= 80, 'INVALID_INPUT', 'issued-range');
  return { coefficient: c, exponent: e };
}
/** Issued decimal to the XRPL `value` string without floating point. */
export function issuedToDecimal(q: { coefficient: string; exponent: number }): string {
  const neg = q.coefficient.startsWith('-'), digits = q.coefficient.replace('-', '');
  if (q.exponent >= 0) return (neg ? '-' : '') + digits + '0'.repeat(q.exponent);
  const padded = digits.padStart(-q.exponent + 1, '0'), cut = padded.length + q.exponent;
  return (neg ? '-' : '') + padded.slice(0, cut) + '.' + padded.slice(cut);
}
export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  if (a.kind === 'atomic' && b.kind === 'atomic') { const x = BigInt(a.value), y = BigInt(b.value); return x < y ? -1 : x > y ? 1 : 0; }
  insist(a.kind === 'issued-decimal' && b.kind === 'issued-decimal', 'INVALID_INPUT', 'quantity-kind-mismatch');
  const e = Math.min(a.exponent, b.exponent);
  const x = BigInt(a.coefficient) * 10n ** BigInt(a.exponent - e), y = BigInt(b.coefficient) * 10n ** BigInt(b.exponent - e);
  return x < y ? -1 : x > y ? 1 : 0;
}
export const assetKey = (asset: Asset) => canonicalDigest(normalizeForHash(asset));
export function parseTimestamp(value: string): number { insist(isUtcTimestamp(value), 'INVALID_INPUT', 'timestamp'); return Date.parse(value); }
/** XRPL native times count seconds since 2000-01-01T00:00:00Z (Ripple epoch). */
export const RIPPLE_EPOCH_OFFSET = 946_684_800;
export function rippleTimeToIso(seconds: number): string { insist(Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 0xffffffff, 'INVALID_INPUT', 'ripple-time'); return new Date((seconds + RIPPLE_EPOCH_OFFSET) * 1000).toISOString(); }
/** XLS-66 InterestRate is tenths of a basis point: annual fraction = raw / 100000 (raw 500 = 0.5%). */
export function xrplAnnualRate(raw: number): string {
  insist(Number.isSafeInteger(raw) && raw >= 0 && raw <= 100000, 'INVALID_INPUT', 'interest-rate');
  const s = raw.toString().padStart(6, '0');
  return `${s.slice(0, -5)}.${s.slice(-5)}`.replace(/0+$/, '').replace(/\.$/, '');
}

// ---------------------------------------------------------------- semantic network binding (rule 2)
export function checkAccount(account: Account, network: Network): void {
  if (account.family === 'evm') { insist(network !== 'xrpl' && CHAIN_IDS[network] === account.chainId, 'WRONG_CHAIN'); evmAddress(account.address); }
  else { insist(network === 'xrpl', 'WRONG_CHAIN'); xrplAccountId(account.address); }
}
export function checkAsset(asset: Asset, network: Network): void { insist(asset.network === network, 'WRONG_CHAIN', 'asset-network'); }
export const sameAccount = (a: Account, b: Account) => a.family === b.family && (a.family === 'evm' ? a.address.toLowerCase() === b.address.toLowerCase() && a.chainId === (b as typeof a).chainId : a.address === b.address);
export function checkObservation(o: Observation, network: Network, now: number, opts: { admission: boolean }): void {
  insist(o.network === network, 'WRONG_CHAIN', 'observation-network');
  insist((network === 'xrpl') === (o.point.kind === 'xrpl-ledger'), 'WRONG_CHAIN', 'observation-point');
  const observed = parseTimestamp(o.observedAt), expires = parseTimestamp(o.expiresAt);
  insist(expires > observed && observed <= now, 'INVALID_INPUT', 'observation-time');
  if (opts.admission) {
    insist(o.consistency === 'pinned', 'COVERAGE_INCOMPLETE', 'best-effort-state');
    insist(now < expires, 'STALE_STATE');
  }
}
export function checkConstraints(c: Constraints, network: Network): void {
  for (const list of [c.maxSpend, c.maxCosts, c.minReceive, c.maxDebtAfter, c.minCollateralAfter, c.minSupplyAfter]) {
    const keys = new Set<string>();
    for (const a of list) { checkAsset(a.asset, network); checkAmount(a); const k = assetKey(a.asset); insist(!keys.has(k), 'INVALID_INPUT', 'duplicate-bound'); keys.add(k); }
  }
}
/** Effective bounds intersect request and owner policy: maxima take the smaller, minima the larger; never loosen. */
export function intersectConstraints(policy: Constraints, request: Constraints): Constraints {
  const merge = (a: Amount[], b: Amount[], pick: 'min' | 'max') => {
    const out = new Map<string, Amount>();
    for (const x of [...a, ...b]) {
      const k = assetKey(x.asset), prev = out.get(k);
      if (!prev) { out.set(k, x); continue; }
      const cmp = compareQuantity(x.quantity, prev.quantity);
      if ((pick === 'min' && cmp < 0) || (pick === 'max' && cmp > 0)) out.set(k, x);
    }
    return [...out.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, v]) => v);
  };
  return {
    maxSpend: merge(policy.maxSpend, request.maxSpend, 'min'), maxCosts: merge(policy.maxCosts, request.maxCosts, 'min'),
    minReceive: merge(policy.minReceive, request.minReceive, 'max'), maxDebtAfter: merge(policy.maxDebtAfter, request.maxDebtAfter, 'min'),
    minCollateralAfter: merge(policy.minCollateralAfter, request.minCollateralAfter, 'max'), minSupplyAfter: merge(policy.minSupplyAfter, request.minSupplyAfter, 'max'),
    maxSlippageBps: Math.min(policy.maxSlippageBps, request.maxSlippageBps), maxStateAgeSeconds: Math.min(policy.maxStateAgeSeconds, request.maxStateAgeSeconds),
  };
}
/** True when `inner` is no looser than `outer` for every bound (used to prove a plan stayed inside policy). */
export function withinConstraints(inner: Constraints, outer: Constraints): boolean {
  try { return canonicalDigest(normalizeForHash(intersectConstraints(outer, inner))) === canonicalDigest(normalizeForHash(sortBounds(inner))); } catch { return false; }
}
function sortBounds(c: Constraints): Constraints { return intersectConstraints(c, c); }
/** Rule 7: preparation needs an explicit maximum for every spent asset and every cost asset. */
export function requireBounds(c: Constraints, spend: Amount[], costs: Cost[]): void {
  const bound = (list: Amount[], a: Amount) => list.find(x => assetKey(x.asset) === assetKey(a.asset));
  for (const s of spend) { const b = bound(c.maxSpend, s); insist(b, 'MISSING_BOUND', 'maxSpend'); insist(compareQuantity(s.quantity, b.quantity) <= 0, 'POLICY_REJECTED', 'spend-exceeds-bound'); }
  for (const cost of costs) { const b = bound(c.maxCosts, cost.maximum); insist(b, 'MISSING_BOUND', 'maxCosts'); insist(compareQuantity(cost.maximum.quantity, b.quantity) <= 0, 'POLICY_REJECTED', 'cost-exceeds-bound'); }
}

/** Plan semantic validation (rules 2, 5, 7, 9). Schema-valid plans are not admitted until this passes. */
export function checkPlan(plan: Plan, now: number): void {
  insist(plan.contractDigest === CONTRACT_DIGEST, 'CONTRACT_MISMATCH');
  insist(planHash(plan) === plan.planHash, 'INVALID_INPUT', 'plan-hash');
  checkAccount(plan.account, plan.network);
  checkObservation(plan.observation, plan.network, now, { admission: false });
  checkConstraints(plan.requestedConstraints, plan.network); checkConstraints(plan.effectiveConstraints, plan.network);
  insist(withinConstraints(plan.effectiveConstraints, plan.requestedConstraints), 'POLICY_REJECTED', 'effective-looser-than-requested');
  for (const c of plan.costs) { checkAsset(c.maximum.asset, plan.network); checkAmount(c.maximum); }
  const p = plan.nativePayload;
  if (p.kind === 'evm') {
    insist(plan.network !== 'xrpl' && p.chainId === CHAIN_IDS[plan.network], 'WRONG_CHAIN', 'payload-chain');
    insist(plan.account.family === 'evm', 'WRONG_CHAIN', 'payload-family');
    // EOA signs for itself; a position-owning smart account is called by its owner (verified by the adapter's owner pin).
    const bound = plan.account.model === 'eoa' ? evmAddress(p.from) : evmAddress(p.to);
    insist(bound === evmAddress(plan.account.address), 'OWNER_SCOPE_MISMATCH', 'payload-account');
  } else {
    insist(plan.network === 'xrpl' && plan.intent === 'payment', 'WRONG_CHAIN', 'payload-network');
    insist(p.tx.Account === plan.account.address && p.networkIdentityHash === plan.observation.networkIdentityHash, 'OWNER_SCOPE_MISMATCH', 'payload-account');
    xrplAccountId(p.tx.Destination);
  }
  parseTimestamp(plan.expiresAt);
}
