import { arbitrum } from 'viem/chains';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ExecutorAdapter } from './connectors.js';
import type { AllocationPlan, ExecutionReceipt, SimulationResult, SkillConfig } from './types.js';

const WEI_PER_ETH = 1_000_000_000_000_000_000n;

export function validateExecutorPlan(plan: AllocationPlan, config: SkillConfig): void {
  if (!config.executorAddress) throw new Error('executor address is required');
  if (plan.chainId !== config.chainId) throw new Error('plan chain does not match configured chain');
  if (plan.transaction.to.toLowerCase() !== config.executorAddress.toLowerCase()) {
    throw new Error('plan transaction must target the configured executor');
  }
}

/** Arbitrum raw-call adapter. Strategy connectors supply already-encoded, executor-validated calldata. */
export class ArbitrumExecutorAdapter implements ExecutorAdapter {
  readonly chainId = 42161;
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;

  constructor(private readonly config: SkillConfig, private readonly nativeTokenUsd: number) {
    if (config.chainId !== this.chainId) throw new Error('ArbitrumExecutorAdapter only supports chain 42161');
    if (!config.executorAddress || !config.operatorPrivateKey) throw new Error('executor address and operator key are required for Arbitrum execution');
    if (!Number.isFinite(nativeTokenUsd) || nativeTokenUsd <= 0) throw new Error('nativeTokenUsd must be positive');
    this.account = privateKeyToAccount(config.operatorPrivateKey);
    this.publicClient = createPublicClient({ chain: arbitrum, transport: http(config.rpcUrl) });
    this.walletClient = createWalletClient({ account: this.account, chain: arbitrum, transport: http(config.rpcUrl) });
  }

  async verify(config: SkillConfig): Promise<void> {
    // EDGE-02: an RPC/network mismatch blocks execution before calldata is evaluated.
    if (config.executorAddress !== this.config.executorAddress) throw new Error('executor address changed after adapter creation');
    if (await this.publicClient.getChainId() !== this.chainId) throw new Error('RPC chain is not Arbitrum One');
    const bytecode = await this.publicClient.getCode({ address: this.config.executorAddress! });
    if (!bytecode || bytecode === '0x') throw new Error('configured executor has no deployed bytecode');
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
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async broadcast(plan: AllocationPlan): Promise<ExecutionReceipt> {
    // EDGE-05: a failed final preflight prevents the irreversible broadcast mutation.
    validateExecutorPlan(plan, this.config);
    const preflight = await this.simulate(plan);
    if (!preflight.ok) throw new Error(`refusing broadcast after failed final preflight: ${preflight.reason}`);
    const transactionHash = await this.walletClient.sendTransaction(plan.transaction);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== 'success') throw new Error(`executor transaction reverted: ${transactionHash}`);
    return { transactionHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  }
}
