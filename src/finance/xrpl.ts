import {
  FinanceError, canonicalDigest, checkAmount, compareQuantity, insist, issuedToDecimal, normalizeIssued, rippleTimeToIso, xrplAccountId,
  type Account, type Amount, type Asset, type Cost, type EvidenceRef, type LocalPlan, type Observation, type Pin, type Plan, type XrplLoan, type XrplPayload,
} from './contracts.js';
import type { AccountRead, FinanceAdapter, Fresh, PositionRead, ReconcileResult, SimulationResult } from './adapter.js';

/** JSON-RPC transport to an admitted rippled host. Injected so tests run against a recorded/fake ledger. */
export interface XrplRpc { request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> }
export function httpXrplRpc(url: string, timeoutMs = 5_000): XrplRpc {
  const u = new URL(url); insist(u.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(u.hostname), 'POLICY_REJECTED', 'xrpl-tls');
  return { async request(method, params) {
    const res = await fetch(u, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) })
      .catch(() => { throw new FinanceError('DEPENDENCY_TIMEOUT', 'xrpl-rpc'); });
    const text = await res.text(); insist(text.length <= 1 << 20, 'DEPENDENCY_TIMEOUT', 'xrpl-body');
    const body = JSON.parse(text) as { result?: Record<string, unknown> }; insist(body.result, 'DEPENDENCY_TIMEOUT', 'xrpl-result');
    return body.result;
  } };
}
/** Decoded signed transaction view supplied by an exact-pinned optional codec (e.g. xrpl/ripple-binary-codec). */
export interface XrplCodec { readonly version: string; decode(blob: string): Record<string, unknown>; hashSigned(blob: string): string; verifySignature(blob: string): boolean }
/** Sign-only host: returns a blob, never submits. */
export interface XrplSignHost { readonly networkId: number; sign(tx: XrplPayload['tx']): Promise<string> }

/** Loads the optional codec only when enabled; absence or wrong pin is a capability gap, never a fallback. */
export async function loadXrplCodec(pinnedVersion: string | null, importer: (name: string) => Promise<unknown> = n => import(n)): Promise<XrplCodec | null> {
  if (!pinnedVersion) return null;
  let mod: { decode?: (b: string) => Record<string, unknown>; hashes?: { hashSignedTx?: (b: string) => string }; verifySignature?: (b: string) => boolean };
  try { mod = await importer('xrpl') as typeof mod; } catch { return null; }
  let version = '';
  try { version = (await importer('xrpl/package.json') as { default?: { version?: string }; version?: string }).default?.version ?? ''; } catch { return null; }
  if (version !== pinnedVersion || !mod.decode || !mod.hashes?.hashSignedTx || !mod.verifySignature) return null;
  const m = mod as Required<typeof mod> & { hashes: { hashSignedTx: (b: string) => string } };
  return { version, decode: b => m.decode(b), hashSigned: b => m.hashes.hashSignedTx(b), verifySignature: b => m.verifySignature(b) };
}
/** Rejects hosts that can broadcast (e.g. a wallet `signAndSend`) or that target another network. */
export function admitSignHost(host: unknown, networkId: number): XrplSignHost {
  const h = host as Record<string, unknown>;
  insist(h && typeof h.sign === 'function', 'PERMISSION_MISSING', 'xrpl-sign-host');
  insist(!['signAndSend', 'submit', 'submitAndWait', 'send'].some(k => k in h), 'POLICY_REJECTED', 'xrpl-host-can-broadcast');
  insist(h.networkId === networkId, 'WRONG_CHAIN', 'xrpl-host-network');
  return host as XrplSignHost;
}

// Ledger flag bits (rippled LedgerFormats). Loan flag values must be re-pinned against the deployed XLS-66 build.
const LSF_REQUIRE_DEST_TAG = 0x00020000, LSF_GLOBAL_FREEZE = 0x00400000;
export const LOAN_FLAGS = { defaulted: 0x00010000, impaired: 0x00020000, 'overpayment-allowed': 0x00040000 } as const;
const XRP: Extract<Asset, { kind: 'xrp' }> = { kind: 'xrp', network: 'xrpl', decimals: 6 };
const drops = (v: bigint): Amount => ({ asset: XRP, quantity: { kind: 'atomic', value: v.toString() } });
const ev = (content: unknown, expiresAt: string | null): EvidenceRef => ({ id: canonicalDigest({ kind: 'xrpl-read', content }), contentHash: canonicalDigest(content), expiresAt });
/** XRPL decimal string (e.g. "1.25", "-3e-2") to canonical coefficient/exponent; no floating point. */
export function parseIssuedValue(value: string): { coefficient: string; exponent: number } {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(value); insist(m, 'INVALID_INPUT', 'issued-value');
  const frac = m[3] ?? '', digits = (m[2] + frac).replace(/^0+(?=\d)/, '');
  return normalizeIssued((m[1] && !/^0+$/.test(digits) ? '-' : '') + digits, Number(m[4] ?? 0) - frac.length);
}

export class XrplFinanceAdapter implements FinanceAdapter {
  readonly network = 'xrpl' as const;
  constructor(readonly rpc: XrplRpc, readonly networkId: number, readonly codec: XrplCodec | null = null, readonly now: () => number = Date.now) {}
  get identityHash() { return canonicalDigest({ network: 'xrpl', networkId: this.networkId }); }

  capabilities() {
    return [
      { operation: 'portfolio', protocol: 'xrpl-native', admitted: true },
      { operation: 'positions', protocol: 'xls-66-read', admitted: true },
      { operation: 'payment', protocol: 'xrpl-payment', admitted: this.codec !== null },
    ];
  }

  /** One validated ledger for every read in a page; a different ledger hash in any response rejects the page. */
  private async validatedLedger(): Promise<{ index: number; hash: string }> {
    const info = await this.rpc.request('server_info', {});
    const nid = Number((info.info as Record<string, unknown> | undefined)?.network_id ?? 0);
    insist(nid === this.networkId, 'WRONG_CHAIN', 'xrpl-network-id');
    const l = await this.rpc.request('ledger', { ledger_index: 'validated' });
    insist(l.validated === true && typeof l.ledger_hash === 'string' && typeof l.ledger_index === 'number', 'STALE_STATE', 'ledger-not-validated');
    return { index: l.ledger_index as number, hash: (l.ledger_hash as string).toUpperCase() };
  }
  private async at(ledger: { index: number; hash: string }, method: string, params: Record<string, unknown>) {
    const r = await this.rpc.request(method, { ...params, ledger_index: ledger.index });
    if (r.error) return r;
    insist(r.validated === true && (r.ledger_hash === undefined || (r.ledger_hash as string).toUpperCase() === ledger.hash) && (r.ledger_index === undefined || r.ledger_index === ledger.index), 'STALE_STATE', 'mixed-ledger');
    return r;
  }
  private observation(ledger: { index: number; hash: string }, maxAgeSeconds: number, content: unknown): Observation {
    const observedAt = new Date(this.now()).toISOString(), expiresAt = new Date(this.now() + maxAgeSeconds * 1000).toISOString();
    return { network: 'xrpl', networkIdentityHash: this.identityHash, point: { kind: 'xrpl-ledger', index: ledger.index.toString(), hash: ledger.hash, validated: true }, observedAt, expiresAt, consistency: 'pinned', fidelity: 'chain-read', sources: [ev({ ledger, content }, expiresAt)] };
  }

  private async reserves(ledger: { index: number; hash: string }) {
    const s = await this.rpc.request('server_state', {});
    const v = (s.state as Record<string, unknown> | undefined)?.validated_ledger as Record<string, unknown> | undefined;
    insist(v && typeof v.reserve_base === 'number' && typeof v.reserve_inc === 'number' && v.seq === ledger.index, 'STALE_STATE', 'reserve-ledger');
    return { base: BigInt(v.reserve_base as number), inc: BigInt(v.reserve_inc as number) };
  }

  async readAccount(account: Account, _assets: Asset[] = [], maxAgeSeconds = 30): Promise<AccountRead & { sequence: number; ledgerIndex: number; flags: number; lines: Array<Record<string, unknown>> }> {
    insist(account.family === 'xrpl', 'WRONG_CHAIN'); xrplAccountId(account.address);
    const ledger = await this.validatedLedger();
    const info = await this.at(ledger, 'account_info', { account: account.address, strict: true });
    insist(!info.error, 'COVERAGE_INCOMPLETE', 'account-not-found');
    const data = info.account_data as Record<string, unknown>;
    const lines = await this.at(ledger, 'account_lines', { account: account.address, limit: 200 });
    insist(!lines.marker, 'COVERAGE_INCOMPLETE', 'trustline-page-limit');
    const r = await this.reserves(ledger);
    const reserved = r.base + r.inc * BigInt(data.OwnerCount as number);
    const balances: Amount[] = [drops(BigInt(data.Balance as string))];
    for (const l of (lines.lines as Array<Record<string, unknown>>) ?? []) {
      const q = parseIssuedValue(l.balance as string);
      balances.push({ asset: { kind: 'xrpl-issued', network: 'xrpl', currency: l.currency as string, issuer: l.account as string }, quantity: { kind: 'issued-decimal', ...q } });
    }
    return { balances, reservedXrp: drops(reserved), observation: this.observation(ledger, maxAgeSeconds, { data, lines: lines.lines ?? [] }), sequence: data.Sequence as number, ledgerIndex: ledger.index, flags: data.Flags as number, lines: (lines.lines as Array<Record<string, unknown>>) ?? [] };
  }

  /**
   * XLS-66 loan statements, read only when the LendingProtocol amendment is verified enabled.
   * Loan → LoanBroker → Vault are joined at the same validated ledger; missing joins stay incomplete.
   */
  async readPositions(account: Account, maxAgeSeconds = 30): Promise<PositionRead> {
    insist(account.family === 'xrpl', 'WRONG_CHAIN');
    const ledger = await this.validatedLedger();
    const observation = this.observation(ledger, maxAgeSeconds, { account: account.address });
    const missing: Array<{ capability: string; reasonCode: string }> = [];
    const feature = await this.rpc.request('feature', { feature: 'LendingProtocol' });
    const entry = Object.values(feature).find(v => v && typeof v === 'object' && (v as Record<string, unknown>).name === 'LendingProtocol') as Record<string, unknown> | undefined;
    if (!entry || entry.enabled !== true) return { positions: [], observation, coverage: { complete: false, missing: [{ capability: 'xls-66-loans', reasonCode: entry ? 'CAPABILITY_UNAVAILABLE' : 'FEATURE_STATE_UNKNOWN' }], cursor: null } };
    const objects = await this.at(ledger, 'account_objects', { account: account.address, type: 'loan', limit: 100 });
    if (objects.error) return { positions: [], observation, coverage: { complete: false, missing: [{ capability: 'xls-66-loans', reasonCode: 'COVERAGE_INCOMPLETE' }], cursor: null } };
    const positions: XrplLoan[] = [];
    for (const loan of (objects.account_objects as Array<Record<string, unknown>>) ?? []) {
      const loanId = String(loan.index ?? '').toUpperCase();
      try {
        const broker = await this.at(ledger, 'ledger_entry', { index: loan.LoanBrokerID });
        const brokerNode = broker.node as Record<string, unknown> | undefined; insist(brokerNode, 'COVERAGE_INCOMPLETE', 'broker');
        const vault = await this.at(ledger, 'ledger_entry', { index: brokerNode.VaultID });
        const vaultNode = vault.node as Record<string, unknown> | undefined; insist(vaultNode && vaultNode.Asset, 'COVERAGE_INCOMPLETE', 'vault');
        const asset = vaultAsset(vaultNode.Asset as Record<string, unknown>);
        const amount = (field: string) => loanAmount(asset, loan[field]);
        const flags = Number(loan.Flags ?? 0);
        positions.push({
          kind: 'xrpl-loan', account, loanId, loanBrokerId: String(loan.LoanBrokerID).toUpperCase(),
          positionId: canonicalDigest({ network: 'xrpl', loanId }), assetResolutionRef: canonicalDigest({ ledger: ledger.hash, broker: brokerNode.index ?? loan.LoanBrokerID, vault: brokerNode.VaultID, asset: vaultNode.Asset }),
          principalOutstanding: amount('PrincipalOutstanding'), totalValueOutstanding: amount('TotalValueOutstanding'), managementFeeOutstanding: amount('ManagementFeeOutstanding'), periodicPayment: amount('PeriodicPayment'),
          interestRateTenthsBps: int(loan.InterestRate ?? 0, 100000), paymentRemaining: int(loan.PaymentRemaining, 0xffffffff),
          nextDueAt: loan.NextPaymentDueDate === undefined ? null : rippleTimeToIso(int(loan.NextPaymentDueDate, 0xffffffff)), gracePeriodSeconds: int(loan.GracePeriod ?? 0, 0xffffffff),
          loanScale: loan.LoanScale === undefined ? null : int(loan.LoanScale, 2147483647, -2147483648),
          flags: (Object.entries(LOAN_FLAGS) as Array<[XrplLoan['flags'][number], number]>).filter(([, bit]) => (flags & bit) !== 0).map(([n]) => n),
          observation,
        });
      } catch (e) { missing.push({ capability: `loan:${loanId}`, reasonCode: e instanceof FinanceError ? e.code : 'COVERAGE_INCOMPLETE' }); }
    }
    return { positions, observation, coverage: { complete: missing.length === 0 && !objects.marker, missing: objects.marker ? [...missing, { capability: 'xls-66-loans', reasonCode: 'COVERAGE_INCOMPLETE' }] : missing, cursor: null } };
  }

  /**
   * Payment-only builder: no Paths/SendMax/DeliverMin/partial flags. Fee, reserve and sequence are
   * read live; destination tag, trust line and issuer freeze prerequisites are explained, not guessed.
   */
  async buildPayment(account: Account, destination: string, amount: Amount, destinationTag: number | null): Promise<{ payload: XrplPayload; costs: Cost[]; observation: Observation }> {
    insist(account.family === 'xrpl', 'WRONG_CHAIN'); xrplAccountId(destination); checkAmount(amount, { positive: true });
    insist(destination !== account.address, 'INVALID_INPUT', 'self-payment');
    const me = await this.readAccount(account);
    const ledger = { index: me.ledgerIndex, hash: me.observation.point.kind === 'xrpl-ledger' ? me.observation.point.hash : '' };
    const fee = await this.currentFee();
    const dest = await this.at(ledger, 'account_info', { account: destination, strict: true });
    const r = await this.reserves(ledger);
    const spendable = BigInt((me.balances[0].quantity as { value: string }).value) - BigInt((me.reservedXrp!.quantity as { value: string }).value) - fee;
    let txAmount: XrplPayload['tx']['Amount'];
    if (amount.asset.kind === 'xrp') {
      const v = BigInt((amount.quantity as { value: string }).value);
      insist(spendable >= v, 'RESERVE_INSUFFICIENT', 'spendable-xrp');
      insist(!dest.error || v >= r.base, 'RESERVE_INSUFFICIENT', 'destination-account-reserve');
      txAmount = v.toString();
    } else {
      insist(amount.asset.kind === 'xrpl-issued' && amount.quantity.kind === 'issued-decimal', 'INVALID_INPUT', 'issued-amount');
      insist(spendable >= 0n, 'RESERVE_INSUFFICIENT', 'fee');
      insist(!dest.error, 'TRUSTLINE_REQUIRED', 'destination-missing');
      const { currency, issuer } = amount.asset;
      const issuerInfo = await this.at(ledger, 'account_info', { account: issuer, strict: true });
      insist(!issuerInfo.error, 'COVERAGE_INCOMPLETE', 'issuer');
      insist((Number((issuerInfo.account_data as Record<string, unknown>).Flags) & LSF_GLOBAL_FREEZE) === 0, 'POLICY_REJECTED', 'issuer-global-freeze');
      if (account.address !== issuer) {
        const line = me.lines.find(l => l.account === issuer && l.currency === currency);
        insist(line, 'TRUSTLINE_REQUIRED', 'sender-trustline');
        insist(!line.freeze && !line.freeze_peer, 'POLICY_REJECTED', 'trustline-frozen');
        const bal = parseIssuedValue(line.balance as string);
        insist(compareQuantity({ kind: 'issued-decimal', ...bal }, amount.quantity) >= 0, 'RESERVE_INSUFFICIENT', 'issued-balance');
      }
      if (destination !== issuer) {
        const lines = await this.at(ledger, 'account_lines', { account: destination, peer: issuer, limit: 200 });
        const line = ((lines.lines as Array<Record<string, unknown>>) ?? []).find(l => l.currency === currency);
        insist(line && !line.freeze && !line.freeze_peer, 'TRUSTLINE_REQUIRED', 'destination-trustline');
      }
      txAmount = { currency, issuer, value: issuedToDecimal(amount.quantity) };
    }
    const destFlags = dest.error ? 0 : Number((dest.account_data as Record<string, unknown>).Flags);
    insist((destFlags & LSF_REQUIRE_DEST_TAG) === 0 || destinationTag !== null, 'DESTINATION_TAG_REQUIRED');
    const tx: XrplPayload['tx'] = { TransactionType: 'Payment', Account: account.address, Destination: destination, Amount: txAmount, Fee: fee.toString(), Sequence: me.sequence, LastLedgerSequence: me.ledgerIndex + 20, Flags: 0, ...(destinationTag === null ? {} : { DestinationTag: destinationTag }) };
    const costs: Cost[] = [{ kind: 'xrpl-fee', payer: 'user', maximum: drops(fee), sourceRef: ev({ fee: fee.toString(), ledger: me.ledgerIndex }, me.observation.expiresAt) }];
    return { payload: { kind: 'xrpl-payment', networkIdentityHash: this.identityHash, tx }, costs, observation: me.observation };
  }
  private async currentFee(): Promise<bigint> {
    const f = await this.rpc.request('fee', {});
    const d = f.drops as Record<string, string> | undefined; insist(d && /^\d+$/.test(d.open_ledger_fee ?? '') && /^\d+$/.test(d.base_fee ?? ''), 'DEPENDENCY_TIMEOUT', 'fee');
    const open = BigInt(d.open_ledger_fee), base = BigInt(d.base_fee);
    return open > base ? open : base;
  }

  async admitPayload(plan: Plan): Promise<Pin[]> {
    insist(plan.nativePayload.kind === 'xrpl-payment' && plan.network === 'xrpl' && plan.intent === 'payment', 'CAPABILITY_UNAVAILABLE', 'xrpl-payment-only');
    insist(plan.nativePayload.networkIdentityHash === this.identityHash, 'WRONG_CHAIN', 'xrpl-network-identity');
    const tx = plan.nativePayload.tx as Record<string, unknown>;
    for (const k of ['Paths', 'SendMax', 'DeliverMin', 'NetworkID', 'Signers', 'TxnSignature', 'SigningPubKey']) insist(!(k in tx), 'POLICY_REJECTED', `xrpl-field:${k}`);
    return [{ kind: 'network', id: `xrpl:${this.networkId}`, hash: this.identityHash }, { kind: 'owner-model', id: plan.account.address, hash: canonicalDigest({ model: 'native' }) }];
  }
  async freshPayload(input: LocalPlan['nativePayload']): Promise<Fresh> {
    insist(input.kind === 'xrpl-payment', 'WRONG_CHAIN');
    const account: Account = { family: 'xrpl', address: input.tx.Account, model: 'native' };
    const amount: Amount = typeof input.tx.Amount === 'string' ? drops(BigInt(input.tx.Amount))
      : { asset: { kind: 'xrpl-issued', network: 'xrpl', currency: input.tx.Amount.currency, issuer: input.tx.Amount.issuer }, quantity: { kind: 'issued-decimal', ...parseIssuedValue(input.tx.Amount.value) } };
    const built = await this.buildPayment(account, input.tx.Destination, amount, input.tx.DestinationTag ?? null);
    return { payload: built.payload, cost: built.costs[0], observation: built.observation };
  }

  /** Native simulation via rippled `simulate`; an unsupported host leaves the write unavailable. */
  async simulateExact(plan: LocalPlan): Promise<SimulationResult> {
    insist(plan.nativePayload.kind === 'xrpl-payment', 'WRONG_CHAIN');
    const r = await this.rpc.request('simulate', { tx_json: plan.nativePayload.tx });
    if (r.error) throw new FinanceError('SIMULATION_UNAVAILABLE', String(r.error));
    const result = String(r.engine_result ?? (r.meta as Record<string, unknown> | undefined)?.TransactionResult ?? '');
    const tx = plan.nativePayload.tx;
    const spend = typeof tx.Amount === 'string' ? [drops(BigInt(tx.Amount))] : [];
    return { fidelity: 'native', pass: result === 'tesSUCCESS', postconditionsPass: result === 'tesSUCCESS', expectedSpend: spend, expectedReceive: [], errors: result === 'tesSUCCESS' ? [] : [result || 'unknown-engine-result'], observation: plan.observation };
  }

  /** The blob must decode to exactly the approved fields plus SigningPubKey/TxnSignature. */
  validateSignedArtifact(plan: LocalPlan, signed: string): { transactionId: string } {
    insist(this.codec, 'CAPABILITY_UNAVAILABLE', 'xrpl-codec');
    insist(plan.nativePayload.kind === 'xrpl-payment' && /^[0-9A-Fa-f]+$/.test(signed) && signed.length > 0, 'SIMULATION_FAILED', 'empty-or-invalid-blob');
    const decoded = this.codec.decode(signed);
    const { SigningPubKey, TxnSignature, ...rest } = decoded;
    insist(typeof SigningPubKey === 'string' && SigningPubKey.length > 0 && typeof TxnSignature === 'string' && TxnSignature.length > 0, 'SIMULATION_FAILED', 'unsigned-blob');
    insist(canonicalDigest(rest) === canonicalDigest(plan.nativePayload.tx), 'SIMULATION_FAILED', 'signed-artifact-mismatch');
    insist(this.codec.verifySignature(signed), 'SIMULATION_FAILED', 'xrpl-signature');
    return { transactionId: this.codec.hashSigned(signed).toUpperCase() };
  }
  async submitKnownArtifact(signed: string): Promise<string> {
    const r = await this.rpc.request('submit', { tx_blob: signed });
    const hash = (r.tx_json as Record<string, unknown> | undefined)?.hash;
    if (typeof hash !== 'string') throw new FinanceError('SUBMISSION_UNKNOWN', 'no-hash');
    return hash.toUpperCase();
  }

  /** Only a validated ledger result is final; a tec* result consumed the fee and is reported as FAILED. */
  async reconcileKnownReference(plan: LocalPlan, transactionId: string): Promise<ReconcileResult> {
    insist(plan.nativePayload.kind === 'xrpl-payment', 'WRONG_CHAIN');
    const r = await this.rpc.request('tx', { transaction: transactionId });
    const lls = plan.nativePayload.tx.LastLedgerSequence;
    if (r.error || r.validated !== true) {
      const l = await this.rpc.request('ledger', { ledger_index: 'validated' });
      return { state: !r.error || typeof l.ledger_index !== 'number' || l.ledger_index <= lls ? 'UNKNOWN' : 'EXPIRED', reconciliation: r.error && typeof l.ledger_index === 'number' && l.ledger_index > lls ? 'MATCH' : 'UNKNOWN', effects: [], evidence: [] };
    }
    const meta = r.meta as Record<string, unknown>, result = String(meta?.TransactionResult);
    insist(r.Account === plan.nativePayload.tx.Account && r.Sequence === plan.nativePayload.tx.Sequence, 'RECONCILIATION_MISMATCH', 'tx-identity');
    const fee = drops(BigInt(String(r.Fee)));
    const evidence = [ev({ transactionId, ledger: r.ledger_index ?? null, result }, null)];
    if (result !== 'tesSUCCESS') return { state: 'FAILED', reconciliation: result.startsWith('tec') ? 'MATCH' : 'UNKNOWN', effects: [fee], evidence };
    const delivered = meta.delivered_amount;
    const match = canonicalDigest(delivered) === canonicalDigest(plan.nativePayload.tx.Amount);
    return { state: 'FINALIZED', reconciliation: match ? 'MATCH' : 'MISMATCH', effects: [fee], evidence };
  }
}

function vaultAsset(a: Record<string, unknown>): Asset {
  if (a.currency === 'XRP' && a.issuer === undefined) return XRP;
  insist(typeof a.currency === 'string' && typeof a.issuer === 'string', 'COVERAGE_INCOMPLETE', a.mpt_issuance_id ? 'mpt-asset-requires-v2' : 'vault-asset');
  return { kind: 'xrpl-issued', network: 'xrpl', currency: a.currency, issuer: a.issuer };
}
/** XLS-66 Number fields in the vault asset's units. XRP must be integral drops; anything else is incomplete. */
function loanAmount(asset: Asset, raw: unknown): Amount {
  insist(raw !== undefined && raw !== null, 'COVERAGE_INCOMPLETE', 'loan-field');
  const q = parseIssuedValue(String(raw));
  if (asset.kind === 'xrp') { insist(q.exponent >= 0 && !q.coefficient.startsWith('-'), 'COVERAGE_INCOMPLETE', 'loan-xrp-units'); return drops(BigInt(q.coefficient) * 10n ** BigInt(q.exponent)); }
  return { asset, quantity: { kind: 'issued-decimal', ...q } };
}
function int(v: unknown, max: number, min = 0): number { const n = Number(v); insist(Number.isSafeInteger(n) && n >= min && n <= max, 'COVERAGE_INCOMPLETE', 'loan-integer'); return n; }
