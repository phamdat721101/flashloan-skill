import assert from 'node:assert/strict';
import test from 'node:test';
import { bcs } from '@mysten/sui/bcs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { normalizeSuiAddress, normalizeStructTag, toBase58 } from '@mysten/sui/utils';
import { SuiLiquidityExecutionAdapter, type SuiExecutionConfig } from '../liquidity/sui-execution.js';
import { digest } from '../liquidity/state.js';
import type { RouteCandidate } from '../liquidity/runtime.js';

const address = (value: string) => normalizeSuiAddress(value);
const hash = (value: number) => toBase58(new Uint8Array(32).fill(value));
const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(5));
const pkg = address('0xa'), guard = address('0xb'), pool = address('0x9'), gasId = address('0x99');
const cap = { objectId: address('0x7'), version: '1', digest: hash(7) };
const pause = { objectId: address('0x8'), version: '1', digest: hash(8) };
const gas = { objectId: gasId, version: '1', digest: hash(99) };
const SUI = normalizeStructTag('0x2::sui::SUI');
const routeHash = digest('independent-route-intent');
const eventType = `${address('0xc')}::terminal_profit_guard::ProfitSwept<${SUI}>`;
const sweepBcs = bcs.struct('ProfitSwept', { amount: bcs.u64(), treasury: bcs.Address, operator: bcs.Address, route_hash: bcs.vector(bcs.u8()) });

async function fixture() {
  const tx = new Transaction(); tx.setSender(signer.toSuiAddress()); tx.setGasOwner(signer.toSuiAddress());
  tx.setGasBudget(50000n); tx.setGasPrice(1n); tx.setGasPayment([gas]);
  const shared = tx.sharedObjectRef({ objectId: pool, initialSharedVersion: '1', mutable: true });
  const [coin, receipt] = tx.moveCall({ target: `${pkg}::pool::borrow`, typeArguments: [SUI], arguments: [shared, tx.pure.u64(1000000n)] });
  const [debt] = tx.splitCoins(coin, [tx.pure.u64(1000000n)]);
  tx.moveCall({ target: `${pkg}::pool::repay`, typeArguments: [SUI], arguments: [shared, debt, receipt] });
  tx.moveCall({ target: `${guard}::terminal_profit_guard::assert_min_profit_and_transfer_with_pause`, typeArguments: [SUI], arguments: [tx.objectRef(cap), tx.objectRef(pause), coin, tx.pure.u64(100000n), tx.pure.vector('u8', [...Buffer.from(routeHash, 'hex')])] });
  const bytes = await tx.build();
  const candidate: RouteCandidate = { identity: { chain: 'sui', network: 'mainnet', height: '1', checkpointDigest: hash(1) }, stateDigest: digest('state'), poolIds: ['sui:mainnet:pool'], adapterId: 'sui-local-crypto-fixture', adapterRevision: 'test-only', payloadDigest: digest(Buffer.from(bytes).toString('base64')), borrowAmount: '1000000', profitAsset: `sui:mainnet:${SUI}`, minProfit: '10000', maxGasCost: '50000', expiresAtMs: Date.now() + 60000 };
  const config: SuiExecutionConfig = { rpcUrl: 'http://127.0.0.1', network: 'mainnet', chainIdentifier: hash(4), admission: { chain: 'sui', network: 'mainnet', revision: 'test-only', expiresAtMs: Date.now() + 60000, evidence: { schema: 'fixture', math: 'fixture', simulation: 'fixture', canary: 'fixture-not-live' } }, packageDigests: { [pkg]: hash(10), [guard]: hash(11) }, allowedMoveCalls: [`${pkg}::pool::borrow`, `${pkg}::pool::repay`, `${guard}::terminal_profit_guard::assert_min_profit_and_transfer_with_pause`], requiredStateObjectIds: [pool], allowedOwnedInputIds: [cap.objectId, pause.objectId], guardPackage: guard, guardEventType: eventType, treasury: signer.toSuiAddress(), borrowTarget: `${pkg}::pool::borrow`, repayTarget: `${pkg}::pool::repay`, borrowAmountArgument: 1, receiptReturnIndex: 1, repayReceiptArgument: 2 };
  const payload = { candidate, transactionBytes: bytes, stateRefs: [{ objectId: pool, version: '7', digest: hash(9) }], routeHash };
  const controls = { sends: 0, gasDrift: false, mockedGas: false, eventMismatch: false, abortLastPin: null as AbortController | null };
  const transaction = () => ({ digest: TransactionDataBuilder.getDigestFromBytes(bytes), checkpoint: '2', status: { success: true, error: null }, effects: { transactionDigest: TransactionDataBuilder.getDigestFromBytes(bytes), status: { success: true }, gasUsed: { computationCost: '1000', storageCost: '10', storageRebate: '5', nonRefundableStorageFee: '0' } }, events: [{ eventType, bcs: sweepBcs.serialize({ amount: '100000', treasury: signer.toSuiAddress(), operator: signer.toSuiAddress(), route_hash: [...Buffer.from(controls.eventMismatch ? digest('wrong') : routeHash, 'hex')] }).toBytes() }] });
  const client = {
    ledgerService: {
      getServiceInfo: () => ({ response: Promise.resolve({ chainId: hash(4) }) }),
      getCheckpoint: () => ({ response: Promise.resolve({ checkpoint: { digest: hash(1) } }) }),
      getObject: ({ objectId }: { objectId: string }) => {
        if (objectId === guard && controls.abortLastPin) controls.abortLastPin.abort();
        return { response: Promise.resolve({ object: objectId === pool ? { version: 7n, digest: hash(9) } : objectId === gasId ? { version: controls.gasDrift ? 2n : 1n, digest: hash(99) } : { digest: config.packageDigests[objectId] } }) };
      }
    },
    simulateTransaction: async () => ({ $kind: 'Transaction', Transaction: transaction(), gasPaymentMocked: controls.mockedGas }),
    executeTransaction: async () => { controls.sends++; return { $kind: 'Transaction', Transaction: transaction() }; },
    waitForTransaction: async () => ({ $kind: 'Transaction', Transaction: transaction() })
  } as unknown as SuiGrpcClient;
  return { candidate, payload, config, controls, client, adapter: new SuiLiquidityExecutionAdapter(config, signer, [payload], client) };
}

test('Sui adapter verifies real BCS transaction signatures and checkpointed guard events without rebuilding bytes', async () => {
  const { adapter, candidate, controls, config, payload, client } = await fixture();
  const proof = await adapter.simulate(candidate);
  assert.equal(proof.profitAfterDebt, '100000'); assert.equal(proof.conservativeGasCostInProfitAsset, '1005');
  const resource = await adapter.resource(candidate), signed = await adapter.sign(candidate, resource);
  assert.equal(signed.transactionId, TransactionDataBuilder.getDigestFromBytes(payload.transactionBytes));
  assert.equal(await adapter.submit(signed.signedBytes), signed.transactionId); assert.equal(controls.sends, 1);
  const receipt = await adapter.receipt(signed.transactionId);
  assert.equal(receipt?.profitTransferProven, true); assert.equal(receipt?.profitAfterDebt, '100000');
  const recovered = new SuiLiquidityExecutionAdapter(config, signer, [payload], client);
  assert.equal((await recovered.receipt(signed.transactionId))?.profitAfterDebt, '100000');
});
test('Sui mocked gas, changed gas versions and mismatched treasury guard intent fail closed', async () => {
  const { adapter, candidate, controls } = await fixture();
  controls.mockedGas = true; await assert.rejects(adapter.simulate(candidate), /SUI_EXECUTION_FAILED/);
  controls.mockedGas = false; controls.eventMismatch = true; await assert.rejects(adapter.simulate(candidate), /PNL_UNKNOWN/);
  controls.eventMismatch = false;
  const resource = await adapter.resource(candidate); controls.gasDrift = true;
  await assert.rejects(adapter.sign(candidate, resource), /STATE_CHANGED/);
  assert.equal(controls.sends, 0);
});
test('Sui payload substitution and unadmitted Move targets cannot reach signing', async () => {
  const { candidate, payload, config, client } = await fixture();
  assert.throws(() => new SuiLiquidityExecutionAdapter(config, signer, [{ ...payload, transactionBytes: new Uint8Array([1]) }], client), /PAYLOAD_BINDING_MISMATCH/);
  const adapter = new SuiLiquidityExecutionAdapter({ ...config, allowedMoveCalls: [] }, signer, [payload], client);
  await assert.rejects(adapter.sign(candidate, 'not-a-gas-lease'), /UNADMITTED_MOVE_CALL/);
});
test('cancellation during the last package-pin response cannot execute after halt', async () => {
  const { adapter, candidate, controls } = await fixture();
  const signed = await adapter.sign(candidate, await adapter.resource(candidate));
  const controller = new AbortController(); controls.abortLastPin = controller;
  await assert.rejects(adapter.submit(signed.signedBytes, controller.signal), /EXECUTION_CANCELLED/);
  assert.equal(controls.sends, 0);
});
