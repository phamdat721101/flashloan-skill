import { readFile } from 'node:fs/promises';
import type { Address } from '../types.js';
import type { ScannerConfig } from './types.js';

function address(value: unknown, name: string): Address {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value)) throw new Error(`${name} must be a 20-byte hex address`);
  return value as Address;
}

function positiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

/** Loads a secret-free, public-RPC-only scanner configuration. */
export async function loadScannerConfig(filePath: string): Promise<ScannerConfig> {
  const raw: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scanner config must be an object');
  const value = raw as Record<string, unknown>;
  if (value.chainId !== 42161) throw new Error('scanner currently supports Arbitrum One (chain 42161) only');
  if (typeof value.rpcUrl !== 'string' || !/^https?:\/\//.test(value.rpcUrl)) throw new Error('rpcUrl must be an HTTP(S) URL');
  if (typeof value.startBlock !== 'string' || !/^\d+$/.test(value.startBlock)) throw new Error('startBlock must be a decimal string');
  const protocols = value.protocols;
  if (!protocols || typeof protocols !== 'object' || Array.isArray(protocols)) throw new Error('protocols must be an object');
  const source = protocols as Record<string, unknown>;
  const aave = source.aaveV3 as Record<string, unknown> | undefined;
  const morpho = source.morphoBlue as Record<string, unknown> | undefined;
  const balancer = source.balancerV2 as Record<string, unknown> | undefined;
  const v4 = source.uniswapV4 as Record<string, unknown> | undefined;
  const assetAllowlist = value.assetAllowlist === undefined ? undefined : (value.assetAllowlist as unknown[]).map((item) => address(item, 'assetAllowlist item'));
  return {
    chainId: 42161,
    rpcUrl: value.rpcUrl,
    startBlock: value.startBlock,
    stateDir: typeof value.stateDir === 'string' ? value.stateDir : '.flashloan-agent/scan',
    outputFile: typeof value.outputFile === 'string' ? value.outputFile : undefined,
    finalityBlocks: positiveInteger(value.finalityBlocks, 'finalityBlocks', 20),
    logChunkSize: positiveInteger(value.logChunkSize, 'logChunkSize', 2_000),
    pollIntervalMs: positiveInteger(value.pollIntervalMs, 'pollIntervalMs', 5_000),
    assetAllowlist,
    protocols: {
      aaveV3: aave ? { pool: address(aave.pool, 'protocols.aaveV3.pool'), multicall3: aave.multicall3 ? address(aave.multicall3, 'protocols.aaveV3.multicall3') : undefined, healthBatchSize: positiveInteger(aave.healthBatchSize, 'protocols.aaveV3.healthBatchSize', 200), warningHealthFactor: typeof aave.warningHealthFactor === 'number' ? aave.warningHealthFactor : 1.08 } : undefined,
      morphoBlue: morpho ? { blue: address(morpho.blue, 'protocols.morphoBlue.blue'), warningHealthFactor: typeof morpho.warningHealthFactor === 'number' ? morpho.warningHealthFactor : 1.05 } : undefined,
      balancerV2: balancer ? { vault: address(balancer.vault, 'protocols.balancerV2.vault') } : undefined,
      uniswapV4: v4 ? { poolManager: address(v4.poolManager, 'protocols.uniswapV4.poolManager'), quoter: v4.quoter ? address(v4.quoter, 'protocols.uniswapV4.quoter') : undefined, allowHooks: v4.allowHooks === true } : undefined
    }
  };
}
