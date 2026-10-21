import assert from 'node:assert/strict';
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

import { evmProfile } from '../evm-chains.js';
const other = `0x${'2'.repeat(40)}` as Address, executor = `0x${'3'.repeat(40)}` as Address;
const root = `0x${'4'.repeat(40)}` as Address, lender = `0x${'5'.repeat(40)}` as Address;
const blockHash = `0x${'a'.repeat(64)}` as Hex;
const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const abi = parseAbi(['function owner() view returns(address)', 'event MultiVenueArbitrageExecuted(bytes32 indexed routeHash,address indexed asset,uint256 flashAmount,uint256 netProfit,uint256 legs)']);

export async function fixture(run: (adapter: ArbitrumLiquidityExecutionAdapter, candidate: RouteCandidate, config: ArbitrumExecutionConfig, controls: { nonce: number; drift: boolean; feedDrift: boolean; recoveryFinalized: boolean; profit: bigint; sends: number; raw: Hex | null; abortRelay: AbortController | null; chainReads: number }) => Promise<void>, chainId = 42161) {
  const profile = evmProfile(chainId), WETH = profile.wrappedNative as Address;
  const time = Date.now(), controls = { nonce: 0, drift: false, feedDrift: false, recoveryFinalized: false, profit: 110000n, sends: 0, raw: null as Hex | null, abortRelay: null as AbortController | null, chainReads: 0 };
  const calldata = encodeLenderArbitrage({ kind: 'morpho-blue', lender, flashAsset: WETH, flashAmount: '1000000', minProfit: '110000', deadline: String(Math.floor((time + 50000) / 1000)), legs: [
    { venueVersion: 3, root, pool: executor, tokenIn: WETH, tokenOut: other, minAmountOut: '1100000', fee: 500, sqrtPriceLimitX96: '1', tickSpacing: 0, hooks: zeroAddress, hookData: '0x' },
    { venueVersion: 3, root, pool: executor, tokenIn: other, tokenOut: WETH, minAmountOut: '1110000', fee: 500, sqrtPriceLimitX96: '1', tickSpacing: 0, hooks: zeroAddress, hookData: '0x' }
  ] });
  const route = decodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI, data: calldata }).args[0];
  const routeHash = keccak256(encodeAbiParameters(MULTI_LENDER_ROUTE_ABI[0].inputs, [route]));
  const candidate: RouteCandidate = { identity: { chain: profile.key, network: String(chainId) as '42161' | '8453' | '4663', height: '1', blockHash }, stateDigest: digest('state'), poolIds: [`${profile.key}:${chainId}:pool`], adapterId: 'real-adapter-local-rpc', adapterRevision: 'test-pinned-revision', payloadDigest: digest(calldata), borrowAmount: '1000000', profitAsset: `${profile.key}:${chainId}:${WETH}`, minProfit: '10000', maxGasCost: '100000', expiresAtMs: time + 60000 };
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const rpc = JSON.parse(raw); let result: unknown;
    if (rpc.method === 'eth_chainId') {
      if (controls.abortRelay && ++controls.chainReads === 2) controls.abortRelay.abort();
      result = `0x${chainId.toString(16)}`;
    }
    else if (rpc.method === 'eth_getBlockByNumber') result = { number: '0x1', hash: blockHash, parentHash: `0x${'0'.repeat(64)}`, timestamp: `0x${Math.floor(time / 1000).toString(16)}`, baseFeePerGas: '0x1', transactions: [] };
    else if (rpc.method === 'eth_getCode') result = controls.drift || (controls.feedDrift && rpc.params[0] === `0x${'6'.repeat(40)}`) ? '0x6001' : '0x6000';
    else if (rpc.method === 'eth_call' && rpc.params[0].to?.toLowerCase() === '0x420000000000000000000000000000000000000f') result = '0x' + 50n.toString(16).padStart(64,'0');
    else if (rpc.method === 'eth_call' && rpc.params[0].to?.toLowerCase() === `0x${'6'.repeat(40)}`) result = rpc.params[0].data === '0x313ce567' ? encode([{type:'uint8'}],[8]) : encode([{type:'uint80'},{type:'int256'},{type:'uint256'},{type:'uint256'},{type:'uint80'}],[1n,200000000000n,BigInt(Math.floor(time/1000)),BigInt(Math.floor(time/1000)),1n]);
    else if (rpc.method === 'eth_call') result = rpc.params[0].data === '0x8da5cb5b' ? encodeFunctionResult({ abi, functionName: 'owner', result: account.address }) : '0x';
    else if (rpc.method === 'eth_estimateGas') result = '0x5208';
    else if (rpc.method === 'eth_maxPriorityFeePerGas' || rpc.method === 'eth_gasPrice') result = '0x1';
    else if (rpc.method === 'eth_getTransactionCount') result = `0x${controls.nonce.toString(16)}`;
    else if (rpc.method === 'eth_blockNumber') result = controls.recoveryFinalized?'0x2':'0x1';
    else if (rpc.method === 'eth_sendRawTransaction') { controls.raw = rpc.params[0]; controls.sends++; result = keccak256(controls.raw!); }
    else if (rpc.method === 'eth_getTransactionByHash') result = { hash: rpc.params[0], chainId: `0x${chainId.toString(16)}`, from: account.address, to: executor, input: calldata, value: '0x0', nonce: '0x0', blockHash, blockNumber: '0x1', transactionIndex: '0x0', type: '0x2', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', v: '0x0', r: '0x1', s: '0x1' };
    else if (rpc.method === 'eth_getTransactionReceipt') {
      const hash = controls.raw ? keccak256(controls.raw) : rpc.params[0];
      result = { transactionHash: hash, transactionIndex: '0x0', blockHash, blockNumber: '0x1', from: account.address, to: executor, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x2', l1Fee: '0x32', contractAddress: null, logsBloom: `0x${'0'.repeat(512)}`, status: '0x1', type: '0x2', logs: [{ address: executor, blockHash, blockNumber: '0x1', transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0', removed: false, topics: encodeEventTopics({ abi, eventName: 'MultiVenueArbitrageExecuted', args: { routeHash, asset: WETH } }), data: encode([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1000000n, controls.profit, 2n]) }] };
    } else { response.writeHead(400); response.end(rpc.method); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const config: ArbitrumExecutionConfig = { rpcUrl: url, submissionUrl: url, executor, executorCodeHash: keccak256('0x6000'), codePins: Object.fromEntries([executor, root, lender].map(address => [address.toLowerCase(), keccak256('0x6000')])), admission: { chain: profile.key, network: String(chainId) as '42161' | '8453' | '4663', revision: candidate.adapterRevision, expiresAtMs: time + 60000, evidence: { schema: 'fixture', math: 'fixture', simulation: 'fixture', canary: 'local-rpc-not-mainnet' } }, confirmations: 1 };
    await run(new ArbitrumLiquidityExecutionAdapter(config, account, [{ candidate, calldata }]), candidate, config, controls);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}


export { account, executor, root, lender, blockHash };
