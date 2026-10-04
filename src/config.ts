import type { Address, Hex, RiskPolicy, SkillConfig } from './types.js';
import { FLASH_EXECUTOR_ADDRESS } from './contracts/flash-executor.js';

const DEFAULT_RISK: RiskPolicy = {
  borrowTiersUsd: [],
  maxGasUsd: 2_000,
  maxDailyLossUsd: 10_000,
  maxPriceImpactBps: 200,
  minNetProfitUsd: 1,
  maxProposalBlockAge: 1,
  rpcConcurrency: 4
};

function optionalAddress(value: string | undefined, name: string): Address | undefined {
  if (!value) return undefined;
  if (!/^0x[\da-fA-F]{40}$/.test(value)) throw new Error(`${name} must be a 20-byte hex address`);
  return value as Address;
}

function optionalPrivateKey(value: string | undefined): Hex | undefined {
  if (!value) return undefined;
  if (!/^0x[\da-fA-F]{64}$/.test(value)) throw new Error('OPERATOR_PRIVATE_KEY must be a 32-byte hex key');
  return value as Hex;
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function tiers(value: string | undefined): number[] {
  if (!value) return DEFAULT_RISK.borrowTiersUsd;
  const parsed = value.split(',').map((item) => Number(item.trim()));
  if (parsed.length === 0 || parsed.some((item) => !Number.isFinite(item) || item <= 0)) {
    throw new Error('BORROW_TIERS_USD must be a comma-separated list of positive amounts');
  }
  return [...new Set(parsed)].sort((a, b) => a - b);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SkillConfig {
  // EDGE-01: malformed secret or configuration input is rejected before connector creation.
  const chainId = Number(env.CHAIN_ID ?? '42161');
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('CHAIN_ID must be a positive integer');
  const rpcUrl = env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
  try { new URL(rpcUrl); } catch { throw new Error('ARBITRUM_RPC_URL must be a valid URL'); }

  return {
    chainId,
    rpcUrl,
    executorAddress: optionalAddress(env.FLASH_EXECUTOR_ADDRESS ?? FLASH_EXECUTOR_ADDRESS, 'FLASH_EXECUTOR_ADDRESS'),
    treasuryAddress: optionalAddress(env.TREASURY_ADDRESS, 'TREASURY_ADDRESS'),
    operatorPrivateKey: optionalPrivateKey(env.OPERATOR_PRIVATE_KEY),
    risk: {
      borrowTiersUsd: tiers(env.BORROW_TIERS_USD),
      maxGasUsd: positive(env.MAX_GAS_USD, DEFAULT_RISK.maxGasUsd, 'MAX_GAS_USD'),
      maxDailyLossUsd: positive(env.MAX_DAILY_LOSS_USD, DEFAULT_RISK.maxDailyLossUsd, 'MAX_DAILY_LOSS_USD'),
      maxPriceImpactBps: positive(env.MAX_PRICE_IMPACT_BPS, DEFAULT_RISK.maxPriceImpactBps, 'MAX_PRICE_IMPACT_BPS'),
      minNetProfitUsd: positive(env.MIN_NET_PROFIT_USD, DEFAULT_RISK.minNetProfitUsd, 'MIN_NET_PROFIT_USD'),
      maxProposalBlockAge: positive(env.MAX_PROPOSAL_BLOCK_AGE, DEFAULT_RISK.maxProposalBlockAge, 'MAX_PROPOSAL_BLOCK_AGE'),
      rpcConcurrency: positive(env.RPC_CONCURRENCY, DEFAULT_RISK.rpcConcurrency, 'RPC_CONCURRENCY')
    }
  };
}

export function canBroadcast(config: SkillConfig): boolean {
  return Boolean(config.operatorPrivateKey && config.executorAddress);
}
