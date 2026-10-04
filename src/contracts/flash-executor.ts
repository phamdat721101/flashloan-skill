import { toFunctionSelector } from 'viem';
import type { Address, Hex } from '../types.js';

/**
 * Snapshot of bd-team/scripts/contracts/ArbitrumFlashLoanExecutorArtifact.ts
 * and scripts/.live-state.json on 2026-10-04. Do not resolve either path at
 * runtime: execution must use reviewed repository state.
 */
export const FLASH_EXECUTOR_ADDRESS = '0x093e98a6e2e278426adc7161b61bb2132e0ad192' as Address;

export type ExecutorCapability =
  | 'aave-v3-liquidation'
  | 'morpho-blue-liquidation'
  | 'uniswap-v4-arbitrage'
  | 'dex-pair-arbitrage';

const CAPABILITY_SIGNATURES: Record<ExecutorCapability, string> = {
  'aave-v3-liquidation': 'executeFlashLiquidation((address,uint256,address,address,uint24,uint256))',
  'morpho-blue-liquidation': 'executeMorphoMarketLiquidation((address,uint256,(address,address,address,address,uint256),address,uint256,uint256,uint8,uint24,uint256))',
  'uniswap-v4-arbitrage': 'executeV4SwapArbitrage((address,uint256,address,(address,address,uint24,int24,address),bool,uint8,uint24,uint256))',
  'dex-pair-arbitrage': 'executeDexPairArbitrage((address,uint256,address,uint8,uint8,uint24,uint256))'
};

export const FLASH_EXECUTOR_SELECTORS: Record<ExecutorCapability, Hex> = Object.fromEntries(
  Object.entries(CAPABILITY_SIGNATURES).map(([capability, signature]) => [capability, toFunctionSelector(signature) as Hex])
) as Record<ExecutorCapability, Hex>;

export const FLASH_EXECUTOR_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'event', name: 'LiquidationExecuted', inputs: [
    { indexed: true, name: 'insolventUser', type: 'address' },
    { indexed: true, name: 'debtToken', type: 'address' },
    { indexed: true, name: 'collateralToken', type: 'address' },
    { indexed: false, name: 'debtRepaid', type: 'uint256' },
    { indexed: false, name: 'netProfit', type: 'uint256' }
  ], anonymous: false },
  { type: 'event', name: 'ArbitrageExecuted', inputs: [
    { indexed: true, name: 'token', type: 'address' },
    { indexed: false, name: 'flashAmount', type: 'uint256' },
    { indexed: false, name: 'netProfit', type: 'uint256' }
  ], anonymous: false },
  { type: 'event', name: 'DexPairArbitrageExecuted', inputs: [
    { indexed: true, name: 'flashToken', type: 'address' },
    { indexed: true, name: 'targetToken', type: 'address' },
    { indexed: false, name: 'flashAmount', type: 'uint256' },
    { indexed: false, name: 'netProfit', type: 'uint256' },
    { indexed: false, name: 'buyVenue', type: 'uint8' },
    { indexed: false, name: 'sellVenue', type: 'uint8' }
  ], anonymous: false }
] as const;
