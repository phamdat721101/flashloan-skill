import assert from 'node:assert/strict';
import test from 'node:test';
import { ArbitrumScanner } from '../scan/scanner.js';
import type { ScannerConfig } from '../scan/types.js';

const address = '0x1111111111111111111111111111111111111111' as const;
const otherAddress = '0x2222222222222222222222222222222222222222' as const;
const WAD = 1_000_000_000_000_000_000n;

function scannerConfig(): ScannerConfig {
  return { chainId: 42161, rpcUrl: 'https://rpc.example', startBlock: '1', protocols: { aaveV3: { pool: address }, uniswapV4: { poolManager: address, allowHooks: false } } };
}

test('EDGE-03 validates an Aave borrower with current state rather than only its borrow event', async () => {
  const scanner = new ArbitrumScanner(scannerConfig());
  (scanner as unknown as { client: unknown }).client = {
    getLogs: async () => [{ args: { onBehalfOf: otherAddress }, blockNumber: 10n }],
    readContract: async () => [300n, 200n, 0n, 0n, 0n, (WAD * 9n) / 10n]
  };
  const opportunities: unknown[] = [];
  const diagnostics: unknown[] = [];
  await (scanner as unknown as { scanAave: (from: bigint, to: bigint, out: unknown[], diagnostics: unknown[]) => Promise<void> }).scanAave(1n, 10n, opportunities, diagnostics);
  assert.equal(opportunities.length, 1);
  assert.equal((opportunities[0] as { status: string }).status, 'actionable');
  assert.deepEqual(diagnostics, []);
});

test('batches Aave health checks through configured Multicall3 instead of per-account reads', async () => {
  const config = scannerConfig();
  config.protocols.aaveV3 = { pool: address, multicall3: otherAddress, healthBatchSize: 200 };
  const scanner = new ArbitrumScanner(config);
  let multicallCalls = 0;
  (scanner as unknown as { client: unknown }).client = {
    getLogs: async () => [{ args: { onBehalfOf: otherAddress, reserve: address }, blockNumber: 10n }],
    multicall: async (request: { multicallAddress: string; contracts: unknown[] }) => {
      multicallCalls++;
      assert.equal(request.multicallAddress, otherAddress);
      assert.equal(request.contracts.length, 1);
      return [{ status: 'success', result: [300n, 200n, 0n, 0n, 0n, (WAD * 9n) / 10n] }];
    }
  };
  const opportunities: unknown[] = [];
  await (scanner as unknown as { scanAave: (from: bigint, to: bigint, out: unknown[], diagnostics: unknown[]) => Promise<void> }).scanAave(1n, 10n, opportunities, []);
  assert.equal(multicallCalls, 1);
  assert.equal(opportunities.length, 1);
});

test('EDGE-04 rejects hooked Uniswap v4 pools unless configuration explicitly permits hooks', async () => {
  const scanner = new ArbitrumScanner(scannerConfig());
  (scanner as unknown as { client: unknown }).client = {
    getLogs: async () => [{ args: { id: `0x${'a'.repeat(64)}`, currency0: address, currency1: otherAddress, hooks: otherAddress, fee: 3000, tickSpacing: 60 }, blockNumber: 11n }]
  };
  const opportunities: unknown[] = [];
  const diagnostics: unknown[] = [];
  await (scanner as unknown as { scanV4: (from: bigint, to: bigint, out: unknown[], diagnostics: unknown[]) => Promise<void> }).scanV4(1n, 11n, opportunities, diagnostics);
  assert.deepEqual(opportunities, []);
  assert.deepEqual(diagnostics, []);
});

test('validates Morpho borrower health from current market and oracle state', async () => {
  const config = scannerConfig();
  config.protocols = { morphoBlue: { blue: address } };
  const scanner = new ArbitrumScanner(config);
  const marketId = `0x${'c'.repeat(64)}` as const;
  (scanner as unknown as { client: unknown }).client = {
    getLogs: async () => [{ args: { id: marketId, onBehalf: otherAddress }, blockNumber: 12n }],
    readContract: async (request: { functionName: string }) => {
      if (request.functionName === 'position') return [0n, 100n, 1_000n];
      if (request.functionName === 'idToMarketParams') return [address, otherAddress, address, address, (WAD * 9n) / 10n];
      if (request.functionName === 'market') return [0n, 0n, 1_000n, 100n, 0n, 0n];
      return 1_000_000_000_000_000_000_000_000_000_000_000_000n;
    }
  };
  const opportunities: unknown[] = [];
  const diagnostics: unknown[] = [];
  await (scanner as unknown as { scanMorpho: (from: bigint, to: bigint, out: unknown[], diagnostics: unknown[]) => Promise<void> }).scanMorpho(1n, 12n, opportunities, diagnostics);
  assert.equal((opportunities[0] as { status: string }).status, 'actionable');
  assert.deepEqual(diagnostics, []);
});

test('EDGE-08 discovers allowlisted V2 and V3 factory pools without making them broadcastable', async () => {
  const config = scannerConfig();
  config.assetAllowlist = [address];
  config.factories = [{ family: 'uniswap-v2', factory: address }, { family: 'uniswap-v3', factory: otherAddress }];
  const scanner = new ArbitrumScanner(config);
  (scanner as unknown as { client: unknown }).client = {
    getLogs: async (request: { address: string }) => request.address === address
      ? [{ args: { token0: address, token1: otherAddress, pair: otherAddress }, blockNumber: 20n }]
      : [{ args: { token0: address, token1: otherAddress, fee: 500, tickSpacing: 10, pool: address }, blockNumber: 21n }]
  };
  const opportunities: unknown[] = [];
  await (scanner as unknown as { scanFactories: (from: bigint, to: bigint, out: unknown[], diagnostics: unknown[]) => Promise<void> }).scanFactories(1n, 21n, opportunities, []);
  assert.equal(opportunities.length, 2);
  assert.deepEqual((opportunities as Array<{ candidate: { broadcastEligible: boolean } }>).map((item) => item.candidate.broadcastEligible), [false, false]);
});

test('keeps newly discovered non-bluechip pools for analysis and marks denylisted assets rejected', async () => {
  const config = scannerConfig();
  config.factories = [{ family: 'uniswap-v2', factory: address }];
  config.assetRiskPolicy = { denylist: [otherAddress], requireSimulation: true };
  const scanner = new ArbitrumScanner(config);
  (scanner as unknown as { client: unknown }).client = {
    getLogs: async () => [{ args: { token0: address, token1: otherAddress, pair: otherAddress }, blockNumber: 20n }]
  };
  const opportunities: unknown[] = [];
  await (scanner as unknown as { scanFactories: (from: bigint, to: bigint, out: unknown[], diagnostics: unknown[]) => Promise<void> }).scanFactories(1n, 21n, opportunities, []);
  assert.equal(opportunities.length, 1);
  assert.deepEqual((opportunities[0] as { candidate: { admission: string; admissionReasons: string[] } }).candidate, {
    protocol: 'uniswap-v2', factory: address, pool: otherAddress, token0: address, token1: otherAddress,
    admission: 'rejected', admissionReasons: ['TOKEN_DENYLISTED'], broadcastEligible: false
  });
});
