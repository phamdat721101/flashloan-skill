import { evmProfile } from './evm-chains.js';
import { createPublicClient, createWalletClient, decodeFunctionData, formatUnits, http, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ExecutorAdapter } from './connectors.js';
import type { AllocationPlan, ExecutionReceipt, SimulationResult, SkillConfig } from './types.js';
import { DYNAMIC_V4_EXECUTOR_DEPLOYMENT, FLASH_EXECUTOR_ABI, FLASH_EXECUTOR_SELECTORS, MULTI_VENUE_EXECUTOR_DEPLOYMENT } from './contracts/flash-executor.js';
import { executionOutcome } from './execution-outcome.js';

const WEI_PER_ETH = 1_000_000_000_000_000_000n;

export function validateExecutorPlan(plan: AllocationPlan, config: SkillConfig): void {
  if (!config.executorAddress) throw new Error('executor address is required');
  if (plan.chainId !== config.chainId) throw new Error('plan chain does not match configured chain');
  if (plan.transaction.to.toLowerCase() !== config.executorAddress.toLowerCase()) {
    throw new Error('plan transaction must target the configured executor');
  }
  // These immutable addresses retain the reversed V4 BalanceDelta decoder.
  // A local source repair does not admit their deployed V4 execution path.
  const target = plan.transaction.to.toLowerCase();
  if (target === DYNAMIC_V4_EXECUTOR_DEPLOYMENT.address.toLowerCase()) throw new Error('known unsafe V4 deployment requires corrected deployment admission');
  if (target === MULTI_VENUE_EXECUTOR_DEPLOYMENT.address.toLowerCase() && plan.transaction.data.slice(0, 10).toLowerCase() === FLASH_EXECUTOR_SELECTORS['multi-venue-arbitrage'].toLowerCase()) {
    const decoded = decodeFunctionData({ abi: FLASH_EXECUTOR_ABI, data: plan.transaction.data });
    if (decoded.functionName !== 'executeArbitrage') throw new Error('invalid multi-venue route');
    if (decoded.args[0].legs.some(leg => leg.venueVersion === 4)) throw new Error('known unsafe V4 deployment requires corrected deployment admission');
  }
  if (plan.expiresAt && Date.parse(plan.expiresAt) <= Date.now()) throw new Error('stale proposal has expired');
  if (plan.capability) {
    const expected = FLASH_EXECUTOR_SELECTORS[plan.capability];
    if (plan.transaction.data.slice(0, 10).toLowerCase() !== expected.toLowerCase()) throw new Error('plan selector does not match executor capability');
  }
}

export function validateBroadcastEvidence(plan: AllocationPlan, latestBlock: bigint, maxProposalBlockAge: number): void {
  if (!plan.capability || plan.sourceBlock === undefined || plan.quoteBlock === undefined || !plan.expiresAt) {
    throw new Error('proposal lacks capability or block-bound execution evidence');
  }
  if (latestBlock - plan.sourceBlock > BigInt(maxProposalBlockAge) || latestBlock - plan.quoteBlock > BigInt(maxProposalBlockAge)) {
    throw new Error('stale proposal quote block exceeds freshness window');
  }
}

/** Arbitrum raw-call adapter. Strategy connectors supply already-encoded, executor-validated calldata. */
export class ArbitrumExecutorAdapter implements ExecutorAdapter {
  readonly chainId: number;
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;

  constructor(private readonly config: SkillConfig, private readonly nativeTokenUsd: number) {
    this.chainId = config.chainId; evmProfile(this.chainId);
    if (this.chainId !== 42161) throw new Error('Use the manifest-bound EVM liquidity execution path for new chains');
    if (!config.executorAddress || !config.operatorPrivateKey) throw new Error('executor address and operator key are required for Arbitrum execution');
    if (!Number.isFinite(nativeTokenUsd) || nativeTokenUsd <= 0) throw new Error('nativeTokenUsd must be positive');
    this.account = privateKeyToAccount(config.operatorPrivateKey);
    this.publicClient = createPublicClient({ chain: evmProfile(config.chainId).chain, transport: http(config.rpcUrl) });
    this.walletClient = createWalletClient({ account: this.account, chain: evmProfile(config.chainId).chain, transport: http(config.privateRelayUrl ?? config.rpcUrl) });
  }

  async verify(config: SkillConfig): Promise<void> {
    // EDGE-02: an RPC/network mismatch blocks execution before calldata is evaluated.
    if (config.executorAddress !== this.config.executorAddress) throw new Error('executor address changed after adapter creation');
    if (await this.publicClient.getChainId() !== this.chainId) throw new Error('RPC chain is not Arbitrum One');
    const bytecode = await this.publicClient.getCode({ address: this.config.executorAddress! });
    if (!bytecode || bytecode === '0x') throw new Error('configured executor has no deployed bytecode');
    const owner = await this.publicClient.readContract({ address: this.config.executorAddress!, abi: FLASH_EXECUTOR_ABI, functionName: 'owner' });
    if (owner.toLowerCase() !== this.account.address.toLowerCase()) throw new Error('signer is not executor owner');
  }

  async simulate(plan: AllocationPlan): Promise<SimulationResult> {
    try {
      validateExecutorPlan(plan, this.config);
      await this.publicClient.call({ account: this.account.address, ...plan.transaction });
      const gasEstimate = await this.publicClient.estimateGas({ account: this.account.address, ...plan.transaction });
      const gasPrice = await this.publicClient.getGasPrice();
      return {
        ok: true,
        gasEstimate,
        gasCostUsd: Number(gasEstimate * gasPrice) / Number(WEI_PER_ETH) * this.nativeTokenUsd,
        expectedNetProfitUsd: plan.quotedNetProfitUsd
      };
    } catch (error) {
      const outcome = executionOutcome('simulate', error);
      return { ok: false, reason: outcome.message, outcome };
    }
  }

  async broadcast(plan: AllocationPlan): Promise<ExecutionReceipt> {
    // EDGE-05: a failed final preflight prevents the irreversible broadcast mutation.
    validateExecutorPlan(plan, this.config);
    if (!this.config.privateRelayUrl) throw new Error('private relay is required for broadcast');
    const latestBlock = await this.publicClient.getBlockNumber();
    validateBroadcastEvidence(plan, latestBlock, this.config.risk.maxProposalBlockAge);
    const preflight = await this.simulate(plan);
    if (!preflight.ok) throw new Error(`refusing broadcast after failed final preflight: ${preflight.reason}`);
    const transactionHash = await this.walletClient.sendTransaction(plan.transaction);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== 'success') throw new Error(`executor transaction reverted: ${transactionHash}`);
    const gasCostUsd = Number(receipt.gasUsed * receipt.effectiveGasPrice) / Number(WEI_PER_ETH) * this.nativeTokenUsd;
    const events = parseEventLogs({ abi: FLASH_EXECUTOR_ABI, logs: receipt.logs.filter((log) => log.address.toLowerCase() === this.config.executorAddress!.toLowerCase()), strict: false });
    const profit = events.reduce<bigint | undefined>((value, event) => {
      const netProfit = event.args?.netProfit;
      return typeof netProfit === 'bigint' ? (value ?? 0n) + netProfit : value;
    }, undefined);
    if (profit === undefined || !plan.profitTokenUsd || plan.profitTokenDecimals === undefined) {
      return { transactionHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, realizedPnlStatus: 'unknown', outcome: { stage: 'receipt', code: 'REALIZED_PNL_UNKNOWN', retryable: false, message: 'receipt profit cannot be conservatively valued' } };
    }
    const realizedProfitUsd = Number(formatUnits(profit, plan.profitTokenDecimals)) * plan.profitTokenUsd - gasCostUsd;
    return { transactionHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, realizedProfitUsd, realizedPnlStatus: 'known' };
  }
}

/**
 * Public-RPC simulation boundary. It reads the on-chain executor owner and uses
 * that address as the eth_call sender, so owner-gated calldata can be tested
 * without loading an operator private key or constructing a wallet client.
 */
export class ArbitrumReadOnlySimulator {
  private readonly publicClient;

  constructor(private readonly config: Pick<SkillConfig, 'chainId' | 'rpcUrl' | 'executorAddress'>, private readonly nativeTokenUsd: number) {
    if (config.chainId !== 42161 || !config.executorAddress) throw new Error('Arbitrum read-only simulation requires chain 42161 and executor address');
    if (!Number.isFinite(nativeTokenUsd) || nativeTokenUsd <= 0) throw new Error('nativeTokenUsd must be positive');
    this.publicClient = createPublicClient({ chain: evmProfile(config.chainId).chain, transport: http(config.rpcUrl) });
  }

  async simulate(plan: AllocationPlan): Promise<SimulationResult> {
    try {
      validateExecutorPlan(plan, this.config as SkillConfig);
      if (await this.publicClient.getChainId() !== 42161) throw new Error('RPC chain is not Arbitrum One');
      const bytecode = await this.publicClient.getCode({ address: this.config.executorAddress! });
      if (!bytecode || bytecode === '0x') throw new Error('configured executor has no deployed bytecode');
      const owner = await this.publicClient.readContract({ address: this.config.executorAddress!, abi: FLASH_EXECUTOR_ABI, functionName: 'owner' });
      await this.publicClient.call({ account: owner, ...plan.transaction });
      const gasEstimate = await this.publicClient.estimateGas({ account: owner, ...plan.transaction });
      const gasPrice = await this.publicClient.getGasPrice();
      return { ok: true, gasEstimate, gasCostUsd: Number(gasEstimate * gasPrice) / Number(WEI_PER_ETH) * this.nativeTokenUsd, expectedNetProfitUsd: plan.quotedNetProfitUsd };
    } catch (error) {
      const outcome = executionOutcome('simulate', error);
      return { ok: false, reason: outcome.message, outcome };
    }
  }
}
