import { bcs } from '@mysten/sui/bcs';
import type { Signer } from '@mysten/sui/cryptography';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { normalizeSuiAddress, normalizeStructTag } from '@mysten/sui/utils';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { digest, isSuiDigest, uint } from './state.js';
import type { Admission, LiquidityExecutionAdapter, RouteCandidate, SimulationProof } from './runtime.js';
import type { SuiVersionedRef } from './sui-state.js';

const SUI = normalizeStructTag('0x2::sui::SUI');
const ProfitSwept = bcs.struct('ProfitSwept', { amount: bcs.u64(), treasury: bcs.Address, operator: bcs.Address, route_hash: bcs.vector(bcs.u8()) });
export interface ExactSuiPayload {
  candidate: RouteCandidate; transactionBytes: Uint8Array; stateRefs: SuiVersionedRef[]; routeHash: string;
}
export interface SuiExecutionConfig {
  rpcUrl: string; network: 'mainnet' | 'testnet' | 'localnet'; chainIdentifier: string;
  admission: Admission; packageDigests: Record<string, string>; allowedMoveCalls: string[];
  requiredStateObjectIds: string[]; allowedOwnedInputIds: string[];
  guardPackage: string; guardEventType: string; treasury: string;
  borrowTarget: string; repayTarget: string; borrowAmountArgument: number;
  receiptReturnIndex: number; repayReceiptArgument: number;
}

/** Executes fully resolved, review-admitted PTBs only. It does not infer venue
 * ABIs, select a gas coin, rebuild bytes, or turn a simulation into admission.
 * Only native SUI profit accounting is supported until a pinned oracle exists.
 */
export class SuiLiquidityExecutionAdapter implements LiquidityExecutionAdapter {
  readonly admission: Admission;
  private readonly config: SuiExecutionConfig;
  private readonly payloads = new Map<string, ExactSuiPayload>();
  private readonly signed = new Map<string, ExactSuiPayload>();
  private readonly client: SuiGrpcClient;
  constructor(config: SuiExecutionConfig, private readonly signer: Signer, payloads: readonly ExactSuiPayload[], client?: SuiGrpcClient) {
    const url = new URL(config.rpcUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('INSECURE_EXECUTION_ENDPOINT');
    if (!isSuiDigest(config.chainIdentifier) || config.admission.chain !== 'sui' || config.admission.network !== config.network || payloads.length > 1000 || config.requiredStateObjectIds.length > 1000 || config.allowedMoveCalls.length > 100 || [config.borrowAmountArgument, config.receiptReturnIndex, config.repayReceiptArgument].some(value => !Number.isInteger(value) || value < 0 || value > 10) || config.borrowTarget === config.repayTarget || !normalizeStructTag(config.guardEventType).endsWith(`::terminal_profit_guard::ProfitSwept<${SUI}>`) || new Set(config.requiredStateObjectIds.map(value => normalizeSuiAddress(value))).size !== config.requiredStateObjectIds.length) throw new Error('INVALID_EXECUTION_CONFIG');
    this.config = structuredClone(config); this.admission = Object.freeze(structuredClone(config.admission));
    this.client = client ?? new SuiGrpcClient({ baseUrl: config.rpcUrl, network: config.network });
    for (const input of payloads) {
      const id = digest(input.candidate);
      if (this.payloads.has(id) || input.transactionBytes.length > 1024 * 1024 || digest(Buffer.from(input.transactionBytes).toString('base64')) !== input.candidate.payloadDigest || !/^[a-f0-9]{64}$/.test(input.routeHash)) throw new Error('PAYLOAD_BINDING_MISMATCH');
      this.payloads.set(id, structuredClone(input));
    }
  }
  private payload(candidate: RouteCandidate) {
    const payload = this.payloads.get(digest(candidate));
    if (!payload || candidate.identity.chain !== 'sui' || candidate.identity.network !== this.config.network || candidate.profitAsset !== `sui:${this.config.network}:${SUI}` || digest(Buffer.from(payload.transactionBytes).toString('base64')) !== candidate.payloadDigest) throw new Error('PAYLOAD_BINDING_MISMATCH');
    const data = Transaction.from(payload.transactionBytes).getData();
    const address = normalizeSuiAddress(this.signer.toSuiAddress());
    if (data.sender !== address || data.gasData.owner !== address || !data.gasData.payment || data.gasData.payment.length !== 1 || !data.gasData.budget || uint(data.gasData.budget, 64) > uint(candidate.maxGasCost) || !data.gasData.price || !data.commands.length || data.commands.length > 100) throw new Error('INVALID_SUI_GAS_OR_SENDER');
    const gas = data.gasData.payment[0];
    if (!isSuiDigest(gas.digest)) throw new Error('INVALID_SUI_GAS_OR_SENDER');
    const allowed = new Set(this.config.allowedMoveCalls);
    const guard = `${normalizeSuiAddress(this.config.guardPackage)}::terminal_profit_guard::assert_min_profit_and_transfer_with_pause`;
    let guardCount = 0, borrowCount = 0, repayCount = 0, borrowIndex = -1;
    for (const command of data.commands) {
      // No imported wallet balance or direct transfer can bypass terminal custody.
      if (JSON.stringify(command).includes('"GasCoin"')) throw new Error('SUI_GAS_COIN_AS_TRADING_CAPITAL');
      if (command.$kind === 'MoveCall') {
        const call = command.MoveCall, target = `${call.package}::${call.module}::${call.function}`;
        if (!allowed.has(target) || !isSuiDigest(this.config.packageDigests[call.package])) throw new Error('UNADMITTED_MOVE_CALL');
        if (target === this.config.borrowTarget) {
          if (repayCount) throw new Error('INVALID_FLASH_RECEIPT_FLOW');
          borrowCount++;
          borrowIndex = data.commands.indexOf(command);
          const argument = call.arguments[this.config.borrowAmountArgument];
          const input = argument?.$kind === 'Input' ? data.inputs[argument.Input] : undefined;
          if (input?.$kind !== 'Pure' || BigInt(bcs.u64().parse(Buffer.from(input.Pure.bytes, 'base64'))) !== uint(candidate.borrowAmount, 64)) throw new Error('INVALID_FLASH_PRINCIPAL');
        }
        if (target === this.config.repayTarget) {
          if (borrowCount !== 1) throw new Error('INVALID_FLASH_RECEIPT_FLOW');
          const receipt = call.arguments[this.config.repayReceiptArgument];
          if (receipt?.$kind !== 'NestedResult' || receipt.NestedResult[0] !== borrowIndex || receipt.NestedResult[1] !== this.config.receiptReturnIndex) throw new Error('INVALID_FLASH_RECEIPT_FLOW');
          repayCount++;
        }
        if (target === guard) {
          guardCount++;
          if (command !== data.commands.at(-1) || call.typeArguments.length !== 1 || normalizeStructTag(call.typeArguments[0]) !== SUI || call.arguments.length !== 5) throw new Error('INVALID_TERMINAL_GUARD');
          const pure = (index: number) => {
            const argument = call.arguments[index];
            if (argument.$kind !== 'Input') throw new Error('INVALID_TERMINAL_GUARD');
            const input = data.inputs[argument.Input];
            if (input.$kind !== 'Pure') throw new Error('INVALID_TERMINAL_GUARD');
            return Buffer.from(input.Pure.bytes, 'base64');
          };
          if (BigInt(bcs.u64().parse(pure(3))) < uint(candidate.minProfit) + uint(candidate.maxGasCost) || Buffer.from(bcs.vector(bcs.u8()).parse(pure(4))).toString('hex') !== payload.routeHash) throw new Error('INVALID_TERMINAL_GUARD');
        }
      } else if (!['SplitCoins', 'MergeCoins'].includes(command.$kind)) throw new Error('UNADMITTED_SUI_COMMAND');
    }
    if (guardCount !== 1 || borrowCount !== 1 || repayCount !== 1) throw new Error('INVALID_FLASH_RECEIPT_FLOW');
    const required = new Set(this.config.requiredStateObjectIds.map(value => normalizeSuiAddress(value)));
    if (payload.stateRefs.length !== required.size || new Set(payload.stateRefs.map(ref => ref.objectId)).size !== required.size || payload.stateRefs.some(ref => !required.has(ref.objectId) || !isSuiDigest(ref.digest))) throw new Error('SUI_STATE_COVERAGE_INCOMPLETE');
    for (const input of data.inputs) {
      if (input.$kind === 'Pure') continue;
      if (input.$kind !== 'Object') throw new Error('UNRESOLVED_SUI_INPUT');
      const object = input.Object;
      if (object.$kind === 'SharedObject') {
        if (!required.has(object.SharedObject.objectId)) throw new Error('SUI_STATE_COVERAGE_INCOMPLETE');
      } else if (object.$kind === 'ImmOrOwnedObject') {
        if (!this.config.allowedOwnedInputIds.map(value => normalizeSuiAddress(value)).includes(object.ImmOrOwnedObject.objectId)) throw new Error('UNADMITTED_OWNED_INPUT');
      } else throw new Error('UNADMITTED_OWNED_INPUT');
    }
    return { payload, gas };
  }
  private async verify(candidate: RouteCandidate, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    if (candidate.adapterRevision !== this.admission.revision || candidate.expiresAtMs <= Date.now() || this.admission.expiresAtMs <= Date.now()) throw new Error('EXPIRED_EXECUTION_ADMISSION');
    const validated = this.payload(candidate);
    const info = await this.client.ledgerService.getServiceInfo({}, { timeout: 15000, abort: signal }).response;
    if (info.chainId !== this.config.chainIdentifier) throw new Error('SOURCE_CHAIN_MISMATCH');
    const identity = candidate.identity;
    if (identity.chain !== 'sui') throw new Error('SOURCE_CHAIN_MISMATCH');
    const checkpoint = await this.client.ledgerService.getCheckpoint({ checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: uint(identity.height, 64) }, readMask: { paths: ['digest'] } }, { timeout: 15000, abort: signal }).response;
    if (checkpoint.checkpoint?.digest !== identity.checkpointDigest) throw new Error('STATE_CHANGED');
    for (const ref of [...validated.payload.stateRefs, validated.gas]) {
      const result = await this.client.ledgerService.getObject({ objectId: ref.objectId, readMask: { paths: ['object_id', 'version', 'digest'] } }, { timeout: 15000, abort: signal }).response;
      if (result.object?.version?.toString() !== ref.version || result.object?.digest !== ref.digest) throw new Error('STATE_CHANGED');
    }
    for (const [objectId, pin] of Object.entries(this.config.packageDigests)) {
      if (!isSuiDigest(pin)) throw new Error('MISSING_EXECUTION_CODE_PIN');
      const result = await this.client.ledgerService.getObject({ objectId, readMask: { paths: ['digest'] } }, { timeout: 15000, abort: signal }).response;
      if (result.object?.digest !== pin) throw new Error('EXECUTION_REVISION_CHANGED');
    }
    return validated;
  }
  private proof(candidate: RouteCandidate, transaction: { effects?: { gasUsed: { computationCost: string; storageCost: string; storageRebate: string }; status: { success: boolean }; transactionDigest: string }; events?: Array<{ eventType: string; bcs: Uint8Array }> }) {
    const effects = transaction.effects;
    if (!effects || !effects.status.success) throw new Error('SUI_EXECUTION_FAILED');
    // Upgraded callable packages do not change a Move event's publishing type origin.
    const eventType = this.config.guardEventType;
    const events = transaction.events?.filter(event => normalizeStructTag(event.eventType) === normalizeStructTag(eventType)) ?? [];
    if (events.length !== 1) throw new Error('PNL_UNKNOWN');
    const event = ProfitSwept.parse(events[0].bcs), { payload } = this.payload(candidate);
    if (normalizeSuiAddress(event.operator) !== normalizeSuiAddress(this.signer.toSuiAddress()) || normalizeSuiAddress(event.treasury) !== normalizeSuiAddress(this.config.treasury) || Buffer.from(event.route_hash).toString('hex') !== payload.routeHash) throw new Error('PNL_UNKNOWN');
    const gross = uint(effects.gasUsed.computationCost) + uint(effects.gasUsed.storageCost), rebate = uint(effects.gasUsed.storageRebate);
    return { profit: uint(event.amount, 64), gas: gross > rebate ? gross - rebate : 0n };
  }
  async simulate(candidate: RouteCandidate, signal?: AbortSignal): Promise<SimulationProof> {
    const { payload } = await this.verify(candidate, signal);
    const result = await this.client.simulateTransaction({ transaction: payload.transactionBytes, checksEnabled: true, include: { effects: true, events: true }, signal });
    if (result.$kind !== 'Transaction' || result.gasPaymentMocked !== false || result.Transaction.digest !== TransactionDataBuilder.getDigestFromBytes(payload.transactionBytes) || result.Transaction.effects?.transactionDigest !== result.Transaction.digest) throw new Error('SUI_EXECUTION_FAILED');
    // Shared-object PTB inputs carry their initial sharing version, not a
    // current-state version lock. Bracket simulation with exact state checks.
    await this.verify(candidate, signal);
    const proof = this.proof(candidate, result.Transaction);
    return { candidateDigest: digest(candidate), payloadDigest: candidate.payloadDigest, stateDigest: candidate.stateDigest, success: true, profitAfterDebt: proof.profit.toString(), conservativeGasCostInProfitAsset: proof.gas.toString() };
  }
  preflight(candidate: RouteCandidate, signal?: AbortSignal) { return this.simulate(candidate, signal); }
  async resource(candidate: RouteCandidate, signal?: AbortSignal) {
    const { gas } = await this.verify(candidate, signal);
    return `sui:${gas.objectId}:${gas.version}:${gas.digest}`;
  }
  async sign(candidate: RouteCandidate, resource: string, signal?: AbortSignal) {
    const { payload, gas } = await this.verify(candidate, signal);
    if (resource !== `sui:${gas.objectId}:${gas.version}:${gas.digest}`) throw new Error('SIGNING_RESOURCE_CHANGED');
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    const signed = await this.signer.signTransaction(payload.transactionBytes);
    const bytes = Buffer.from(signed.bytes, 'base64');
    if (!bytes.equals(Buffer.from(payload.transactionBytes))) throw new Error('SIGNED_PAYLOAD_MISMATCH');
    await verifyTransactionSignature(bytes, signed.signature, { address: this.signer.toSuiAddress() });
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    const transactionId = TransactionDataBuilder.getDigestFromBytes(bytes);
    this.signed.set(transactionId, payload);
    return { transactionId, signedBytes: Buffer.from(JSON.stringify({ bytes: signed.bytes, signature: signed.signature })), resource, payloadDigest: candidate.payloadDigest };
  }
  async submit(envelope: Uint8Array, signal?: AbortSignal) {
    if (envelope.length > 2 * 1024 * 1024) throw new Error('INVALID_SIGNED_TRANSACTION');
    const signed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(envelope));
    if (!signed || Object.keys(signed).sort().join(',') !== 'bytes,signature' || typeof signed.bytes !== 'string' || typeof signed.signature !== 'string') throw new Error('INVALID_SIGNED_TRANSACTION');
    const bytes = Buffer.from(signed.bytes, 'base64'), transactionId = TransactionDataBuilder.getDigestFromBytes(bytes), payload = this.signed.get(transactionId);
    if (!payload || !bytes.equals(Buffer.from(payload.transactionBytes))) throw new Error('UNRECOGNIZED_SIGNED_TRANSACTION');
    await verifyTransactionSignature(bytes, signed.signature, { address: this.signer.toSuiAddress() });
    await this.verify(payload.candidate, signal);
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    const result = await this.client.executeTransaction({ transaction: bytes, signatures: [signed.signature], include: { effects: true }, signal });
    return result.$kind === 'Transaction' ? result.Transaction.digest : result.FailedTransaction.digest;
  }
  async receipt(transactionId: string, signal?: AbortSignal) {
    const payload = this.signed.get(transactionId) ?? [...this.payloads.values()].find(input => TransactionDataBuilder.getDigestFromBytes(input.transactionBytes) === transactionId);
    if (!payload) return null;
    const result = await this.client.waitForTransaction({ digest: transactionId, include: { effects: true, events: true }, timeout: 14000, signal });
    const transaction = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
    if (transaction.digest !== transactionId || !transaction.effects || transaction.effects.transactionDigest !== transactionId || transaction.checkpoint === null) return null;
    const success = transaction.status.success;
    const proof = success ? this.proof(payload.candidate, transaction) : { profit: 0n, gas: uint(transaction.effects.gasUsed.computationCost) + uint(transaction.effects.gasUsed.storageCost) - uint(transaction.effects.gasUsed.storageRebate) };
    return { transactionId, source: `sui:${this.config.network}:${transaction.checkpoint}`, executionStatus: success ? 'success' as const : 'revert' as const, repaymentProven: success, profitTransferProven: success, gasCostInProfitAsset: (proof.gas > 0n ? proof.gas : 0n).toString(), profitAfterDebt: proof.profit.toString() };
  }
}
