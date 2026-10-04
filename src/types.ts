export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface RiskPolicy {
  borrowTiersUsd: number[];
  maxGasUsd: number;
  maxDailyLossUsd: number;
  maxPriceImpactBps: number;
  minNetProfitUsd: number;
}

export interface SkillConfig {
  chainId: number;
  rpcUrl: string;
  executorAddress?: Address;
  treasuryAddress?: Address;
  operatorPrivateKey?: Hex;
  risk: RiskPolicy;
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
}

export interface SimulationResult {
  ok: boolean;
  gasEstimate?: bigint;
  gasCostUsd?: number;
  expectedNetProfitUsd?: number;
  reason?: string;
}

export interface Opportunity {
  id: string;
  chainId: number;
  channel: string;
  strategy: string;
  expiresAt: string;
  buildAllocation(borrowTierUsd: number): Promise<AllocationPlan | undefined>;
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
}

export interface RunResult {
  decisions: ExecutionDecision[];
  receipt?: ExecutionReceipt;
  diagnostics: string[];
}
