import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, zeroAddress } from 'viem';
import { toBase58 } from '@mysten/sui/utils';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { quoteAlgebraExactInput, readAlgebraLinkedSnapshot, type AlgebraLinkedState } from '../liquidity/algebra.js';
import { digest } from '../liquidity/state.js';
import { sqrtRatioAtTick } from '../liquidity/clmm.js';
import { sizeConditionalCycle, type ConditionalVenue, type SizingRequest } from '../liquidity/sizing.js';
import { reconcileNativeCheckpoints, SourceJournal, type SourceFrame } from '../liquidity/ingestion.js';
import type { StateClient } from '../state-adapters.js';

function state(tick = 0): AlgebraLinkedState {
  return { schemaVersion: '4.0',revision: 'algebra-integral-linked-v1',sqrtPriceX96: sqrtRatioAtTick(tick).toString(),tick,liquidity: '1000000',lastFee: 3000,communityFee: 250,pluginConfig: 0,plugin: zeroAddress,unlocked: true,prevTickGlobal: tick - 1000,nextTickGlobal: tick + 1000,lowerTick: tick - 200,upperTick: tick + 200,ticks: [] };
}
test('Algebra linked traversal, signed crossings and plugin/community fee splits use native integers', () => {
  const original = state(), copy = structuredClone(original);
  for (const down of [true,false]) {
    const quote = quoteAlgebraExactInput(original,down,'1000'); assert.equal(quote.amountOut,'996'); assert.equal(quote.steps,1);
    const crossed = { ...original,prevTickGlobal: -60,nextTickGlobal: 60,ticks: [{ tick: -60,liquidityGross: '500000',liquidityNet: '500000',prevTick: -1000,nextTick: 60 },{ tick: 60,liquidityGross: '500000',liquidityNet: '500000',prevTick: -60,nextTick: 1000 }] };
    const result = quoteAlgebraExactInput(crossed,down,'4000'); assert.deepEqual(result.crossedTicks,[down ? -60 : 60]); assert.equal(result.nextState.liquidity,down ? '500000' : '1500000');
    assert.throws(() => quoteAlgebraExactInput({ ...crossed,ticks: crossed.ticks.slice(1) },down,'4000'),/COVERAGE/);
  }
  assert.deepEqual(original,copy);
  const plugin = { ...original,pluginConfig: 1,plugin: `0x${'1'.repeat(40)}` };
  assert.throws(() => quoteAlgebraExactInput(plugin,true,'2000'),/UNRESOLVED_ALGEBRA_PLUGIN/);
  const resolution = { snapshotDigest: digest(plugin),amountIn: '2000',zeroForOne: true,overrideFee: 3000,pluginFee: 1000,evidenceDigest: digest('fixture-beforeSwap') };
  const quote = quoteAlgebraExactInput(plugin,true,'2000',resolution);
  assert.equal(quote.feeAmount,'8'); assert.equal(quote.pluginFeeAmount,'2'); assert.equal(quote.communityFeeAmount,'1');
  assert.throws(() => quoteAlgebraExactInput(plugin,true,'1000',resolution),/UNRESOLVED_ALGEBRA_PLUGIN/);
  assert.throws(() => quoteAlgebraExactInput(original,true,'1000000'),/COVERAGE_EXHAUSTED/);
});
test('current Algebra capture reads the six-field linked ABI at one block and rejects reorg/code drift', async () => {
  const hash = `0x${'a'.repeat(64)}` as const, pool = `0x${'1'.repeat(40)}` as const, calls: bigint[] = [];
  let reorg = false, changed = false, blockReads = 0;
  const client: StateClient = { getChainId: async () => 42161,getBlock: async () => ({ number: 2n,timestamp: 1n,hash: reorg && ++blockReads > 1 ? `0x${'b'.repeat(64)}` : hash }),getCode: async args => { calls.push(args.blockNumber); return changed ? '0x6001' : '0x6000'; },readContract: async args => {
    calls.push(args.blockNumber);
    const values: Record<string,unknown> = { globalState: [sqrtRatioAtTick(0),0,3000,0,250,true],liquidity: 1000000n,plugin: zeroAddress,prevTickGlobal: -60,nextTickGlobal: 60,token0: pool,token1: `0x${'2'.repeat(40)}` };
    if (args.functionName === 'ticks') return args.args![0] === -60 ? [500000n,500000n,-1000,60,0n,0n] : [500000n,500000n,-60,1000,0n,0n];
    return values[args.functionName];
  } };
  const captured = await readAlgebraLinkedSnapshot(client,pool,keccak256('0x6000'),-200,200);
  assert.equal(captured.state.ticks.length,2); assert.ok(calls.every(block => block === 2n)); assert.equal(captured.identity.blockHash,hash);
  assert.equal(quoteAlgebraExactInput(captured.state,true,'1000').amountOut,'996');
  changed = true; await assert.rejects(readAlgebraLinkedSnapshot(client,pool,keccak256('0x6000'),-200,200),/POOL_CODE_CHANGED/);
  changed = false; reorg = true; blockReads = 0; await assert.rejects(readAlgebraLinkedSnapshot(client,pool,keccak256('0x6000'),-200,200),/BLOCK_REORG/);
});
test('conditional Algebra sizing preserves block identity and proves only the declared finite domain', async () => {
  const token0 = `0x${'1'.repeat(40)}`,token1 = `0x${'2'.repeat(40)}`, identity = { chain: 'arbitrum' as const,network: '42161' as const,height: '2',blockHash: `0x${'a'.repeat(64)}` };
  const venues: ConditionalVenue[] = [state(1000),state(0)].map((value,i) => ({ poolId: `arbitrum:42161:algebra${i}`,identity,token0,token1,kind: 'algebra',state: value,feeResolutions: [] }));
  const request: SizingRequest = { schemaVersion: '4.0',snapshotDigest: digest(venues),borrowAsset: token0,route: [{ poolId: venues[0].poolId,tokenIn: token0 },{ poolId: venues[1].poolId,tokenIn: token1 }],minimum: '1',maximum: '200',quantum: '1',lenderAvailable: '200',flashFeeNumerator: '0',flashFeeDenominator: '1',costInBorrowAsset: '1',costEvidenceDigest: digest('fixture-cost'),minProfit: '1' };
  const result = sizeConditionalCycle(venues,request);
  assert.equal(result.status,'selected'); assert.equal(result.direction,'forward'); assert.equal(result.evaluations,400); assert.equal(result.optimality,'certified'); assert.equal(result.eligibility,'simulation-required');
  const validate = new Ajv2020({ strict: true,allErrors: true }).compile(JSON.parse(await readFile('schemas/liquidity-analytics.schema.json','utf8')));
  for (const artifact of [{ schemaVersion: '4.0',venues,request },result,{ schemaVersion: '4.0',state: state(),zeroForOne: true,amountIn: '1000',feeResolution: null },quoteAlgebraExactInput(state(),true,'1000')]) assert.equal(validate(artifact),true,JSON.stringify(validate.errors));
  assert.throws(() => sizeConditionalCycle(venues,{ ...request,snapshotDigest: digest('wrong') }),/INVALID_CONDITIONAL/);
  const unresolved = structuredClone(venues);
  for (const venue of unresolved) (venue.state as AlgebraLinkedState).pluginConfig = 1;
  const unknown = sizeConditionalCycle(unresolved,{ ...request,snapshotDigest: digest(unresolved),maximum: '2' });
  assert.equal(unknown.status,'incomplete-evidence'); assert.equal(unknown.evidenceComplete,false); assert.equal(unknown.optimality,'best-found');
});
test('native checkpoint reconciliation backfills before durable notification and stops on divergence/gaps', async () => {
  const directory = await mkdtemp(join(tmpdir(),'native-sui-')), hash = (n: number) => toBase58(new Uint8Array(32).fill(n));
  const frame = (height: string): SourceFrame => ({ identity: { chain: 'sui',network: 'mainnet',height,checkpointDigest: hash(Number(height) + 1) },parentDigest: height === '0' ? null : hash(Number(height)),payload: { checkpoint: height } });
  async function* stream(height: string,digest = hash(Number(height) + 1)) { yield { height,digest }; }
  try {
    const journal = new SourceJournal(join(directory,'source.jsonl'),{ sourceId: 'fixture',chain: 'sui',network: 'mainnet',chainIdentifier: hash(99) });
    const notifications: string[] = [];
    const result = await reconcileNativeCheckpoints(journal,stream('2'),async height => frame(height),{ start: '0',maxFrames: 3,maxGap: 3 },async value => { assert.equal((await journal.latest())!.identity.height,value.identity.height); notifications.push(value.identity.height); });
    assert.deepEqual(notifications,['0','1','2']); assert.equal(result.committed,3);
    await assert.rejects(reconcileNativeCheckpoints(journal,stream('3',hash(90)),async height => frame(height),{ start: '0',maxFrames: 1,maxGap: 2 }),/IDENTITY_MISMATCH/);
    assert.equal((await journal.latest())!.identity.height,'2');
    await assert.rejects(reconcileNativeCheckpoints(journal,stream('10'),async height => frame(height),{ start: '0',maxFrames: 1,maxGap: 2 }),/BACKFILL_LIMIT/);
    assert.deepEqual(await reconcileNativeCheckpoints(journal,stream('3'),async height => frame(height),{ start: '0',maxFrames: 1,maxGap: 2,signal: AbortSignal.abort() }),{ committed: 0,lastHeight: '2' });
    let returned = false;
    const stalled = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<{ height: string; digest: string }>>(() => {}),return: async () => { returned = true; return { done: true as const,value: undefined }; } }) };
    assert.deepEqual(await reconcileNativeCheckpoints(journal,stalled,async height => frame(height),{ start: '0',maxFrames: 1,maxGap: 2,signal: AbortSignal.abort() }),{ committed: 0,lastHeight: '2' });
    const controller = new AbortController(), pending = reconcileNativeCheckpoints(journal,stalled,async height => frame(height),{ start: '0',maxFrames: 1,maxGap: 2,signal: controller.signal });
    setTimeout(() => controller.abort(),20); await pending; assert.equal(returned,true);
  } finally { await rm(directory,{ recursive: true,force: true }); }
});
