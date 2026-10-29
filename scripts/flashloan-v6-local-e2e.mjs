// EDGE-05 (flashloan v6): real localhost Anvil receipts reconciled by reconcileReceipt.
// Proves prefund cancellation inside the operator account set, no-swap classification (net = -gas),
// lost-response recovery by nonce without a resend, and UNKNOWN on an unvalued asset. Localhost only;
// published Anvil development key; no remote RPC and no mainnet send.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseEther } from 'viem';
import { startAeroNode, aeroTestClients } from './aero-e2e-utils.mjs';
import { buildLedger, reconcileReceipt } from '../dist/evidence/economics.js';

const chain = 'eip155:8453', borrow = `${chain}/erc20:${'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'}`, h = (s) => createHash('sha256').update(s).digest('hex');
const commit = execSync('git rev-parse HEAD').toString().trim(), diff = h(execSync('git diff').toString());
const node = await startAeroNode({ port: 19557 });
try {
  const { account, client, wallet } = aeroTestClients(node.rpc);
  const operator = account.address.toLowerCase(), executor = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  const accounts = [{ role: 'operator', address: operator }, { role: 'executor', address: executor }];
  const balances = async (blockNumber) => Object.fromEntries(await Promise.all(accounts.map(async a => [a.address, { native: (await client.getBalance({ address: a.address, blockNumber })).toString(), [borrow]: '0' }])));
  const asset = { namespace: 'eip155', networkId: '8453', assetId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
  // Borrow-and-repay-only round: proceeds equal principal + fee, so surplus is zero and net must be exactly -gas.
  const simulated = buildLedger({ runId: 'v6-e2e', schemaVersion: '5.2', asset, principalRaw: '1000', deployedRaw: '1000', unusedPrincipalRaw: '0', swapProceedsRaw: '1005', flashFeeRaw: '5', networkCostRaw: '0', otherExternalCostsRaw: '0', operatorPrefundRaw: '0', executorOpeningBalanceRaw: '0', evidence: [] });
  const header = (r, nonce) => ({ chain_id: chain, round_id: 'v6-e2e', candidate_hash: `sha256:${h('candidate')}`, policy_hash: `sha256:${h('policy')}`, block_hash: r.blockHash,
    executor: { address: executor, runtime_hash: `0x${h('runtime')}`, abi_hash: `sha256:${h('abi')}` }, accounts,
    transaction: { sender: operator, calldata_hash: `0x${h('calldata')}`, nonce: String(nonce), tx_hash: r.transactionHash },
    receipt: { tx_hash: r.transactionHash, block_hash: r.blockHash, status: r.status === 'success' ? 'success' : 'revert', finality: 'finalized', gas_used: r.gasUsed.toString(), effective_gas_price: r.effectiveGasPrice.toString(), l1_fee_raw: null },
    native_result_ref: null });
  const valuations = { native: { price: { numerator: '1', denominator: '1' }, ref: { kind: 'valuation', content_hash: `sha256:${h('price')}`, captured_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), trace_id: 'e2e' } } };

  // 1. Prefund inside S: operator -> executor. The transfer cancels; only gas remains.
  const before = await client.getBlockNumber({ cacheTime: 0 }), nonce = await client.getTransactionCount({ address: operator });
  const prefund = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: executor, value: parseEther('1') }) });
  const reconciled = reconcileReceipt({ header: header(prefund, nonce), fixture: false, borrowAssetKey: borrow, simulated, actualSwapProceedsRaw: '1005', repaymentProven: true,
    opening: await balances(before), closing: await balances(prefund.blockNumber), prefundByAsset: { native: parseEther('1').toString() }, valuations, minFinality: 'safe' });
  const gas = prefund.gasUsed * prefund.effectiveGasPrice;
  assert.equal(reconciled.reconciliation, 'RECONCILED', JSON.stringify(reconciled.reasons));
  assert.equal(reconciled.net_by_asset.native, (-gas).toString(), 'prefund must cancel; only gas leaves the set');
  assert.equal(reconciled.realized_net_raw, (-gas).toString(), 'no-swap round nets exactly -gas');

  // 2. Lost submission response: recover the attempt by (sender, nonce); never resend.
  const lostNonce = await client.getTransactionCount({ address: operator }), lostBefore = await client.getBlockNumber({ cacheTime: 0 });
  await wallet.sendTransaction({ to: executor, value: 1n, nonce: lostNonce }); // response deliberately discarded
  await client.request({ method: 'evm_mine', params: [] }).catch(() => {});
  assert.equal(await client.getTransactionCount({ address: operator }), lostNonce + 1, 'nonce consumed exactly once');
  let recovered;
  for (let n = lostBefore + 1n; !recovered && n <= await client.getBlockNumber({ cacheTime: 0 }); n++) {
    const block = await client.getBlock({ blockNumber: n, includeTransactions: true });
    recovered = block.transactions.find(t => t.from.toLowerCase() === operator && Number(t.nonce) === Number(lostNonce));
  }
  assert.ok(recovered, 'attempt recovered by nonce');
  const lostReceipt = await client.getTransactionReceipt({ hash: recovered.hash });
  const lost = reconcileReceipt({ header: header(lostReceipt, lostNonce), fixture: false, borrowAssetKey: borrow, simulated, actualSwapProceedsRaw: '1005', repaymentProven: true,
    opening: await balances(lostBefore), closing: await balances(lostReceipt.blockNumber), prefundByAsset: {}, valuations, minFinality: 'safe' });
  assert.equal(lost.reconciliation, 'RECONCILED');

  // 3. Unvalued third asset in the closing set (synthetic injection, labeled) -> UNKNOWN, which halts the lane.
  const odd = `${chain}/erc20:0x${'6'.repeat(40)}`, closing = await balances(prefund.blockNumber); closing[executor][odd] = '1';
  const unknown = reconcileReceipt({ header: header(prefund, nonce), fixture: false, borrowAssetKey: borrow, simulated, actualSwapProceedsRaw: '1005', repaymentProven: true,
    opening: await balances(before), closing, prefundByAsset: {}, valuations, minFinality: 'safe' });
  assert.equal(unknown.reconciliation, 'UNKNOWN');

  // 4. Fixture evidence can never stand in for a receipt.
  assert.throws(() => reconcileReceipt({ header: header(prefund, nonce), fixture: true, borrowAssetKey: borrow, simulated, actualSwapProceedsRaw: '1005', repaymentProven: true, opening: {}, closing: {}, prefundByAsset: {}, valuations, minFinality: 'safe' }), /RECEIPT_EVIDENCE_INVALID/);

  const result = { pass: true, commit, diff_sha256: diff, fixture: 'anvil-localhost', receipts: [prefund.transactionHash, lostReceipt.transactionHash], gas_wei: gas.toString(), synthetic: ['unvalued-asset-injection', 'borrow-asset-balances-zero'] };
  await mkdir('.nim/e2e', { recursive: true }); await writeFile('.nim/e2e/flashloan-v6-local.json', JSON.stringify(result, null, 2));
  console.log(`FLASHLOAN_V6_EDGE_05 ${JSON.stringify(result)}`);
} finally { node.close(); }
