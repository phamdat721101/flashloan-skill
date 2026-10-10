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

/**
 * Reviewed deployment state for the callback-authenticated V2/V3/V4 executor.
 *
 * This is intentionally distinct from the legacy and V4-only deployments:
 * its `executeArbitrage` route format carries an explicit, code-hash-pinned
 * protocol root on every leg. Consumers must choose this record only for the
 * multi-venue route schema and must still pass their usual simulation gates.
 */
export const MULTI_VENUE_EXECUTOR_DEPLOYMENT = {
  chainId: 42161,
  address: '0xd130b45b7e7d08fb7dbb1c79fa5d9b95ea8e27b2' as Address,
  deployTxHash: '0x566b9d729cefe4af9f11a2673f15ab7cee8ae8c9c449276890c49d41391d6568' as Hex,
  runtimeCodeHash: '0xb9e2738a3643a2b8dc566f475df658f610a9f6d587d5d2ebea072104a4fccbed' as Hex,
  aaveProvider: {
    address: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb' as Address,
    configureTxHash: '0xa70d3aed4dcc9cae9388113b4d504bce3048822a813ba7c7c8e678529270dc84' as Hex,
    runtimeCodeHash: '0x1a95f317ee56e0b9aedc4f4b7abd9e546dc45c26d1d77e95bcf62b789d9a5486' as Hex
  },
  v2Factory: {
    address: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9' as Address,
    configureTxHash: '0x053b87e634714fa841b4b815b1800b733aa87ce0e6768d129cd75f04af60c9bf' as Hex,
    runtimeCodeHash: '0xbab145d02e7005f0d84c6c1639d39b799b0ea16df99ebbdaf5a14d9da820b4e0' as Hex
  },
  v3Factory: {
    address: '0x1F98431c8aD98523631AE4a59f267346ea31F984' as Address,
    configureTxHash: '0x436686a854d473b3b1e6c641d1c925bd1d899828570e6628554b855b728a9471' as Hex,
    runtimeCodeHash: '0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69' as Hex
  },
  v4PoolManager: {
    address: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32' as Address,
    configureTxHash: '0xdc2a45754be442fcd7366987b3f14925c424e52e40a7dfe54e0249428efe856c' as Hex,
    runtimeCodeHash: '0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4' as Hex,
    hooksAllowed: false
  }
} as const;

/**
 * Reviewed deployment state for the >= $100k Multi-Split & Triangular Flash Loan Executor.
 * Deployed at Block #513468519. Supports 0%-fee Morpho Blue flash loans >= $100,000,
 * convex multi-pool split routes across non-USDC assets, dynamic balance unwinding,
 * and atomic profit verification.
 */
export const MULTI_SPLIT_EXECUTOR_DEPLOYMENT = {
  chainId: 42161,
  address: '0xb1aac2079c52fd31e038ec348505a0f55859d60f' as Address,
  deployTxHash: '0x0996d0328a43ae3f23cb5d0297c76292d910f59a88a1276c928578a52010f5ef' as Hex,
  morphoBlue: '0x6c247b1F6182318877311737BaC0844bAa518F5e' as Address,
  capability: 'multi-split-arbitrage'
} as const;

export type ExecutorCapability =
  | 'aave-v3-liquidation'
  | 'aave-v3-liquidation-split'
  | 'morpho-blue-liquidation'
  | 'uniswap-v4-arbitrage'
  | 'uniswap-v2-arbitrage'
  | 'uniswap-v3-arbitrage'
  | 'dex-pair-arbitrage'
  | 'multi-venue-arbitrage'
  | 'multi-split-arbitrage';

const CAPABILITY_SIGNATURES: Record<ExecutorCapability, string> = {
  'aave-v3-liquidation': 'executeFlashLiquidation((address,uint256,address,address,uint24,uint256))',
  'aave-v3-liquidation-split': 'executeFlashLiquidationSplit((address,uint256,address,address,uint256,(address,address,uint256,uint256,bytes)[]))',
  'morpho-blue-liquidation': 'executeMorphoMarketLiquidation((address,uint256,(address,address,address,address,uint256),address,uint256,uint256,uint8,uint24,uint256))',
  'uniswap-v4-arbitrage': 'executeV4Arbitrage((address,uint256,address[],bytes[],uint256,uint256))',
  'uniswap-v2-arbitrage': 'executeV2Arbitrage((address,uint256,address[],bytes[],uint256,uint256))',
  'uniswap-v3-arbitrage': 'executeV3Arbitrage((address,uint256,address[],bytes[],uint256,uint256))',
  'dex-pair-arbitrage': 'executeDexPairArbitrage((address,uint256,address,uint8,uint8,uint24,uint256))',
  'multi-venue-arbitrage': 'executeArbitrage((address,address,uint256,(uint8,address,address,address,address,uint256,uint256,uint160,int24,address,bytes)[],uint256,uint256))',
  'multi-split-arbitrage': 'executeMultiSplitPairArbitrage((address,uint256,uint256,(address,uint256,uint8,uint8,uint24,uint24)[]))'
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
  { type: 'function', name: 'executeArbitrage', stateMutability: 'nonpayable', inputs: [{ name: 'route', type: 'tuple', components: [
    { name: 'aaveProvider', type: 'address' }, { name: 'flashAsset', type: 'address' }, { name: 'flashAmount', type: 'uint256' },
    { name: 'legs', type: 'tuple[]', components: [
      { name: 'venueVersion', type: 'uint8' }, { name: 'root', type: 'address' }, { name: 'pool', type: 'address' }, { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'fee', type: 'uint24' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }, { name: 'hookData', type: 'bytes' }
    ] }, { name: 'minProfit', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
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
  , { type: 'event', name: 'MultiVenueArbitrageExecuted', inputs: [
    { indexed: true, name: 'routeHash', type: 'bytes32' }, { indexed: true, name: 'asset', type: 'address' }, { indexed: false, name: 'flashAmount', type: 'uint256' }, { indexed: false, name: 'netProfit', type: 'uint256' }, { indexed: false, name: 'legs', type: 'uint256' }
  ], anonymous: false }
] as const;
