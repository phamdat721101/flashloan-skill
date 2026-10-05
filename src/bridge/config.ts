import { readFile } from 'node:fs/promises';
import type { Address } from '../types.js';
import { parseDynamicSolverConfig, type DynamicSolverConfig } from '../dynamic.js';
import type { DexPairPolicy } from './dex-pair.js';
import type { DexQuoterRegistry } from './quote-reader.js';

function address(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value)) throw new Error(`${field} must be an address`);
  return value as Address;
}

export interface BridgePairConfig extends DexPairPolicy {
  flashTokenUsdOracle: Address;
  targetTokenUsdOracle: Address;
  maxOracleAgeSeconds: number;
}

export interface BridgeConfig {
  chainId: 42161;
  rpcUrl: string;
  quoters: DexQuoterRegistry;
  pairs: BridgePairConfig[];
  solver: DynamicSolverConfig;
}

/** Loads a secret-free, public-RPC bridge configuration with on-chain price attestations. */
export async function loadBridgeConfig(path: string): Promise<BridgeConfig> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bridge config must be an object');
  const value = raw as Record<string, unknown>;
  if (value.chainId !== 42161 || typeof value.rpcUrl !== 'string' || !/^https:\/\//.test(value.rpcUrl)) throw new Error('bridge requires an HTTPS Arbitrum One RPC');
  if (!value.quoters || typeof value.quoters !== 'object' || Array.isArray(value.quoters)) throw new Error('bridge quoters are required');
  if (!Array.isArray(value.pairs) || value.pairs.length === 0) throw new Error('bridge requires at least one DEX pair');
  const quotersRaw = value.quoters as Record<string, unknown>;
  const quoters: DexQuoterRegistry = { 'uniswap-v3': address(quotersRaw['uniswap-v3'], 'quoters.uniswap-v3'), 'pancakeswap-v3': address(quotersRaw['pancakeswap-v3'], 'quoters.pancakeswap-v3'), 'camelot-v3': address(quotersRaw['camelot-v3'], 'quoters.camelot-v3') };
  const pairs = value.pairs.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`pairs[${index}] must be an object`);
    const pair = item as Record<string, unknown>;
    if (!Number.isInteger(pair.maxOracleAgeSeconds) || (pair.maxOracleAgeSeconds as number) <= 0) throw new Error(`pairs[${index}].maxOracleAgeSeconds must be a positive integer`);
    return {
      id: typeof pair.id === 'string' ? pair.id : '', flashToken: address(pair.flashToken, `pairs[${index}].flashToken`), targetToken: address(pair.targetToken, `pairs[${index}].targetToken`), flashTokenDecimals: pair.flashTokenDecimals, uniFee: pair.uniFee,
      buyVenue: pair.buyVenue, sellVenue: pair.sellVenue, minFlashAmountWei: pair.minFlashAmountWei, maxFlashAmountWei: pair.maxFlashAmountWei, maxQuoteEvaluations: pair.maxQuoteEvaluations,
      minNetProfitUsd: typeof pair.minNetProfitUsd === 'string' ? pair.minNetProfitUsd : '', minProfitWei: typeof pair.minProfitWei === 'string' ? pair.minProfitWei : '', flashTokenUsdOracle: address(pair.flashTokenUsdOracle, `pairs[${index}].flashTokenUsdOracle`), targetTokenUsdOracle: address(pair.targetTokenUsdOracle, `pairs[${index}].targetTokenUsdOracle`), maxOracleAgeSeconds: pair.maxOracleAgeSeconds
    } as BridgePairConfig;
  });
  return { chainId: 42161, rpcUrl: value.rpcUrl, quoters, pairs, solver: parseDynamicSolverConfig(value.solver) };
}
