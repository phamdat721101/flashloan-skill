import { toFunctionSelector } from 'viem';
import type { Address, Hex } from '../types.js';

/**
 * Snapshot of bd-team/scripts/contracts/ArbitrumFlashLoanExecutorArtifact.ts
 * and scripts/.live-state.json on 2026-10-04. Do not resolve either path at
 * runtime: execution must use reviewed repository state.
 */
export const FLASH_EXECUTOR_ADDRESS = '0x093e98a6e2e278426adc7161b61bb2132e0ad192' as Address;

/**
 * Reviewed deployment state for the dynamic Uniswap V4 settlement executor.
 *
 * This is deliberately separate from FLASH_EXECUTOR_ADDRESS: the legacy
 * executor ABI cannot encode the authenticated V4 unlock/callback flow.
 * Scanner and execution integrations must select this deployment only when
 * they produce the ImmutableArbitrageExecutor route format.
 */
export const DYNAMIC_V4_EXECUTOR_DEPLOYMENT = {
  chainId: 42161,
  address: '0xfcd8f1257d8f37f4c51b4e6ac923137e5b6a2a16' as Address,
  deployTxHash: '0x12e591d8a1d8271da92aa6c6ed0607ec718e43960e736642bd75c34fc9856072' as Hex,
  aaveProvider: {
    address: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb' as Address,
    configureTxHash: '0x06352b41e77d93ea03933b16869face17419232edfd2cf9622b0260d00f6708b' as Hex,
    runtimeCodeHash: '0x1a95f317ee56e0b9aedc4f4b7abd9e546dc45c26d1d77e95bcf62b789d9a5486' as Hex
  },
  v4PoolManager: {
    address: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32' as Address,
    configureTxHash: '0x3a4e3bef79f19c1e21af52a197f93463e6399393052825014600cc00570e6bbb' as Hex,
    runtimeCodeHash: '0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4' as Hex,
    hooksAllowed: false
  }
} as const;

export type ExecutorCapability =
  | 'aave-v3-liquidation'
  | 'aave-v3-liquidation-split'
  | 'morpho-blue-liquidation'
  | 'uniswap-v4-arbitrage'
  | 'uniswap-v2-arbitrage'
  | 'uniswap-v3-arbitrage'
  | 'dex-pair-arbitrage';

const CAPABILITY_SIGNATURES: Record<ExecutorCapability, string> = {
  'aave-v3-liquidation': 'executeFlashLiquidation((address,uint256,address,address,uint24,uint256))',
  'aave-v3-liquidation-split': 'executeFlashLiquidationSplit((address,uint256,address,address,uint256,(address,address,uint256,uint256,bytes)[]))',
  'morpho-blue-liquidation': 'executeMorphoMarketLiquidation((address,uint256,(address,address,address,address,uint256),address,uint256,uint256,uint8,uint24,uint256))',
  'uniswap-v4-arbitrage': 'executeV4Arbitrage((address,uint256,address[],bytes[],uint256,uint256))',
  'uniswap-v2-arbitrage': 'executeV2Arbitrage((address,uint256,address[],bytes[],uint256,uint256))',
  'uniswap-v3-arbitrage': 'executeV3Arbitrage((address,uint256,address[],bytes[],uint256,uint256))',
  'dex-pair-arbitrage': 'executeDexPairArbitrage((address,uint256,address,uint8,uint8,uint24,uint256))'
};

export const FLASH_EXECUTOR_SELECTORS: Record<ExecutorCapability, Hex> = Object.fromEntries(
  Object.entries(CAPABILITY_SIGNATURES).map(([capability, signature]) => [capability, toFunctionSelector(signature) as Hex])
) as Record<ExecutorCapability, Hex>;

export const FLASH_EXECUTOR_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'executeFlashLiquidation', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'debtToken', type: 'address' }, { name: 'debtAmount', type: 'uint256' }, { name: 'collateralToken', type: 'address' }, { name: 'insolventUser', type: 'address' }, { name: 'dexPoolFee', type: 'uint24' }, { name: 'minProfit', type: 'uint256' }
  ] }], outputs: [] },
  { type: 'function', name: 'executeFlashLiquidationSplit', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'debtToken', type: 'address' }, { name: 'debtAmount', type: 'uint256' }, { name: 'collateralToken', type: 'address' }, { name: 'insolventUser', type: 'address' }, { name: 'minProfit', type: 'uint256' },
    { name: 'routes', type: 'tuple[]', components: [{ name: 'router', type: 'address' }, { name: 'approveTarget', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }
  ] }], outputs: [] },
  { type: 'function', name: 'executeMorphoMarketLiquidation', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'flashToken', type: 'address' }, { name: 'flashAmount', type: 'uint256' },
    { name: 'marketParams', type: 'tuple', components: [{ name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' }] },
    { name: 'borrower', type: 'address' }, { name: 'seizedAssets', type: 'uint256' }, { name: 'repaidShares', type: 'uint256' }, { name: 'sellVenue', type: 'uint8' }, { name: 'dexPoolFee', type: 'uint24' }, { name: 'minProfit', type: 'uint256' }
  ] }], outputs: [] },
  { type: 'function', name: 'executeDexPairArbitrage', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'flashToken', type: 'address' }, { name: 'flashAmount', type: 'uint256' }, { name: 'targetToken', type: 'address' }, { name: 'buyVenue', type: 'uint8' }, { name: 'sellVenue', type: 'uint8' }, { name: 'uniFee', type: 'uint24' }, { name: 'minProfit', type: 'uint256' }
  ] }], outputs: [] },
  { type: 'function', name: 'executeV2Arbitrage', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'flashAsset', type: 'address' }, { name: 'flashAmount', type: 'uint256' }, { name: 'targets', type: 'address[]' }, { name: 'calls', type: 'bytes[]' }, { name: 'minProfit', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
  ] }], outputs: [] },
  { type: 'function', name: 'executeV3Arbitrage', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'flashAsset', type: 'address' }, { name: 'flashAmount', type: 'uint256' }, { name: 'targets', type: 'address[]' }, { name: 'calls', type: 'bytes[]' }, { name: 'minProfit', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
  ] }], outputs: [] },
  { type: 'function', name: 'executeV4Arbitrage', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'flashAsset', type: 'address' }, { name: 'flashAmount', type: 'uint256' }, { name: 'targets', type: 'address[]' }, { name: 'calls', type: 'bytes[]' }, { name: 'minProfit', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
  ] }], outputs: [] },
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
