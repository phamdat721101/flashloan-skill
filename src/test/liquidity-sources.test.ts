import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { encodeFunctionResult, keccak256, parseAbi } from 'viem';
import { readArbitrumHead, readArbitrumV2Snapshot, readArbitrumAnalyticsSnapshot, readSuiCheckpoint, readSuiHead, SOURCE_CAPABILITIES } from '../liquidity/sources.js';
import { digest } from '../liquidity/state.js';
import { projectPool } from '../liquidity/projection.js';

test('source catalogue exposes only implemented connectors as implemented', () => {
  assert.deepEqual(SOURCE_CAPABILITIES.filter(s => s.implemented).map(s => s.id), ['arbitrum-v2-rpc', 'sui-checkpoint-grpc']);
  assert.equal(SOURCE_CAPABILITIES.find(s => s.id === 'arbitrum-fast-feed')!.implemented, false);
});

test('Arbitrum capture pins every read and rejects a reorg or changed pool code', async () => {
  const pool = '0x0000000000000000000000000000000000000001';
  const token0 = '0x0000000000000000000000000000000000000002';
  const token1 = '0x0000000000000000000000000000000000000003';
  const abi = parseAbi(['function token0() view returns(address)', 'function token1() view returns(address)', 'function getReserves() view returns(uint112,uint112,uint32)', 'function decimals() view returns(uint8)']);
  let blockReads = 0, reorg = false, changedCode = false;
  const pinnedReads: string[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const rpc = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
    let result: unknown;
    if (rpc.method === 'eth_chainId') result = '0xa4b1';
    else if (rpc.method === 'eth_blockNumber') result = '0x1';
    else if (rpc.method === 'eth_getBlockByNumber') {
      blockReads++;
      result = { number: '0x1', hash: `0x${reorg && blockReads > 1 ? 'b'.repeat(64) : 'a'.repeat(64)}`, parentHash: `0x${'0'.repeat(64)}`, transactions: [] };
    } else if (rpc.method === 'eth_getCode') {
      pinnedReads.push(String(rpc.params[1])); result = changedCode ? '0x6001' : '0x6000';
    } else if (rpc.method === 'eth_call') {
      pinnedReads.push(String(rpc.params[1]));
      const data = (rpc.params[0] as { data: string }).data;
      result = data === '0x0dfe1681' ? encodeFunctionResult({ abi, functionName: 'token0', result: token0 })
        : data === '0xd21220a7' ? encodeFunctionResult({ abi, functionName: 'token1', result: token1 })
        : data === '0x313ce567' ? encodeFunctionResult({ abi,functionName: 'decimals',result: 6 })
        : encodeFunctionResult({ abi, functionName: 'getReserves', result: [100n, 200n, 1] });
    } else { response.writeHead(400); response.end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`, pools = [{ address: pool, expectedCodeHash: keccak256('0x6000') }] as const;
    const captured = await readArbitrumV2Snapshot(url, 'local-rpc-fixture', pools, '1');
    assert.equal(captured.pools[0].reserve1, '200');
    assert.deepEqual(pinnedReads, ['0x1', '0x1', '0x1', '0x1']);
    const analyticsConfig = [{ ...pools[0],protocol: 'uniswap-v2' as const,adapterRevision: 'fixture-v2-code-pin',feeNumerator: '997',feeDenominator: '1000' }];
    const analytics = await readArbitrumAnalyticsSnapshot(url,'local-rpc-fixture','1',analyticsConfig);
    assert.equal(analytics.snapshot.stateDigest,digest(analytics.pools));
    assert.equal(analytics.pools[0].decimals0,6); assert.equal(analytics.pools[0].decimals1,6);
    assert.equal(projectPool(analytics.pools[0],{ schemaVersion: '4.0',snapshotDigest: digest(analytics.pools[0]),operationId: 'fixture-swap',operationClass: 'hypothetical',tokenIn: token0,amountIn: '5' }).amountOut,'9');
    await assert.rejects(readArbitrumAnalyticsSnapshot(url,'local-rpc-fixture','1',[analyticsConfig[0],analyticsConfig[0]]),/DUPLICATE_ANALYTICS_POOL/);
    assert.ok(pinnedReads.every(height => height === '0x1'));
    assert.equal(await readArbitrumHead(url, '42161'), '1');
    await assert.rejects(readArbitrumHead(url, '421614'), /SOURCE_CHAIN_MISMATCH/);
    const directory = await mkdtemp(join(tmpdir(), 'liquid-source-follow-'));
    try {
      const path = join(directory, 'config.json');
      await writeFile(path, JSON.stringify({ schemaVersion: '3.0', rpcUrl: url, sourceId: 'local-rpc-fixture', network: '42161', pools, journalPath: join(directory, 'source.jsonl'), start: '1', maxFrames: 1, maxGap: 1, pollIntervalMs: 100, maxIdlePolls: 1 }));
      const result = await promisify(execFile)(process.execPath, ['dist/liquidity/cli.js', 'follow-arbitrum', path]);
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(records[0].status, 'source-frame-committed');
      assert.deepEqual(records[1], { schemaVersion: '3.0', committed: 1, lastHeight: '1', status: 'frame-limit' });
    } finally { await rm(directory, { recursive: true, force: true }); }
    reorg = true; blockReads = 0;
    await assert.rejects(() => readArbitrumV2Snapshot(url, 'local-rpc-fixture', pools, '2'), /BLOCK_REORG/);
    blockReads = 0;
    await assert.rejects(() => readArbitrumAnalyticsSnapshot(url,'local-rpc-fixture','2',analyticsConfig),/BLOCK_REORG/);
    reorg = false; changedCode = true; blockReads = 0;
    await assert.rejects(() => readArbitrumV2Snapshot(url, 'local-rpc-fixture', pools, '2'), /POOL_CODE_CHANGED/);
    await assert.rejects(() => readArbitrumAnalyticsSnapshot(url,'local-rpc-fixture','2',analyticsConfig),/POOL_CODE_CHANGED/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test('invalid source inputs fail before network access or signing', async () => {
  await assert.rejects(readArbitrumHead('https://example.invalid', '49986'), /UNSUPPORTED_NETWORK/);
  await assert.rejects(readSuiHead('https://example.invalid', 'mainnet', ''), /CHAIN_IDENTIFIER_REQUIRED/);
  await assert.rejects(() => readArbitrumV2Snapshot('https://example.invalid', 'source', [], '1'), /INVALID_SOURCE_POOLS/);
  await assert.rejects(() => readArbitrumV2Snapshot('https://example.invalid', 'source', [], '1.5'), /INVALID_DECIMAL/);
  await assert.rejects(() => readSuiCheckpoint('http://remote.invalid', 'mainnet', '1', '1'.repeat(32)), /INSECURE/);
  await assert.rejects(() => readSuiCheckpoint('https://example.invalid', 'wrong' as 'mainnet', '1', '1'.repeat(32)), /UNSUPPORTED/);
  await assert.rejects(() => readSuiCheckpoint('https://example.invalid', 'mainnet', '1', ''), /CHAIN_IDENTIFIER_REQUIRED/);
  await assert.rejects(() => readSuiCheckpoint('https://example.invalid', 'mainnet', '1', '35834a8a'), /CHAIN_IDENTIFIER_REQUIRED/);
  await assert.rejects(() => readArbitrumV2Snapshot('https://example.invalid', 'source', [{ address: 'invalid', expectedCodeHash: 'invalid' } as never], '1'), /INVALID_POOL_PIN/);
});

test('source CLI enforces v3 and rejects unknown configuration fields before network access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'liquid-source-config-'));
  try {
    const path = join(directory, 'source.json');
    const cases = [
      [{ rpcUrl: 'https://example.invalid' }, 'INVALID_SOURCE_CONFIG_VERSION'],
      [{ schemaVersion: '3.0', rpcUrl: 'https://example.invalid', network: 'mainnet', checkpoint: '1', expectedChainIdentifier: '1'.repeat(43), secret: 'rejected' }, 'INVALID_SOURCE_CONFIG_FIELDS'],
      [{ schemaVersion: '3.0', rpcUrl: 'https://example.invalid', network: 'mainnet', checkpoint: '1', expectedChainIdentifier: '35834a8a' }, 'CHAIN_IDENTIFIER_REQUIRED']
    ] as const;
    for (const [config, expected] of cases) {
      await writeFile(path, JSON.stringify(config));
      await assert.rejects(promisify(execFile)(process.execPath, ['dist/liquidity/cli.js', 'checkpoint-sui', path]), error => {
        const failure = error as Error & { code: number; stderr: string; stdout: string };
        assert.equal(failure.code, 1); assert.equal(failure.stderr.trim(), expected); assert.equal(failure.stdout, ''); return true;
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
