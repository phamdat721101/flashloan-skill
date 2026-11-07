import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { getAddress, type Address, type Hex } from 'viem';
import { canonicalBytes, domainHash } from '../evidence/integration.js';

export { canonicalBytes };
export const BASE_CHAIN_ID = 8453;
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
export const CTF = '0xC9c98965297Bc527861c898329Ee280632B76e18' as Address;
export const SDK_VERSION = '1.3.0';
export type Mode = 'paper' | 'assisted' | 'autonomous';
export type Hash = `sha256:${string}`;
export class PredictionError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); }
}
export function insist(condition: unknown, code: string): asserts condition { if (!condition) throw new PredictionError(code); }
export const hash = (domain: string, value: unknown): Hash => domainHash(`prediction/${domain}/1`, value);
export const unsigned = <T extends { signature: string }>(value: T): Omit<T, 'signature'> => { const { signature: _, ...body } = value; return body; };
export function raw(value: string): bigint { insist(/^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78, 'INVALID_AMOUNT'); return BigInt(value); }
export function addr(value: string): Address { try { return getAddress(value); } catch { throw new PredictionError('INVALID_ADDRESS'); } }
export function date(value: string): number { const n = Date.parse(value); insist(Number.isFinite(n) && new Date(n).toISOString() === value, 'INVALID_TIMESTAMP'); return n; }

export interface Limits {
  maxOrderSpendRaw: string; maxOpenExposureRaw: string; maxDailyLossRaw: string;
  maxOrdersPerDay: number; maxOpenOrders: number; maxGasPerTxRaw: string; maxGasPerDayRaw: string;
}
export interface Pin { address: Address; codeHash: Hex; role: 'exchange' | 'adapter' | 'feeModule' | 'usdc' | 'ctf' }
export interface PredictionConfig {
  schemaVersion: 'prediction-config/1'; enabled: boolean; live: boolean; accountId: string; address: Address;
  apiUrl: string; rpcUrl: string; wsUrl: string; stateDir: string; approvalPublicKey: string;
  tokenIdEnv: string; tokenSecretEnv: string; signerKeyFileEnv: string;
  eligible: boolean; eligibilityEvidence: string; allowedMarkets: string[]; pins: Pin[]; limits: Limits;
  quoteTtlMs: number; reconcileIntervalMs: number; maxWatchedMarkets: number; readConcurrency: number;
  grantMaxTtlMs: number; planTtlMs: number; finality: 'safe' | 'finalized'; wsHints: boolean;
  transportProfile: 'production' | 'fixture';
  paperCashRaw: string;
}
export interface Evidence { source: string; observedAt: string; hash: Hash; fidelity: 'provider' | 'chain' | 'fixture' | 'paper' }
export interface MarketSnapshot {
  schemaVersion: 'prediction-market/1'; snapshotId: Hash; marketId: string; slug: string; conditionId: Hex;
  chainId: 8453; type: 'binary' | 'negrisk'; status: 'open' | 'closed' | 'resolved';
  tokens: { yes: string; no: string }; exchange: Address; adapter: Address | null; feeModule: Address | null;
  feeModel: 'legacy' | 'collateral'; feeEnabled: boolean; tickPpm: number; sizeStepRaw: string;
  feeRateBps: number; feeCapBps: number; rulesHash: Hash; observedAt: string; evidence: Evidence[];
}
export interface AccountSnapshot {
  schemaVersion: 'prediction-account/1'; accountId: string; address: Address; profileId: number; mode: 'eoa';
  usdcRaw: string; yesRaw: string; noRaw: string; feeRateBps: number; observedAt: string; blockHash: Hex; blockNumber: string;
}
export interface TradeIntent {
  schemaVersion: 'prediction-intent/1'; intentId: string; accountId: string; marketSlug: string;
  outcome: 'YES' | 'NO'; side: 'BUY' | 'SELL'; orderType: 'FAK' | 'GTC'; limitPricePpm: number;
  sharesRaw?: string; spendCapRaw?: string; sharesCapRaw?: string; postOnly?: boolean;
}
/** SDK 1.3.0 requires safe integer numeric fields; agent-facing amounts stay strings. */
export interface UnsignedOrder {
  salt: number; maker: string; signer: string; taker: string; tokenId: string; makerAmount: number; takerAmount: number;
  expiration: string; nonce: number; feeRateBps: number; side: number; signatureType: number; price?: number;
}
export interface ApprovalCall { to: Address; data: Hex; value: '0x0'; permission: 'erc20-bounded' | 'erc1155-operator'; spender: Address; amountRaw: string }
export interface TradePlan {
  schemaVersion: 'prediction-plan/1'; planHash: Hash; mode: Mode; policyHash: Hash; intent: TradeIntent;
  accountId: string; market: MarketSnapshot; account: AccountSnapshot; order: UnsignedOrder;
  clientOrderId: string; createdAt: string; validUntil: string; reserveRaw: string; feeReserveRaw: string;
  feeAsset: 'USDC' | 'SHARES' | 'NONE'; approvals: ApprovalCall[]; estimatedGasUpperRaw: string;
}
export type Action = 'trade' | 'cancel' | 'approve' | 'redeem' | 'resume';
export interface ExecutionGrant {
  schemaVersion: 'prediction-grant/1'; grantId: string; kind: 'order' | 'session'; accountId: string; policyHash: Hash;
  planHash: Hash | null; marketSlugs: string[]; actions: Action[]; limits: Limits;
  issuedAt: string; expiresAt: string; cleanupCancel: boolean; signature: string;
}
export interface FillRecord {
  fillId: string; orderId: string; clientOrderId: string; marketSlug: string; tokenId: string; side: 'BUY' | 'SELL';
  sharesGrossRaw: string; sharesFeeRaw: string; sharesNetRaw: string; usdGrossRaw: string; usdFeeRaw: string;
  txHash: Hex; blockHash: Hex; blockNumber: string; finality: 'safe' | 'finalized'; occurredAt: string;
  transactionIndex: number; logIndex: number;
  fidelity: 'chain' | 'paper' | 'fixture';
}
export type OrderState = 'open' | 'partially-filled' | 'filled' | 'cancelled' | 'rejected' | 'unknown';
export type SettlementState = 'none' | 'delayed' | 'matched' | 'mined' | 'confirmed' | 'retrying' | 'failed' | 'unknown';
export interface OrderObservation {
  clientOrderId: string; orderId: string | null; state: OrderState; settlement: SettlementState; fills: FillRecord[];
}
export interface OrderRecord {
  plan: TradePlan; grant: ExecutionGrant | null; submission: 'reserved' | 'dispatching' | 'acknowledged' | 'acceptance-unknown';
  orderId: string | null; state: OrderState; settlement: SettlementState;
  fills: FillRecord[]; cancelRequested: boolean;
}
export interface PositionSnapshot {
  schemaVersion: 'prediction-position/1'; tokenId: string; marketSlug: string; sharesRaw: string; reservedSharesRaw: string;
  costBasisRaw: string; realizedPnlRaw: string; fidelity: 'paper' | 'chain' | 'fixture';
}
export type LedgerEvent = {
  schemaVersion: 'prediction-event/1'; sequence: number; previousHash: Hash; eventHash: Hash; occurredAt: string;
  kind: 'plan' | 'reserve' | 'dispatch' | 'unknown' | 'observation' | 'cancel-request' | 'halt' | 'resume' | 'chain-pending' | 'chain-confirmed' | 'redeemed' | 'paper-redeemed';
  data: unknown;
};
export interface Request {
  schemaVersion: 'prediction-request/1'; requestId: string;
  command: 'capabilities' | 'doctor' | 'markets' | 'market' | 'positions' | 'prepare' | 'execute' | 'reconcile' | 'cancel' | 'redeem' | 'watch' | 'halt' | 'resume';
  payload: { mode: Mode; intent?: TradeIntent; planHash?: Hash; grant?: ExecutionGrant; marketSlug?: string; clientOrderId?: string; publicOnly?: boolean; durationMs?: number; reason?: string };
}
export interface Result {
  schemaVersion: 'prediction-result/1'; requestId: string; command: Request['command']; mode: Mode;
  outcome: 'ok' | 'blocked' | 'pending' | 'failed'; data: unknown;
  errors: Array<{ code: string; retryable: boolean; recovery: string }>; evidence: Evidence[];
}

let ajv: Ajv2020 | undefined;
const validators = new Map<string, ValidateFunction>();
export function validate<T>(name: string, value: unknown): T {
  if (!ajv) {
    const bytes = readFileSync(new URL('../../schemas/prediction-v1.schema.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(new URL('../../config/prediction/schema-version.json', import.meta.url), 'utf8')) as { sha256: string };
    insist(createHash('sha256').update(bytes).digest('hex') === manifest.sha256, 'SCHEMA_PIN_MISMATCH');
    ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addSchema(JSON.parse(bytes.toString('utf8')));
  }
  let fn = validators.get(name);
  if (!fn) { fn = ajv.getSchema(`urn:prediction:1#/$defs/${name}`); insist(fn, 'SCHEMA_UNKNOWN'); validators.set(name, fn); }
  insist(fn(value), 'SCHEMA_INVALID');
  const result = structuredClone(value) as T;
  // Reject representations canonical JSON cannot bind unambiguously.
  canonicalBytes(result);
  return result;
}
export function policyHash(config: PredictionConfig): Hash {
  const { enabled: _, live: __, wsHints: ___, ...policy } = config;
  return hash('policy', policy); // Disabling placement must not revoke already-authorized cancellation cleanup.
}
export function planHash(plan: Omit<TradePlan, 'planHash'> | TradePlan): Hash {
  const { planHash: _, ...body } = plan as TradePlan; return hash('plan', body);
}
export function collateralFeeRaw(notional: bigint, shares: bigint, rateBps: number): bigint {
  insist(shares > 0n && notional >= 0n && notional <= shares && Number.isSafeInteger(rateBps) && rateBps >= 0 && rateBps <= 500, 'FEE_PROGRAM_UNKNOWN');
  const numerator = BigInt(rateBps) * notional * (shares - notional), denominator = 10_000n * shares;
  return ((numerator + 5n * denominator) / (10n * denominator)) * 10n;
}
export function sdkNumber(valueRaw: string): number {
  const n = raw(valueRaw); insist(n <= BigInt(Number.MAX_SAFE_INTEGER), 'SDK_PRECISION_UNSUPPORTED');
  const result = Number(n) / 1e6;
  insist(BigInt(result.toFixed(6).replace('.', '')) === n, 'SDK_PRECISION_UNSUPPORTED');
  return result;
}
