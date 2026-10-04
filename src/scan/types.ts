import type { Address } from '../types.js';

export type ScanProtocol = 'aave-v3' | 'morpho-blue' | 'balancer-v2' | 'uniswap-v4';
export type ScanKind = 'liquidation-watch' | 'flash-liquidity' | 'pool-liquidity';
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
  protocols: {
    aaveV3?: { pool: Address; warningHealthFactor?: number };
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
  kind: 'aave-v3-liquidation' | 'morpho-blue-liquidation' | 'balancer-v2-flash-loan' | 'uniswap-v4-unlock';
  contract: Address;
  metadata: Record<string, string | string[] | boolean>;
}

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
}

export interface ScanEnvelope {
  schemaVersion: '1.0';
  runId: string;
  chainId: number;
  observedBlock: { number: string; hash: `0x${string}`; timestamp: string };
  opportunities: ScanOpportunity[];
  diagnostics: ScanDiagnostic[];
}
