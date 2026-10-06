export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface RiskPolicy {
  /** Deprecated compatibility input. Dynamic builders must derive native-token bounds. */
  borrowTiersUsd: number[];
  maxGasUsd: number;
  maxDailyLossUsd: number;
  maxPriceImpactBps: number;
  minNetProfitUsd: number;
  maxProposalBlockAge: number;
  rpcConcurrency: number;
}

export interface SkillConfig {
  chainId: number;
  rpcUrl: string;
  /** A private transaction endpoint. Required for autonomous broadcast. */
  privateRelayUrl?: string;
  executorAddress?: Address;
  treasuryAddress?: Address;
  operatorPrivateKey?: Hex;
  risk: RiskPolicy;
}

/** Immutable, block-bound evidence required to send a dynamically-built plan. */
export interface ProposalEvidence {
  sourceBlock: bigint;
  quoteBlock: bigint;
  expiresAt: string;
  capability: NonNullable<AllocationPlan['capability']>;
  broadcastEligible: boolean;
}

export interface TransactionRequest {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface AllocationLeg {
  venue: string;
  path: Address[];
  allocationBps: number;
  minAmountOut: bigint;
}

export interface AllocationPlan {
  id: string;
  opportunityId: string;
  chainId: number;
  strategy: string;
  borrowTierUsd: number;
  priceImpactBps: number;
  quotedNetProfitUsd: number;
  legs: AllocationLeg[];
  transaction: TransactionRequest;
  /** Source and quote evidence are required for new autonomous proposals. */
  sourceBlock?: bigint;
  quoteBlock?: bigint;
  capability?: 'aave-v3-liquidation' | 'aave-v3-liquidation-split' | 'morpho-blue-liquidation' | 'uniswap-v2-arbitrage' | 'uniswap-v3-arbitrage' | 'uniswap-v4-arbitrage' | 'dex-pair-arbitrage';
  profitTokenUsd?: number;
  profitTokenDecimals?: number;
  expiresAt?: string;
}

export type ExecutionStage = 'discover' | 'build' | 'simulate' | 'preflight' | 'broadcast' | 'receipt';

export interface ExecutionOutcome {
  stage: ExecutionStage;
  code: string;
  retryable: boolean;
  message: string;
}

export interface SimulationResult {
  ok: boolean;
  gasEstimate?: bigint;
  gasCostUsd?: number;
  expectedNetProfitUsd?: number;
  reason?: string;
  outcome?: ExecutionOutcome;
}

export interface Opportunity {
  id: string;
  chainId: number;
  channel: string;
  strategy: string;
  expiresAt: string;
  buildAllocation(borrowTierUsd: number): Promise<AllocationPlan | undefined>;
  /** Preferred dynamic builder. It owns protocol-specific repay and route bounds. */
  buildAllocations?(config: SkillConfig): Promise<AllocationPlan[]>;
}

export interface ExecutionDecision {
  planId: string;
  allowed: boolean;
  reasons: string[];
  simulation: SimulationResult;
}

export interface ExecutionReceipt {
  transactionHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  realizedProfitUsd?: number;
  realizedPnlStatus: 'known' | 'unknown';
  outcome?: ExecutionOutcome;
}

export interface RunResult {
  decisions: ExecutionDecision[];
  receipt?: ExecutionReceipt;
  diagnostics: string[];
}
