import { createPublicClient, decodeEventLog, decodeFunctionData, encodeAbiParameters, hexToBytes, http, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, toHex, type Address, type Hex, type LocalAccount } from 'viem';
import { arbitrum } from 'viem/chains';
import { DYNAMIC_V4_EXECUTOR_DEPLOYMENT, MULTI_VENUE_EXECUTOR_DEPLOYMENT } from '../contracts/flash-executor.js';
import { MULTI_LENDER_ROUTE_ABI } from './arbitrum.js';
import { digest, uint } from './state.js';
import type { Admission, LiquidityExecutionAdapter, RouteCandidate, SimulationProof } from './runtime.js';

const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const executorAbi = parseAbi([
  'function owner() view returns(address)',
  'event MultiVenueArbitrageExecuted(bytes32 indexed routeHash,address indexed asset,uint256 flashAmount,uint256 netProfit,uint256 legs)'
]);
export interface ArbitrumExecutionConfig {
  rpcUrl: string; submissionUrl: string; executor: Address; executorCodeHash: Hex;
  codePins: Record<string, Hex>; admission: Admission; confirmations: number;
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
export class ArbitrumLiquidityExecutionAdapter implements LiquidityExecutionAdapter {
  readonly admission: Admission;
  private readonly client;
  private readonly relay;
  private readonly config: ArbitrumExecutionConfig;
  private readonly payloads = new Map<string, Hex>();
  private readonly candidates = new Map<string, RouteCandidate>();
  private readonly signed = new Map<string, { candidate: RouteCandidate; calldata: Hex }>();
  constructor(config: ArbitrumExecutionConfig, private readonly account: LocalAccount, payloads: readonly ExactArbitrumPayload[]) {
    if (config.admission.chain !== 'arbitrum' || config.admission.network !== '42161' || !/^0x[0-9a-fA-F]{40}$/.test(config.executor) || !/^0x[0-9a-f]{64}$/.test(config.executorCodeHash) || !Number.isInteger(config.confirmations) || config.confirmations < 1 || config.confirmations > 100 || !account.signTransaction || payloads.length > 1000) throw new Error('INVALID_EXECUTION_CONFIG');
    if ([DYNAMIC_V4_EXECUTOR_DEPLOYMENT.address, MULTI_VENUE_EXECUTOR_DEPLOYMENT.address].some(address => address.toLowerCase() === config.executor.toLowerCase())) throw new Error('CORRECTED_EXECUTOR_REQUIRED');
    this.config = structuredClone(config); this.admission = Object.freeze(structuredClone(config.admission));
    this.client = createPublicClient({ chain: arbitrum, transport: http(endpoint(config.rpcUrl), { timeout: 15000, retryCount: 0 }) });
    this.relay = createPublicClient({ chain: arbitrum, transport: http(endpoint(config.submissionUrl), { timeout: 15000, retryCount: 0 }) });
    for (const input of payloads) {
      if (digest(input.calldata) !== input.candidate.payloadDigest || this.payloads.has(digest(input.candidate))) throw new Error('PAYLOAD_BINDING_MISMATCH');
      this.payloads.set(digest(input.candidate), input.calldata);
      this.candidates.set(digest(input.candidate), structuredClone(input.candidate));
    }
  }
  private route(candidate: RouteCandidate) {
    const calldata = this.payloads.get(digest(candidate));
    if (!calldata || digest(calldata) !== candidate.payloadDigest || candidate.identity.chain !== 'arbitrum' || candidate.identity.network !== '42161' || candidate.profitAsset.toLowerCase() !== `arbitrum:42161:${WETH}`) throw new Error('PAYLOAD_BINDING_MISMATCH');
    const route = decodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI, data: calldata }).args[0];
    if (![1, 2].includes(route.kind) || route.flashAsset.toLowerCase() !== WETH || route.flashAmount !== uint(candidate.borrowAmount) || route.minProfit < uint(candidate.minProfit) + uint(candidate.maxGasCost) || route.deadline * 1000n > BigInt(candidate.expiresAtMs) || !route.legs.length) throw new Error('EXECUTOR_PROFIT_GUARD_MISMATCH');
    if (route.legs.some(leg => ![2, 3, 4, 5].includes(leg.venueVersion) || leg.hooks !== '0x0000000000000000000000000000000000000000' || leg.hookData !== '0x')) throw new Error('UNSUPPORTED_EXECUTION_HOOK');
    return { calldata, route };
  }
  private async verify(candidate: RouteCandidate, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    if (candidate.adapterRevision !== this.admission.revision || candidate.expiresAtMs <= Date.now() || this.admission.expiresAtMs <= Date.now()) throw new Error('EXPIRED_EXECUTION_ADMISSION');
    const { calldata, route } = this.route(candidate);
    if (await this.client.getChainId() !== 42161) throw new Error('SOURCE_CHAIN_MISMATCH');
    const block = await this.client.getBlock({ blockTag: 'latest' });
    if (candidate.identity.chain !== 'arbitrum' || block.number?.toString() !== candidate.identity.height || block.hash !== candidate.identity.blockHash) throw new Error('STATE_CHANGED');
    const pins = new Map<string, Hex>([[this.config.executor.toLowerCase(), this.config.executorCodeHash]]);
    for (const address of [route.lender, ...route.legs.flatMap(leg => [leg.root, ...(leg.venueVersion === 4 ? [] : [leg.pool])])]) {
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
    return { calldata, route };
  }
  private async estimate(candidate: RouteCandidate, signal?: AbortSignal) {
    const verified = await this.verify(candidate, signal);
    const gas = await this.client.estimateGas({ account: this.account.address, to: this.config.executor, data: verified.calldata });
    const fees = await this.client.estimateFeesPerGas();
    const cost = gas * fees.maxFeePerGas;
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
    return `42161:${this.account.address.toLowerCase()}:${nonce}`;
  }
  async sign(candidate: RouteCandidate, resource: string, signal?: AbortSignal) {
    const estimate = await this.estimate(candidate, signal);
    const nonce = await this.client.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
    if (resource !== `42161:${this.account.address.toLowerCase()}:${nonce}`) throw new Error('NONCE_CHANGED');
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    const bytes = await this.account.signTransaction!({ chainId: 42161, type: 'eip1559', to: this.config.executor, data: estimate.calldata, value: 0n, nonce, gas: estimate.gas, maxFeePerGas: estimate.fees.maxFeePerGas, maxPriorityFeePerGas: estimate.fees.maxPriorityFeePerGas });
    if (!bytes.startsWith('0x02')) throw new Error('SIGNED_PAYLOAD_MISMATCH');
    const parsed = parseTransaction(bytes);
    const signer = await recoverTransactionAddress({ serializedTransaction: bytes as `0x02${string}` });
    if (parsed.type !== 'eip1559' || parsed.chainId !== 42161 || parsed.nonce !== nonce || parsed.to?.toLowerCase() !== this.config.executor.toLowerCase() || parsed.data !== estimate.calldata || (parsed.value ?? 0n) !== 0n || parsed.gas !== estimate.gas || parsed.maxFeePerGas !== estimate.fees.maxFeePerGas || parsed.maxPriorityFeePerGas !== estimate.fees.maxPriorityFeePerGas || signer.toLowerCase() !== this.account.address.toLowerCase()) throw new Error('SIGNED_PAYLOAD_MISMATCH');
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    const transactionId = keccak256(bytes);
    this.signed.set(transactionId, { candidate: structuredClone(candidate), calldata: estimate.calldata });
    return { transactionId, signedBytes: hexToBytes(bytes), resource, payloadDigest: candidate.payloadDigest };
  }
  async submit(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const transactionId = keccak256(bytes), signed = this.signed.get(transactionId);
    if (!signed) throw new Error('UNRECOGNIZED_SIGNED_TRANSACTION');
    await this.verify(signed.candidate, signal);
    if (await this.relay.getChainId() !== 42161) throw new Error('SUBMISSION_CHAIN_MISMATCH');
    if (signal?.aborted) throw new Error('EXECUTION_CANCELLED');
    return this.relay.sendRawTransaction({ serializedTransaction: toHex(bytes) });
  }
  async receipt(transactionId: string, signal?: AbortSignal) {
    let signed = this.signed.get(transactionId);
    // Recovery does not sign or resend. Rebind the mined transaction to a
    // registered exact payload, even after expiry or a process restart.
    if (!signed && /^0x[0-9a-f]{64}$/.test(transactionId)) {
      const transaction = await this.client.getTransaction({ hash: transactionId as Hex });
      if (transaction.from.toLowerCase() !== this.account.address.toLowerCase() || transaction.to?.toLowerCase() !== this.config.executor.toLowerCase() || transaction.value !== 0n || transaction.chainId !== 42161) throw new Error('RECOVERY_TRANSACTION_MISMATCH');
      const entry = [...this.payloads.entries()].find(([, calldata]) => calldata === transaction.input);
      if (entry) {
        const candidate = this.candidates.get(entry[0]);
        if (candidate) signed = { candidate, calldata: entry[1] };
      }
    }
    if (!signed || signal?.aborted) return null;
    const receipt = await this.client.waitForTransactionReceipt({ hash: transactionId as Hex, confirmations: this.config.confirmations, timeout: 14000 });
    if ((await this.client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('RECEIPT_REORG');
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    let profit = 0n, proven = receipt.status === 'reverted';
    if (receipt.status === 'success') {
      const { route } = this.route(signed.candidate);
      const routeHash = keccak256(encodeAbiParameters(MULTI_LENDER_ROUTE_ABI[0].inputs, [route]));
      const events = receipt.logs.filter(log => log.address.toLowerCase() === this.config.executor.toLowerCase()).flatMap(log => {
        try { return [decodeEventLog({ abi: executorAbi, data: log.data, topics: log.topics, strict: true })]; } catch { return []; }
      }).filter(event => event.eventName === 'MultiVenueArbitrageExecuted');
      if (events.length === 1) {
        const event = events[0].args;
        proven = event.routeHash === routeHash && event.asset.toLowerCase() === WETH && event.flashAmount === route.flashAmount && event.legs === BigInt(route.legs.length) && event.netProfit >= route.minProfit;
        profit = event.netProfit;
      }
    }
    return { transactionId, source: `arbitrum:42161:${receipt.blockHash}`, executionStatus: receipt.status === 'success' ? 'success' as const : 'revert' as const, repaymentProven: proven, profitTransferProven: false, profitCustodyProven: proven, gasCostInProfitAsset: gas.toString(), profitAfterDebt: profit.toString() };
  }
}
