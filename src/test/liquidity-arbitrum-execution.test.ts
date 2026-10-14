import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeAbiParameters as encode, encodeEventTopics, encodeFunctionResult, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ArbitrumLiquidityExecutionAdapter, type ArbitrumExecutionConfig } from '../liquidity/arbitrum-execution.js';
import { encodeLenderArbitrage, MULTI_LENDER_ROUTE_ABI } from '../liquidity/arbitrum.js';
import { digest, SnapshotStore } from '../liquidity/state.js';
import { AttemptJournal } from '../liquidity/journal.js';
import { LiquidityRuntime, type RouteCandidate } from '../liquidity/runtime.js';

const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' as Address;
const other = `0x${'2'.repeat(40)}` as Address, executor = `0x${'3'.repeat(40)}` as Address;
const root = `0x${'4'.repeat(40)}` as Address, lender = `0x${'5'.repeat(40)}` as Address;
const blockHash = `0x${'a'.repeat(64)}` as Hex;
const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const abi = parseAbi(['function owner() view returns(address)', 'event MultiVenueArbitrageExecuted(bytes32 indexed routeHash,address indexed asset,uint256 flashAmount,uint256 netProfit,uint256 legs)']);

async function fixture(run: (adapter: ArbitrumLiquidityExecutionAdapter, candidate: RouteCandidate, config: ArbitrumExecutionConfig, controls: { nonce: number; drift: boolean; sends: number; raw: Hex | null; abortRelay: AbortController | null; chainReads: number }) => Promise<void>) {
  const time = Date.now(), controls = { nonce: 0, drift: false, sends: 0, raw: null as Hex | null, abortRelay: null as AbortController | null, chainReads: 0 };
  const calldata = encodeLenderArbitrage({ kind: 'morpho-blue', lender, flashAsset: WETH, flashAmount: '1000000', minProfit: '110000', deadline: String(Math.floor((time + 50000) / 1000)), legs: [
    { venueVersion: 3, root, pool: executor, tokenIn: WETH, tokenOut: other, minAmountOut: '1100000', fee: 500, sqrtPriceLimitX96: '1', tickSpacing: 0, hooks: zeroAddress, hookData: '0x' },
    { venueVersion: 3, root, pool: executor, tokenIn: other, tokenOut: WETH, minAmountOut: '1110000', fee: 500, sqrtPriceLimitX96: '1', tickSpacing: 0, hooks: zeroAddress, hookData: '0x' }
  ] });
  const route = decodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI, data: calldata }).args[0];
  const routeHash = keccak256(encodeAbiParameters(MULTI_LENDER_ROUTE_ABI[0].inputs, [route]));
  const candidate: RouteCandidate = { identity: { chain: 'arbitrum', network: '42161', height: '1', blockHash }, stateDigest: digest('state'), poolIds: ['arbitrum:42161:pool'], adapterId: 'real-adapter-local-rpc', adapterRevision: 'test-pinned-revision', payloadDigest: digest(calldata), borrowAmount: '1000000', profitAsset: `arbitrum:42161:${WETH}`, minProfit: '10000', maxGasCost: '100000', expiresAtMs: time + 60000 };
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const rpc = JSON.parse(raw); let result: unknown;
    if (rpc.method === 'eth_chainId') {
      if (controls.abortRelay && ++controls.chainReads === 2) controls.abortRelay.abort();
      result = '0xa4b1';
    }
    else if (rpc.method === 'eth_getBlockByNumber') result = { number: '0x1', hash: blockHash, parentHash: `0x${'0'.repeat(64)}`, timestamp: `0x${Math.floor(time / 1000).toString(16)}`, baseFeePerGas: '0x1', transactions: [] };
    else if (rpc.method === 'eth_getCode') result = controls.drift ? '0x6001' : '0x6000';
    else if (rpc.method === 'eth_call') result = rpc.params[0].data === '0x8da5cb5b' ? encodeFunctionResult({ abi, functionName: 'owner', result: account.address }) : '0x';
    else if (rpc.method === 'eth_estimateGas') result = '0x5208';
    else if (rpc.method === 'eth_maxPriorityFeePerGas' || rpc.method === 'eth_gasPrice') result = '0x1';
    else if (rpc.method === 'eth_getTransactionCount') result = `0x${controls.nonce.toString(16)}`;
    else if (rpc.method === 'eth_blockNumber') result = '0x1';
    else if (rpc.method === 'eth_sendRawTransaction') { controls.raw = rpc.params[0]; controls.sends++; result = keccak256(controls.raw!); }
    else if (rpc.method === 'eth_getTransactionByHash') result = { hash: rpc.params[0], chainId: '0xa4b1', from: account.address, to: executor, input: calldata, value: '0x0', nonce: '0x0', blockHash, blockNumber: '0x1', transactionIndex: '0x0', type: '0x2', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', v: '0x0', r: '0x1', s: '0x1' };
    else if (rpc.method === 'eth_getTransactionReceipt') {
      const hash = controls.raw ? keccak256(controls.raw) : rpc.params[0];
      result = { transactionHash: hash, transactionIndex: '0x0', blockHash, blockNumber: '0x1', from: account.address, to: executor, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x2', contractAddress: null, logsBloom: `0x${'0'.repeat(512)}`, status: '0x1', type: '0x2', logs: [{ address: executor, blockHash, blockNumber: '0x1', transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0', removed: false, topics: encodeEventTopics({ abi, eventName: 'MultiVenueArbitrageExecuted', args: { routeHash, asset: WETH } }), data: encode([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1000000n, 110000n, 2n]) }] };
    } else { response.writeHead(400); response.end(rpc.method); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const config: ArbitrumExecutionConfig = { rpcUrl: url, submissionUrl: url, executor, executorCodeHash: keccak256('0x6000'), codePins: Object.fromEntries([executor, root, lender].map(address => [address.toLowerCase(), keccak256('0x6000')])), admission: { chain: 'arbitrum', network: '42161', revision: candidate.adapterRevision, expiresAtMs: time + 60000, evidence: { schema: 'fixture', math: 'fixture', simulation: 'fixture', canary: 'local-rpc-not-mainnet' } }, confirmations: 1 };
    await run(new ArbitrumLiquidityExecutionAdapter(config, account, [{ candidate, calldata }]), candidate, config, controls);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('real Arbitrum adapter signs final EIP-1559 bytes locally and reconciles route-bound receipt custody', async () => {
  await fixture(async (adapter, candidate, config, controls) => {
    const directory = await mkdtemp(join(tmpdir(), 'liquidity-real-signing-'));
    try {
      const snapshots = new SnapshotStore(60000);
      snapshots.apply({ schemaVersion: '3.0', identity: candidate.identity, sourceId: 'local-rpc', cursor: '1', observedAtMs: Date.now(), complete: true, poolIds: candidate.poolIds, stateDigest: candidate.stateDigest });
      const journal = new AttemptJournal(join(directory, 'attempts.jsonl'));
      const decisions = await new LiquidityRuntime(snapshots, journal, new Map([[candidate.adapterId, adapter]])).run([candidate], { mode: 'auto', concurrency: 1, maxCandidates: 1, maxDailyLoss: '1000000', minProfit: '10000', budgetAssets: { 'arbitrum:42161': candidate.profitAsset } });
      assert.ok(decisions.some(decision => decision.status === 'reconciled'), JSON.stringify(decisions));
      assert.equal(controls.sends, 1); assert.ok(controls.raw);
      const parsed = parseTransaction(controls.raw);
      assert.equal(parsed.chainId, 42161); assert.equal(parsed.nonce, 0); assert.equal(parsed.to?.toLowerCase(), executor.toLowerCase());
      assert.ok(controls.raw.startsWith('0x02'));
      assert.equal((await recoverTransactionAddress({ serializedTransaction: controls.raw as `0x02${string}` })).toLowerCase(), account.address.toLowerCase());
      assert.equal((await journal.latest())[0].transactionId, keccak256(controls.raw));
      assert.equal((await journal.latest())[0].loss, '0');
      const receipt = await adapter.receipt(keccak256(controls.raw));
      assert.equal(receipt?.profitTransferProven, false); assert.equal(receipt?.profitCustodyProven, true);
      const recovered = new ArbitrumLiquidityExecutionAdapter(config, account, [{ candidate, calldata: parsed.data! }]);
      assert.equal((await recovered.receipt(keccak256(controls.raw)))?.profitAfterDebt, '110000');
      assert.equal(controls.sends, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
test('revision drift and pending nonce changes reject before submission', async () => {
  await fixture(async (adapter, candidate, _, controls) => {
    const resource = await adapter.resource(candidate);
    controls.nonce = 1;
    await assert.rejects(adapter.sign(candidate, resource), /NONCE_CHANGED/);
    controls.drift = true;
    await assert.rejects(adapter.simulate(candidate), /EXECUTION_REVISION_CHANGED/);
    assert.equal(controls.sends, 0);
  });
});
test('cancellation during the relay chain-ID response cannot broadcast after halt', async () => {
  await fixture(async (adapter, candidate, _, controls) => {
    const signed = await adapter.sign(candidate, await adapter.resource(candidate));
    const controller = new AbortController(); controls.abortRelay = controller;
    await assert.rejects(adapter.submit(signed.signedBytes, controller.signal), /EXECUTION_CANCELLED/);
    assert.equal(controller.signal.aborted, true); assert.equal(controls.chainReads, 2); assert.equal(controls.sends, 0);
  });
});
