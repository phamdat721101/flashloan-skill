import { arbitrum, arbitrumSepolia, base, robinhood } from 'viem/chains';
import type { Address } from 'viem';

export type EvmChainKey = 'arbitrum' | 'base' | 'robinhood';
export const EVM_PROFILES = {
  42161: { key: 'arbitrum', chain: arbitrum, rpcEnv: 'ARBITRUM_RPC_URL', feeModel: 'bundled', wrappedNative: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' },
  421614: { key: 'arbitrum', chain: arbitrumSepolia, rpcEnv: 'ARBITRUM_RPC_URL', feeModel: 'bundled', wrappedNative: '0x980b62da83eff3d4576c64799378c1d7faf17c73' },
  8453: { key: 'base', chain: base, rpcEnv: 'BASE_RPC_URL', feeModel: 'op-stack', wrappedNative: '0x4200000000000000000000000000000000000006' },
  4663: { key: 'robinhood', chain: robinhood, rpcEnv: 'ROBINHOOD_RPC_URL', feeModel: 'bundled', wrappedNative: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' }
} as const;
export type EvmChainId = keyof typeof EVM_PROFILES;
/** Chainlink native/USD feed and L2 sequencer uptime feed, verified on-chain 2026-10-28 (ETH/USD 8 dp; uptime answer 0 = up). */
export const NATIVE_USD_FEEDS: Partial<Record<number, { feed: Address; sequencerUptimeFeed: Address }>> = {
  42161: { feed: '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612', sequencerUptimeFeed: '0xfdb631f5ee196f0ed6faa767959853a9f217697d' }
};
export function evmProfile(chainId: number) {
  if (!Number.isSafeInteger(chainId) || !Object.hasOwn(EVM_PROFILES, chainId)) throw new Error('UNSUPPORTED_EVM_CHAIN');
  return EVM_PROFILES[chainId as EvmChainId];
}
export function isEvmChain(chain: unknown): chain is EvmChainKey {
  return chain === 'arbitrum' || chain === 'base' || chain === 'robinhood';
}
export function matchesEvmNetwork(chain: unknown, network: unknown): boolean {
  if (typeof network !== 'string' || !/^[1-9][0-9]*$/.test(network)) return false;
  try { return evmProfile(Number(network)).key === chain; } catch { return false; }
}
export const PROFIT_ASSETS: Readonly<Record<number, readonly Address[]>> = {
  42161: [EVM_PROFILES[42161].wrappedNative],
  8453: [EVM_PROFILES[8453].wrappedNative, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
  4663: [EVM_PROFILES[4663].wrappedNative, '0x5fc5360d0400a0fd4f2af552add042d716f1d168']
};
