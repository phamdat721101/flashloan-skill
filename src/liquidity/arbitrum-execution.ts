import { createPublicClient, decodeEventLog, decodeFunctionData, encodeAbiParameters, hexToBytes, http, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, toHex, type Abi, type Address, type Hex, type LocalAccount } from 'viem';
import { evmProfile, PROFIT_ASSETS } from '../evm-chains.js';
import { estimateEvmFees, nativeCostInAsset, receiptNativeCost, type GasValuation } from '../evm-fees.js';
import { DYNAMIC_V4_EXECUTOR_DEPLOYMENT, MULTI_VENUE_EXECUTOR_DEPLOYMENT } from '../contracts/flash-executor.js';
import { MULTI_LENDER_ROUTE_ABI } from './arbitrum.js';
import { digest, uint } from './state.js';
import { buildLedger, reconcileReceipt, type ExecutionEvidence } from '../evidence/economics.js';
import type { Admission, LiquidityExecutionAdapter, RouteCandidate, SimulationProof } from './runtime.js';

const executorAbi = parseAbi([
  'function owner() view returns(address)',
  'event MultiVenueArbitrageExecuted(bytes32 indexed routeHash,address indexed asset,uint256 flashAmount,uint256 netProfit,uint256 legs)'
]);
export interface ArbitrumExecutionConfig {
  rpcUrl: string; submissionUrl: string; executor: Address; executorCodeHash: Hex;
  codePins: Record<string, Hex>; admission: Admission; confirmations: number; valuation?: GasValuation;
  /** Executor calldata/event codec; omitted means the multi-venue executor (unchanged behavior). */
  codec?: RouteCodec; priorityFeePerGas?: bigint;
  /** v6 all-asset receipt reconciliation over sender + executor (+ extra operator accounts). Omitted: unchanged behavior. */
  reconcileAccounts?: { extraAccounts?: Address[]; minFinality?: 'latest' | 'safe' | 'finalized' };
}
/** The executor-independent view of a flash route that the adapter's guards need. */
export interface ExecutionRoute {
  kind: number; supportedKind: boolean; unsupportedLeg: boolean; lender: Address; flashAsset: Address;
  flashAmount: bigint; minProfit: bigint; deadline: bigint; pinned: Address[]; size: number;
}
export interface RouteCodec {
  decode(calldata: Hex): ExecutionRoute;
  /** Decodes executor logs and proves repayment plus profit for exactly this calldata. */
  prove(logs: ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>, executor: Address, calldata: Hex, route: ExecutionRoute): { proven: boolean; profit: bigint };
  /** Blocks a canonical snapshot may trail the head; 0 requires the exact head. */
  maxBlockLag?: number;
}
const zero = '0x0000000000000000000000000000000000000000';
export const MULTI_VENUE_ROUTE_CODEC: RouteCodec = {
  decode(calldata) {
    const route = decodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI, data: calldata }).args[0];
    return { kind: route.kind, supportedKind: [1, 2].includes(route.kind) && route.legs.length > 0, unsupportedLeg: route.legs.some(leg => ![2, 3, 4, 5].includes(leg.venueVersion) || leg.hooks !== zero || leg.hookData !== '0x'),
      lender: route.lender, flashAsset: route.flashAsset, flashAmount: route.flashAmount, minProfit: route.minProfit, deadline: route.deadline,
      pinned: [route.lender, ...route.legs.flatMap(leg => [leg.root, ...(leg.venueVersion === 4 ? [] : [leg.pool])])], size: route.legs.length };
  },
  prove(logs, executor, calldata, view) {
    const route = decodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI, data: calldata }).args[0];
    const routeHash = keccak256(encodeAbiParameters(MULTI_LENDER_ROUTE_ABI[0].inputs, [route]));
    const events = decodeExecutorEvents(logs, executor, executorAbi, 'MultiVenueArbitrageExecuted');
    if (events.length !== 1) return { proven: false, profit: 0n };
    const event = events[0] as { routeHash: Hex; asset: Address; flashAmount: bigint; netProfit: bigint; legs: bigint };
    return { proven: event.routeHash === routeHash && event.asset.toLowerCase() === view.flashAsset.toLowerCase() && event.flashAmount === view.flashAmount && event.legs === BigInt(view.size) && event.netProfit >= view.minProfit, profit: event.netProfit };
  }
};
export function decodeExecutorEvents(logs: ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>, executor: Address, abi: Abi, name: string): Record<string, unknown>[] {
  return logs.filter(log => log.address.toLowerCase() === executor.toLowerCase()).flatMap(log => {
    try { return [decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true })]; } catch { return []; }
  }).filter(event => event.eventName === name).map(event => event.args as unknown as Record<string, unknown>);
}
export interface ExactArbitrumPayload { candidate: RouteCandidate; calldata: Hex }
function endpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('INSECURE_EXECUTION_ENDPOINT');
  if (url.username || url.password) throw new Error('EXECUTION_ENDPOINT_CREDENTIALS');
  return value;
}

/** Real local signing + raw submission for a newly admitted multi-lender deployment.
 * Native gas is accounted exactly in WETH wei; other profit assets need an oracle
 * adapter and are deliberately unsupported. Constructing this class never sends.
 */
export class EvmLiquidityExecutionAdapter implements LiquidityExecutionAdapter {
  readonly admission: Admission;
  beforeBroadcast?: (hash: Hex) => Promise<void>;
  submissionNotAttempted?: (hash: Hex) => Promise<void>;
  private readonly profile;
  private readonly chainId: number;
  private readonly client;
  private readonly relay;
  private readonly config: ArbitrumExecutionConfig;
  private readonly codec: RouteCodec;
  private readonly payloads = new Map<string, Hex>();
  private readonly candidates = new Map<string, RouteCandidate>();
  private readonly signed = new Map<string, { candidate: RouteCandidate; calldata: Hex }>();
  constructor(config: ArbitrumExecutionConfig, private readonly account: LocalAccount, payloads: readonly ExactArbitrumPayload[]) {
    this.chainId = Number(config.admission.network); this.profile = evmProfile(this.chainId);
    if (config.admission.chain !== this.profile.key || !/^0x[0-9a-fA-F]{40}$/.test(config.executor) || !/^0x[0-9a-f]{64}$/.test(config.executorCodeHash) || !Number.isInteger(config.confirmations) || config.confirmations < 1 || config.confirmations > 100 || !account.signTransaction || payloads.length > 1000) throw new Error('INVALID_EXECUTION_CONFIG');
    if (this.chainId === 42161 && [DYNAMIC_V4_EXECUTOR_DEPLOYMENT.address, MULTI_VENUE_EXECUTOR_DEPLOYMENT.address].some(address => address.toLowerCase() === config.executor.toLowerCase())) throw new Error('CORRECTED_EXECUTOR_REQUIRED');
    const lag = config.codec?.maxBlockLag ?? 0;
    if (!Number.isInteger(lag) || lag < 0 || lag > 5) throw new Error('INVALID_EXECUTION_CONFIG');
    this.codec = config.codec ?? MULTI_VENUE_ROUTE_CODEC;
    this.config = { ...structuredClone({ ...config, codec: undefined }), codec: this.codec }; this.admission = Object.freeze(structuredClone(config.admission));
    this.client = createPublicClient({ transport: http(endpoint(config.rpcUrl), { timeout: 15000, retryCount: 0 }) });
    this.relay = createPublicClient({ transport: http(endpoint(config.submissionUrl), { timeout: 15000, retryCount: 0 }) });
    for (const input of payloads) {
      if (digest(input.calldata) !== input.candidate.payloadDigest || this.payloads.has(digest(input.candidate))) throw new Error('PAYLOAD_BINDING_MISMATCH');
      this.payloads.set(digest(input.candidate), input.calldata);
      this.candidates.set(digest(input.candidate), structuredClone(input.candidate));
    }
  }
  private route(candidate: RouteCandidate) {
    const calldata = this.payloads.get(digest(candidate));
    if (!calldata || digest(calldata) !== candidate.payloadDigest || candidate.identity.chain !== this.profile.key || candidate.identity.network !== String(this.chainId) || !PROFIT_ASSETS[this.chainId]?.some(asset => candidate.profitAsset.toLowerCase() === `${this.profile.key}:${this.chainId}:${asset}`)) throw new Error('PAYLOAD_BINDING_MISMATCH');
    const route = this.codec.decode(calldata);
    if (!route.supportedKind || candidate.profitAsset.toLowerCase() !== `${this.profile.key}:${this.chainId}:${route.flashAsset.toLowerCase()}` || route.flashAmount !== uint(candidate.borrowAmount) || route.minProfit < uint(candidate.minProfit) + uint(candidate.maxGasCost) || route.deadline * 1000n > BigInt(candidate.expiresAtMs)) throw new Error('EXECUTOR_PROFIT_GUARD_MISMATCH');
    if (route.unsupportedLeg) throw new Error('UNSUPPORTED_EXECUTION_HOOK');
    return { calldata, route };
  }
  private async verify(candidate: RouteCandidate, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    if (candidate.adapterRevision !== this.admission.revision || candidate.expiresAtMs <= Date.now() || this.admission.expiresAtMs <= Date.now()) throw new Error('EXPIRED_EXECUTION_ADMISSION');
    const { calldata, route } = this.route(candidate);
    if (await this.client.getChainId() !== this.chainId) throw new Error('SOURCE_CHAIN_MISMATCH');
    const block = await this.client.getBlock({ blockTag: 'latest' });
    if (candidate.identity.chain !== this.profile.key) throw new Error('STATE_CHANGED');
    await this.fresh(candidate, block);
    const pins = new Map<string, Hex>([[this.config.executor.toLowerCase(), this.config.executorCodeHash]]);
    for (const address of route.pinned) {
      const pin = this.config.codePins[address.toLowerCase()];
      if (!pin || !/^0x[0-9a-f]{64}$/.test(pin)) throw new Error('MISSING_EXECUTION_CODE_PIN');
      pins.set(address.toLowerCase(), pin);
    }
    for (const [address, pin] of pins) {
      const code = await this.client.getCode({ address: address as Address, blockNumber: block.number });
      if (!code || code === '0x' || keccak256(code) !== pin) throw new Error('EXECUTION_REVISION_CHANGED');
    }
    const owner = await this.client.readContract({ address: this.config.executor, abi: executorAbi, functionName: 'owner', blockNumber: block.number });
    if (owner.toLowerCase() !== this.account.address.toLowerCase()) throw new Error('EXECUTOR_OWNER_MISMATCH');
    if (route.deadline <= block.timestamp) throw new Error('EXPIRED_EXECUTOR_ROUTE');
    await this.client.call({ account: this.account.address, to: this.config.executor, data: calldata, blockNumber: block.number });
    if ((await this.client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('BLOCK_REORG');
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    await this.latest(candidate);
    return { calldata, route };
  }
  private async latest(candidate: RouteCandidate) {
    const head = await this.client.getBlock({ blockTag: 'latest' });
    if (candidate.identity.chain === 'sui') throw new Error('STATE_CHANGED');
    await this.fresh(candidate, head);
  }
  /** Exact head when maxBlockLag is 0; otherwise a canonical snapshot at most maxBlockLag behind. */
  private async fresh(candidate: RouteCandidate, head: { number: bigint | null; hash: Hex | null }) {
    if (candidate.identity.chain === 'sui') throw new Error('STATE_CHANGED');
    const lag = BigInt(this.codec.maxBlockLag ?? 0);
    if (lag === 0n) { if (head.number?.toString() !== candidate.identity.height || head.hash !== candidate.identity.blockHash) throw new Error('STATE_CHANGED'); return; }
    const height = BigInt(candidate.identity.height);
    if (head.number === null || head.number < height || head.number - height > lag) throw new Error('STATE_CHANGED');
    if ((await this.client.getBlock({ blockNumber: height })).hash !== candidate.identity.blockHash) throw new Error('STATE_CHANGED');
  }
  private async assetCost(native: bigint, block: bigint, asset: Address): Promise<bigint> {
    if (asset.toLowerCase() === this.profile.wrappedNative) return native;
    const valuation = this.config.valuation;
    if (!valuation || valuation.asset.toLowerCase() !== asset.toLowerCase()) throw new Error('MISSING_GAS_VALUATION');
    const decimals = await this.client.readContract({ address: asset, abi: parseAbi(['function decimals() view returns(uint8)']), functionName: 'decimals', blockNumber: block });
    if (decimals !== valuation.decimals) throw new Error('ASSET_DECIMALS_CHANGED');
    for (const feed of [valuation.nativeUsdFeed, valuation.assetUsdFeed]) {
      const code = await this.client.getCode({ address: feed, blockNumber: block });
      if (!code || keccak256(code) !== this.config.codePins[feed.toLowerCase()]) throw new Error('UNPINNED_PRICE_FEED');
    }
    return nativeCostInAsset(this.client, native, block, valuation);
  }
  private async estimate(candidate: RouteCandidate, signal?: AbortSignal) {
    const verified = await this.verify(candidate, signal);
    const { gas, fees, nativeCost } = await estimateEvmFees(this.client, this.chainId, this.account.address, this.config.executor, verified.calldata, this.config.priorityFeePerGas);
    const cost = await this.assetCost(nativeCost, BigInt(candidate.identity.height), verified.route.flashAsset);
    if (cost > uint(candidate.maxGasCost)) throw new Error('GAS_BUDGET_EXCEEDED');
    return { ...verified, gas, fees, cost };
  }
  async simulate(candidate: RouteCandidate, signal?: AbortSignal): Promise<SimulationProof> {
    const estimate = await this.estimate(candidate, signal);
    // Successful exact calldata enforces this lower bound in the pinned contract.
    return { candidateDigest: digest(candidate), payloadDigest: candidate.payloadDigest, stateDigest: candidate.stateDigest, success: true, profitAfterDebt: estimate.route.minProfit.toString(), conservativeGasCostInProfitAsset: estimate.cost.toString() };
  }
  preflight(candidate: RouteCandidate, signal?: AbortSignal) { return this.simulate(candidate, signal); }
  async resource(candidate: RouteCandidate, signal?: AbortSignal): Promise<string> {
    await this.verify(candidate, signal);
    const nonce = await this.client.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
    return `${this.chainId}:${this.account.address.toLowerCase()}:${nonce}`;
  }
  async sign(candidate: RouteCandidate, resource: string, signal?: AbortSignal) {
    const estimate = await this.estimate(candidate, signal);
    const nonce = await this.client.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
    if (resource !== `${this.chainId}:${this.account.address.toLowerCase()}:${nonce}`) throw new Error('NONCE_CHANGED');
    await this.latest(candidate);
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    const bytes = await this.account.signTransaction!({ chainId: this.chainId, type: 'eip1559', to: this.config.executor, data: estimate.calldata, value: 0n, nonce, gas: estimate.gas, maxFeePerGas: estimate.fees.maxFeePerGas, maxPriorityFeePerGas: estimate.fees.maxPriorityFeePerGas });
    if (!bytes.startsWith('0x02')) throw new Error('SIGNED_PAYLOAD_MISMATCH');
    const parsed = parseTransaction(bytes);
    const signer = await recoverTransactionAddress({ serializedTransaction: bytes as `0x02${string}` });
    if (parsed.type !== 'eip1559' || parsed.chainId !== this.chainId || parsed.nonce !== nonce || parsed.to?.toLowerCase() !== this.config.executor.toLowerCase() || parsed.data !== estimate.calldata || (parsed.value ?? 0n) !== 0n || parsed.gas !== estimate.gas || parsed.maxFeePerGas !== estimate.fees.maxFeePerGas || parsed.maxPriorityFeePerGas !== estimate.fees.maxPriorityFeePerGas || signer.toLowerCase() !== this.account.address.toLowerCase()) throw new Error('SIGNED_PAYLOAD_MISMATCH');
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    const transactionId = keccak256(bytes);
    this.signed.set(transactionId, { candidate: structuredClone(candidate), calldata: estimate.calldata });
    return { transactionId, signedBytes: hexToBytes(bytes), resource, payloadDigest: candidate.payloadDigest };
  }
  async submit(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const transactionId = keccak256(bytes), signed = this.signed.get(transactionId);
    if (!signed) throw new Error('UNRECOGNIZED_SIGNED_TRANSACTION');
    try {
      await this.verify(signed.candidate, signal);
      if (await this.relay.getChainId() !== this.chainId) throw new Error('SUBMISSION_CHAIN_MISMATCH');
      await this.latest(signed.candidate);
      if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
      if (this.beforeBroadcast) await this.beforeBroadcast(transactionId);
      await this.latest(signed.candidate);
      if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    } catch (error) {
      if (this.submissionNotAttempted) await this.submissionNotAttempted(transactionId);
      throw error;
    }
    return this.relay.sendRawTransaction({ serializedTransaction: toHex(bytes) });
  }
  async receipt(transactionId: string, signal?: AbortSignal) {
    let signed = this.signed.get(transactionId);
    // Recovery does not sign or resend. Rebind the mined transaction to a
    // registered exact payload, even after expiry or a process restart.
    if (!signed && /^0x[0-9a-f]{64}$/.test(transactionId)) {
      const transaction = await this.client.getTransaction({ hash: transactionId as Hex });
      if (transaction.type !== 'eip1559' || transaction.from.toLowerCase() !== this.account.address.toLowerCase() || transaction.to?.toLowerCase() !== this.config.executor.toLowerCase() || transaction.value !== 0n || transaction.chainId !== this.chainId) throw new Error('RECOVERY_TRANSACTION_MISMATCH');
      const entry = [...this.payloads.entries()].find(([, calldata]) => calldata === transaction.input);
      if (entry) {
        const candidate = this.candidates.get(entry[0]);
        if (candidate) signed = { candidate, calldata: entry[1] };
      }
    }
    if (!signed || signal?.aborted) return null;
    const receipt = await this.client.waitForTransactionReceipt({ hash: transactionId as Hex, confirmations: this.config.confirmations, timeout: 14000 });
    if ((await this.client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('RECEIPT_REORG');
    const raw = await this.client.request({ method: 'eth_getTransactionReceipt', params: [transactionId as Hex] });
    const nativeCost = receiptNativeCost(this.chainId, receipt, raw);
    const { route: receiptRoute } = this.route(signed.candidate);
    const gas = await this.assetCost(nativeCost, receipt.blockNumber, receiptRoute.flashAsset);
    let profit = 0n, proven = receipt.status === 'reverted';
    if (receipt.status === 'success') {
      const { calldata, route } = this.route(signed.candidate);
      ({ proven, profit } = this.codec.prove(receipt.logs, this.config.executor, calldata, route));
    }
    const executionEvidence = this.config.reconcileAccounts ? await this.reconcile(signed, receipt, nativeCost, proven, profit, receiptRoute.flashAsset, receiptRoute.flashAmount) : undefined;
    return { transactionId, source: `${this.profile.key}:${this.chainId}:${receipt.blockHash}`, executionStatus: receipt.status === 'success' ? 'success' as const : 'revert' as const, repaymentProven: proven, profitTransferProven: false, profitCustodyProven: proven, gasCostInProfitAsset: gas.toString(), profitAfterDebt: profit.toString(), ...(executionEvidence ? { executionEvidence } : {}) };
  }
  /** Reads every controlled account's native and flash-asset balance at the parent and receipt blocks, then reconciles. */
  private async reconcile(signed: { candidate: RouteCandidate; calldata: Hex }, receipt: { transactionHash: Hex; blockHash: Hex; blockNumber: bigint; status: string; gasUsed: bigint; effectiveGasPrice: bigint }, nativeCost: bigint, proven: boolean, profit: bigint, flashAsset: Address, principal: bigint): Promise<ExecutionEvidence> {
    const options = this.config.reconcileAccounts!, chain = `eip155:${this.chainId}`, asset = flashAsset.toLowerCase(), assetKey = `${chain}/erc20:${asset}`;
    const accounts = [{ role: 'sender' as const, address: this.account.address.toLowerCase() }, { role: 'executor' as const, address: this.config.executor.toLowerCase() }, ...(options.extraAccounts ?? []).map(a => ({ role: 'operator' as const, address: a.toLowerCase() }))];
    const erc20 = parseAbi(['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)']);
    const read = async (blockNumber: bigint) => Object.fromEntries(await Promise.all(accounts.map(async a => [a.address, {
      native: (await this.client.getBalance({ address: a.address as Address, blockNumber })).toString(),
      [assetKey]: (await this.client.readContract({ address: flashAsset, abi: erc20, functionName: 'balanceOf', args: [a.address as Address], blockNumber })).toString() }])));
    const [opening, closing, transaction, decimals, unitPrice] = await Promise.all([read(receipt.blockNumber - 1n), read(receipt.blockNumber), this.client.getTransaction({ hash: receipt.transactionHash }),
      this.client.readContract({ address: flashAsset, abi: erc20, functionName: 'decimals', blockNumber: receipt.blockNumber }), this.assetCost(10n ** 18n, receipt.blockNumber, flashAsset)]);
    const execution = receipt.gasUsed * receipt.effectiveGasPrice, l1 = nativeCost > execution ? nativeCost - execution : 0n, c = signed.candidate;
    const ledgerAsset = { namespace: 'eip155' as const, networkId: String(this.chainId), assetId: asset, decimals: Number(decimals) };
    // Pre-send expectation: the executor's enforced minimum profit and the approved gas budget (both conservative).
    const simulated = buildLedger({ runId: `attempt-${digest(c).slice(0, 16)}`, schemaVersion: '5.2', asset: ledgerAsset, principalRaw: principal.toString(), deployedRaw: principal.toString(), unusedPrincipalRaw: '0', swapProceedsRaw: (principal + uint(c.minProfit)).toString(), flashFeeRaw: '0', networkCostRaw: c.maxGasCost, otherExternalCostsRaw: '0', operatorPrefundRaw: '0', executorOpeningBalanceRaw: '0', evidence: [] });
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ref = { kind: 'gas-valuation', content_hash: `sha256:${digest({ unitPrice: unitPrice.toString(), block: receipt.blockNumber.toString() })}`, captured_at: now, trace_id: receipt.transactionHash };
    return reconcileReceipt({
      header: { chain_id: chain, round_id: simulated.runId, candidate_hash: `sha256:${digest(c)}`, policy_hash: `sha256:${digest({ minProfit: c.minProfit, maxGasCost: c.maxGasCost })}`, block_hash: receipt.blockHash.toLowerCase(),
        executor: { address: this.config.executor.toLowerCase(), runtime_hash: this.config.executorCodeHash.toLowerCase(), abi_hash: `sha256:${digest(signed.calldata.slice(0, 10))}` }, accounts,
        transaction: { sender: this.account.address.toLowerCase(), calldata_hash: keccak256(signed.calldata), nonce: String(transaction.nonce), tx_hash: receipt.transactionHash.toLowerCase() },
        receipt: { tx_hash: receipt.transactionHash.toLowerCase(), block_hash: receipt.blockHash.toLowerCase(), status: receipt.status === 'success' ? 'success' : 'revert', finality: this.config.confirmations >= 2 ? 'safe' : 'latest', gas_used: receipt.gasUsed.toString(), effective_gas_price: receipt.effectiveGasPrice.toString(), l1_fee_raw: l1 ? l1.toString() : null },
        native_result_ref: null },
      fixture: false, borrowAssetKey: assetKey, simulated, actualSwapProceedsRaw: receipt.status === 'success' ? (principal + profit).toString() : null, repaymentProven: proven,
      opening, closing, prefundByAsset: {}, valuations: { native: { price: { numerator: unitPrice.toString(), denominator: (10n ** 18n).toString() }, ref } }, minFinality: options.minFinality ?? 'latest' });
  }
}

/** Compatibility name; the same implementation now validates its explicit EVM profile. */
export { EvmLiquidityExecutionAdapter as ArbitrumLiquidityExecutionAdapter };
