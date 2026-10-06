import type { Address } from '../types.js';

export type ScanProtocol = 'aave-v3' | 'morpho-blue' | 'balancer-v2' | 'uniswap-v2' | 'uniswap-v3' | 'uniswap-v4';
export type ScanKind = 'liquidation-watch' | 'flash-liquidity' | 'pool-liquidity' | 'arbitrage-pool';
export type ScanStatus = 'observed' | 'validated' | 'actionable';

export interface ScannerConfig {
  chainId: number;
  rpcUrl: string;
  startBlock: string;
  stateDir?: string;
  outputFile?: string;
  finalityBlocks?: number;
  logChunkSize?: number;
  pollIntervalMs?: number;
  assetAllowlist?: Address[];
  factories?: Array<{ family: 'uniswap-v2' | 'uniswap-v3'; factory: Address }>;
  protocols: {
    aaveV3?: { pool: Address; multicall3?: Address; healthBatchSize?: number; warningHealthFactor?: number };
    morphoBlue?: { blue: Address; warningHealthFactor?: number };
    balancerV2?: { vault: Address };
    uniswapV4?: { poolManager: Address; quoter?: Address; allowHooks?: boolean };
  };
}

export interface ScanCheckpoint {
  chainId: number;
  blockNumber: string;
  blockHash: `0x${string}`;
}

export interface ScanDiagnostic {
  protocol?: ScanProtocol;
  stage: 'config' | 'checkpoint' | 'logs' | 'state' | 'output';
  code: 'RPC_TRANSIENT' | 'RPC_PERMANENT' | 'INVALID_DATA' | 'REORG_DETECTED';
  message: string;
  retryable: boolean;
}

export interface ScanIntent {
  kind: 'aave-v3-liquidation' | 'morpho-blue-liquidation' | 'balancer-v2-flash-loan' | 'uniswap-v2-arbitrage' | 'uniswap-v3-arbitrage' | 'uniswap-v4-unlock';
  contract: Address;
  metadata: Record<string, string | string[] | boolean>;
}

/** Typed scanner output for solvers; legacy target/metrics remain display-only compatibility fields. */
export type ScanCandidate =
  | { protocol: 'aave-v3'; borrower: Address; pool: Address; reserves: Address[]; healthFactorWad: string; totalDebtBase: string; totalCollateralBase: string }
  | { protocol: 'morpho-blue'; borrower: Address; blue: Address; marketId: `0x${string}`; loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: string; borrowShares: string; borrowedAssets: string; collateral: string }
  | { protocol: 'balancer-v2'; vault: Address; poolId: `0x${string}`; callbackRequired: true; broadcastEligible: false }
  | { protocol: 'uniswap-v2'; factory: Address; pool: Address; token0: Address; token1: Address; broadcastEligible: false }
  | { protocol: 'uniswap-v3'; factory: Address; pool: Address; token0: Address; token1: Address; fee: number; tickSpacing: number; broadcastEligible: false }
  | { protocol: 'uniswap-v4'; poolManager: Address; poolId: `0x${string}`; currency0: Address; currency1: Address; hooks: Address; callbackRequired: true; broadcastEligible: false };

export interface ScanOpportunity {
  id: string;
  protocol: ScanProtocol;
  kind: ScanKind;
  status: ScanStatus;
  observedBlock: string;
  observedAt: string;
  expiresAt: string;
  target: Record<string, string>;
  metrics: Record<string, string>;
  executionIntent: ScanIntent;
  candidate: ScanCandidate;
}

export interface ScanEnvelope {
  schemaVersion: '1.0';
  runId: string;
  chainId: number;
  observedBlock: { number: string; hash: `0x${string}`; timestamp: string };
  opportunities: ScanOpportunity[];
  diagnostics: ScanDiagnostic[];
}
