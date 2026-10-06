import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadScannerConfig } from '../scan/config.js';

const address = '0x1111111111111111111111111111111111111111';

async function configFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flashloan-agent-scan-'));
  const path = join(directory, 'scanner.json');
  await writeFile(path, JSON.stringify(value));
  return path;
}

test('EDGE-01 loads a secret-free Arbitrum scanner configuration with conservative defaults', async () => {
  const config = await loadScannerConfig(await configFile({
    chainId: 42161,
    rpcUrl: 'https://rpc.example',
    startBlock: '1',
    protocols: { aaveV3: { pool: address }, balancerV2: { vault: address } }
  }));
  assert.equal(config.finalityBlocks, 20);
  assert.equal(config.logChunkSize, 2_000);
  assert.equal(config.protocols.aaveV3?.pool, address);
  assert.equal(config.protocols.balancerV2?.vault, address);
  assert.equal(JSON.stringify(config).includes('operatorPrivateKey'), false);
});

test('rejects a non-Arbitrum config and malformed protocol address before RPC use', async () => {
  const wrongChain = await configFile({ chainId: 1, rpcUrl: 'https://rpc.example', startBlock: '1', protocols: {} });
  const badAddress = await configFile({ chainId: 42161, rpcUrl: 'https://rpc.example', startBlock: '1', protocols: { uniswapV4: { poolManager: 'bad' } } });
  await assert.rejects(() => loadScannerConfig(wrongChain), /Arbitrum/);
  await assert.rejects(() => loadScannerConfig(badAddress), /20-byte/);
});

test('loads only named V2 and V3 factories for scalable pool discovery', async () => {
  const config = await loadScannerConfig(await configFile({
    chainId: 42161,
    rpcUrl: 'https://rpc.example',
    startBlock: '1',
    factories: [{ family: 'uniswap-v2', factory: address }, { family: 'uniswap-v3', factory: '0x2222222222222222222222222222222222222222' }],
    protocols: {}
  }));
  assert.deepEqual(config.factories?.map((factory) => factory.family), ['uniswap-v2', 'uniswap-v3']);
});
