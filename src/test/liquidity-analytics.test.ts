import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toBase58 } from '@mysten/sui/utils';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { analyzeLiquidity, runLiquidityAnalytics } from '../liquidity/analytics.js';
import { describeLiquidity, parsePoolState, positionInventory, projectPool, type PoolStateEnvelope, type ProjectionRequest } from '../liquidity/projection.js';
import { compareRouteDirections, sizeRoute, sizingToCandidate, type SizingRequest } from '../liquidity/sizing.js';
import { prepareArbitrumTrade, MULTI_LENDER_ROUTE_ABI, type ArbitrumTradeBinding } from '../liquidity/arbitrum.js';
import { decodeFunctionData, zeroAddress } from 'viem';
import { sqrtRatioAtTick } from '../liquidity/clmm.js';
import { poolIdFromKey } from '../state-adapters.js';
import { SnapshotStore } from '../liquidity/state.js';
import { AttemptJournal } from '../liquidity/journal.js';
import { LiquidityRuntime } from '../liquidity/runtime.js';
import { digest } from '../liquidity/state.js';
import { projectV2, v2InputForPrice, type V2State } from '../liquidity/v2.js';
import { cetusSqrtPriceAtTick, quoteCetusExactInput, type CetusMathState } from '../liquidity/cetus-math.js';

const token0 = `0x${'1'.repeat(40)}`, token1 = `0x${'2'.repeat(40)}`;
function pool(suffix = 'a', reserves = ['10000','20000']): PoolStateEnvelope {
  return { schemaVersion: '4.0', identity: { chain: 'arbitrum', network: '42161', height: '1', blockHash: `0x${'a'.repeat(64)}` }, poolId: `arbitrum:42161:${suffix}`, poolAddress: `0x${suffix.repeat(40)}`, adapterRevision: 'test-v2', revisionHash: `0x${'b'.repeat(64)}`, token0,token1,decimals0: 18,decimals1: 18,stateClass: 'canonical',appliedOperations: [],state: { protocol: 'uniswap-v2',reserve0: reserves[0],reserve1: reserves[1],feeNumerator: '997',feeDenominator: '1000' } };
}
function request(p: PoolStateEnvelope, input = '1000', tokenIn = token0): ProjectionRequest {
  return { schemaVersion: '4.0',snapshotDigest: digest(p),operationId: 'transaction-a',operationClass: 'hypothetical',tokenIn,amountIn: input };
}
function sizing(pools: PoolStateEnvelope[], maximum = '1000'): SizingRequest {
  return { schemaVersion: '4.0',snapshotDigest: digest(pools),borrowAsset: token0,route: [{ poolId: pools[0].poolId,tokenIn: token0 },{ poolId: pools[1].poolId,tokenIn: token1 }],minimum: '1',maximum,quantum: '1',lenderAvailable: maximum,flashFeeNumerator: '5',flashFeeDenominator: '10000',costInBorrowAsset: '1',costEvidenceDigest: digest('independent-cost-proof'),minProfit: '1' };
}
test('V2 exact retained reserves, rational prices, inverse thresholds and both directions', () => {
  const p = pool(), before = structuredClone(p), result = projectPool(p,request(p));
  assert.equal(result.amountOut,'1813'); assert.equal(result.projectedState.state.protocol,'uniswap-v2');
  assert.deepEqual(result.priceAfter,{ numerator: '18187',denominator: '11000' });
  assert.equal(result.projectedState.stateClass,'projected'); assert.deepEqual(p,before);
  const opposite = projectPool(p,request(p,'1000',token1));
  assert.ok(BigInt(opposite.priceAfter.numerator) * 2n > BigInt(opposite.priceAfter.denominator) * 4n);
  const state = p.state as V2State;
  const amount = v2InputForPrice(state,true,result.priceAfter,'2000'); assert.equal(amount,'1000');
  assert.equal(v2InputForPrice(state,true,result.priceAfter,(1n << 112n).toString()),'1000');
  assert.equal(v2InputForPrice(state,false,opposite.priceAfter,(1n << 112n).toString()),'1000');
  assert.equal(v2InputForPrice(state,true,{ numerator: '2',denominator: '1' },'0'),'0');
  assert.throws(() => v2InputForPrice(state,true,{ numerator: '1',denominator: '1' },'10'),/UNREACHABLE/);
  const scaled = projectPool({ ...p,decimals0: 18,decimals1: 6 },request({ ...p,decimals0: 18,decimals1: 6 }));
  assert.equal(BigInt(scaled.priceBefore.numerator) / BigInt(scaled.priceBefore.denominator),2000000000000n);
});
test('10,000 V2 vectors satisfy the independently expressed on-chain adjusted-balance invariant and maximal output', () => {
  let seed = 1729n;
  const random = () => { seed = (seed * 48271n) % 2147483647n; return seed; };
  for (let i = 0; i < 10000; i++) {
    const x = random() + 1n,y = random() + 1n,input = random() + 1n, retained = random() % 1000n + 1n;
    const state = { reserve0: x.toString(),reserve1: y.toString(),feeNumerator: retained.toString(),feeDenominator: '1000' };
    const result = projectV2(state,true,input.toString()), output = BigInt(result.amountOut);
    // UniswapV2Pair.swap invariant, expressed with balances and deducted fee rather than quote division.
    const adjustedInput = (x + input) * 1000n - input * (1000n - retained);
    assert.ok(adjustedInput * (y - output) * 1000n >= x * y * 1000000n);
    assert.ok(adjustedInput * (y - output - 1n) * 1000n < x * y * 1000000n);
    assert.equal(BigInt(result.state.reserve0),x + input); assert.equal(BigInt(result.state.reserve1),y - output);
  }
});
test('projection rejects digest substitution, repeated operations, unknown fields, wrong chain and unsafe fees', () => {
  const p = pool(), r = request(p), next = projectPool(p,r).projectedState;
  assert.throws(() => projectPool(p,{ ...r,snapshotDigest: digest('substitution') }),/DIGEST_MISMATCH/);
  assert.throws(() => projectPool(next,{ ...r,snapshotDigest: digest(next) }),/ALREADY_APPLIED/);
  assert.throws(() => projectPool(next,{ ...r,snapshotDigest: digest(next),operationClass: 'ordered-replay' }),/ALREADY_APPLIED/);
  assert.throws(() => projectPool(p,{ ...r,operationClass: 'already-executed' }),/INVALID_PROJECTION/);
  assert.throws(() => projectPool(p,{ ...r,tokenIn: `0x${'3'.repeat(40)}` }),/INVALID_INPUT_ASSET/);
  assert.throws(() => parsePoolState({ ...p,hidden: true }),/INVALID_ANALYTICS_FIELDS/);
  assert.throws(() => parsePoolState({ ...p,state: { ...p.state,feeNumerator: '1001' } }),/V2_INVALID_STATE/);
  assert.throws(() => projectPool(p,{ ...r,amountIn: '0' }),/INVALID_PROJECTION/);
  assert.throws(() => projectV2({ reserve0: ((1n << 112n) - 1n).toString(),reserve1: '1',feeNumerator: '1',feeDenominator: '1' },true,'1'),/OVERFLOW/);
});
function cetus(): CetusMathState {
  return { sqrtPriceX64: '18446744073709551616',tick: 0,liquidity: '1000000000000',feePips: 3000,tickSpacing: 1,lowerTick: -200,upperTick: 200,complete: true,initializedTicks: [] };
}
test('Cetus independent X64 endpoints, direction, fee dust, crossing and coverage', () => {
  assert.equal(cetusSqrtPriceAtTick(0),18446744073709551616n);
  assert.equal(cetusSqrtPriceAtTick(-443636),4295048016n);
  assert.equal(cetusSqrtPriceAtTick(443636),79226673515401279992447579055n);
  const state = cetus();
  for (const direction of [true,false]) {
    const result = quoteCetusExactInput(state,direction,'1000');
    assert.equal(result.amountOut,'996'); assert.equal(result.feeAmount,'3');
    assert.equal(quoteCetusExactInput(state,direction,'1').amountOut,'0');
    const boundary = direction ? -60 : 60;
    const crossed = quoteCetusExactInput({ ...state,initializedTicks: [{ tick: boundary,liquidityGross: '500000000000',liquidityNet: '500000000000' }] },direction,'4000000000');
    assert.deepEqual(crossed.crossedTicks,[boundary]); assert.equal(crossed.liquidityAfter,direction ? '500000000000' : '1500000000000');
  }
  assert.throws(() => quoteCetusExactInput({ ...state,complete: false },true,'1000'),/INVALID_STATE/);
  assert.throws(() => quoteCetusExactInput({ ...state,complete: 'true' } as unknown as CetusMathState,true,'1000'),/INVALID_STATE/);
  assert.throws(() => quoteCetusExactInput(state,true,'1000000000000'),/COVERAGE_EXHAUSTED/);
  assert.throws(() => quoteCetusExactInput(state,true,(1n << 64n).toString()),/OUT_OF_RANGE/);
  for (const direction of [true,false]) assert.throws(() => quoteCetusExactInput({ ...state,liquidity: '1000000',feePips: 0,lowerTick: -1,upperTick: 1 },direction,'50'),/COVERAGE_EXHAUSTED/);
});
test('Cetus quotes match independently generated pinned SDK vectors, including high-liquidity fee dust', async () => {
  const reference = JSON.parse(await readFile('schemas/examples/cetus-reference-vectors.json','utf8'));
  assert.equal(reference.source,'@cetusprotocol/cetus-sui-clmm-sdk@5.1.8');
  assert.equal(reference.vectors,10000); assert.equal(reference.quoted + reference.exhausted,10000);
  assert.ok(reference.crossed > 0); assert.equal(reference.fixtures.length,reference.fixtureCount);
  for (const fixture of reference.fixtures) {
    const actual = quoteCetusExactInput(fixture.state,fixture.aToB,fixture.amount);
    for (const key of ['amountOut','feeAmount','sqrtPriceAfterX64','liquidityAfter'] as const) assert.equal(actual[key],fixture.expected[key]);
  }
});
test('v4 JSON Schema validates public requests and computed outputs; v3 remains a separate contract', async () => {
  const schema = JSON.parse(await readFile('schemas/liquidity-analytics.schema.json','utf8'));
  const validate = new Ajv2020({ strict: true,allErrors: true }).compile(schema);
  for (const [command,file] of [['project','project'],['size','sizing']] as const) {
    const input = JSON.parse(await readFile(`schemas/examples/liquidity-${file}-v4.json`,'utf8'));
    assert.equal(validate(input),true,JSON.stringify(validate.errors));
    const output = analyzeLiquidity(command,input);
    assert.equal(validate(output),true,JSON.stringify(validate.errors));
    assert.equal(validate({ ...input,schemaVersion: '3.0' }),false);
    assert.equal(validate({ ...input,hidden: true }),false);
  }
  const p = pool(), description = describeLiquidity(p);
  assert.equal(validate(description),true,JSON.stringify(validate.errors));
  const extreme = { ...p,decimals0: 255,decimals1: 0 };
  assert.equal(validate(projectPool(extreme,request(extreme))),true,JSON.stringify(validate.errors));
});
test('Sui envelope keeps checkpoint and X64 semantics separate from EVM', () => {
  const sui: PoolStateEnvelope = { ...pool(),identity: { chain: 'sui',network: 'mainnet',height: '1',checkpointDigest: toBase58(new Uint8Array(32).fill(1)) },poolId: 'sui:mainnet:cetus',poolAddress: `0x${'1'.repeat(64)}`,revisionHash: toBase58(new Uint8Array(32).fill(2)),token0: `0x${'0'.repeat(63)}2::sui::SUI`,token1: `0x${'0'.repeat(63)}3::coin::COIN`,state: { protocol: 'cetus',...cetus() } };
  const result = projectPool(sui,request(sui,'1000',sui.token0));
  assert.equal(result.amountOut,'996'); assert.equal(result.projectedState.state.protocol,'cetus');
  assert.deepEqual(result.priceBefore,{ numerator: '1',denominator: '1' });
  assert.throws(() => parsePoolState({ ...sui,state: pool().state }),/PROTOCOL_CHAIN_MISMATCH/);
});
test('liquidity inspection distinguishes actual/virtual reserves and position-specific inventory', () => {
  const v2 = describeLiquidity(pool()); assert.deepEqual(v2.actualReserves,{ reserve0: '10000',reserve1: '20000' }); assert.equal(v2.virtualReserves,null);
  const evm: PoolStateEnvelope = { ...pool(),state: { protocol: 'uniswap-v3',sqrtPriceX96: '79228162514264337593543950336',tick: 0,liquidity: '1000000',feePips: 3000,tickSpacing: 1,unlocked: true,lowerTick: -200,upperTick: 200,bitmapWords: [{ wordPosition: -1,bitmap: '0' },{ wordPosition: 0,bitmap: '0' }],initializedTicks: [] } };
  const result = describeLiquidity(evm); assert.equal(result.actualReserves,null);
  assert.deepEqual(result.virtualReserves,{ token0: { numerator: '1000000',denominator: '1' },token1: { numerator: '1000000',denominator: '1' } });
  assert.ok(BigInt(result.activeInterval!.token0InputFeeExclusive) > 0n);
  const q64 = 18446744073709551616n;
  assert.deepEqual(positionInventory('1000',q64.toString(),(q64 / 2n).toString(),(q64 * 2n).toString(),64),{ token0: '500',token1: '500' });
  assert.deepEqual(positionInventory('1000',(q64 / 4n).toString(),(q64 / 2n).toString(),(q64 * 2n).toString(),64),{ token0: '1500',token1: '0' });
  const projection = projectPool(evm,request(evm)); assert.equal(projection.amountOut,'996');
  assert.throws(() => parsePoolState({ ...evm,state: { ...evm.state,initializedTicks: [{ tick: 400,liquidityGross: '1',liquidityNet: '2' }] } }),/CLMM_INVALID_STATE/);
});
test('small-domain sizing matches exhaustive integer profit and clips lender bounds', () => {
  const pools = [pool('a',['10000','20000']),pool('b',['15000','20000'])], r = sizing(pools,'200');
  const result = sizeRoute(pools,r);
  let best = 0n, bestAmount = 0n;
  for (let q = 1n; q <= 200n; q++) {
    const first = projectV2(pools[0].state as V2State,true,q.toString());
    const second = projectV2(pools[1].state as V2State,false,first.amountOut);
    const debt = q + (q * 5n + 9999n) / 10000n;
    const profit = BigInt(second.amountOut) - debt - 1n;
    if (profit > best) { best = profit; bestAmount = q; }
  }
  assert.equal(result.amountIn,bestAmount.toString()); assert.equal(result.netProfit,best.toString());
  assert.equal(result.optimality,'certified'); assert.equal(result.evaluations,200);
  assert.equal(sizeRoute(pools,{ ...r,lenderAvailable: '20' }).feasibleMaximum,'20');
  assert.equal(sizeRoute(pools,{ ...r,minProfit: '99999' }).status,'no-profitable-size');
});
test('bounded sampled sizing is deterministic and never claims a global certificate', () => {
  const pools = [pool('a'),pool('b',['15000','20000'])], r = { ...sizing(pools,'4000'),maxEvaluations: 100 };
  const a = sizeRoute(pools,r), b = sizeRoute(pools,r);
  assert.deepEqual(a,b); assert.equal(a.optimality,'best-found'); assert.equal(a.evaluations,100);
  assert.ok(BigInt(a.netProfit) > 0n); assert.equal(a.legs[0].amountIn,a.amountIn);
  assert.throws(() => sizeRoute(pools,{ ...r,maxEvaluations: 513 }),/INVALID_SIZING/);
  assert.throws(() => sizeRoute([pools[0],{ ...pools[1],identity: { ...pools[1].identity,height: '2' } }],r),/DIGEST_MISMATCH/);
  assert.throws(() => sizeRoute(pools,{ ...r,route: [r.route[0],r.route[0]] }),/INCOHERENT_ROUTE/);
});
test('comparison continues past directional reserve exhaustion and keeps structural errors fatal', () => {
  const max = (1n << 112n) - 1n;
  const pools = [pool('a',[max.toString(),(max / 2n).toString()]),pool('b',[(max / 2n).toString(),max.toString()])];
  const r = { ...sizing(pools,'20'),flashFeeNumerator: '0' };
  const result = compareRouteDirections(pools,r);
  assert.equal(result.selectedDirection,'reverse'); assert.equal(result.forward,null);
  assert.equal(result.rejectedDirections.forward,'NO_FEASIBLE_SIZING_DOMAIN');
  const symmetric = [pools[1],pools[0]], other = compareRouteDirections(symmetric,{ ...r,snapshotDigest: digest(symmetric),route: [{ poolId: symmetric[0].poolId,tokenIn: token0 },{ poolId: symmetric[1].poolId,tokenIn: token1 }] });
  assert.equal(other.selectedDirection,'forward'); assert.equal(other.reverse,null);
  assert.throws(() => compareRouteDirections(pools,{ ...r,snapshotDigest: digest('wrong') }),/DIGEST_MISMATCH/);
});
test('comparison preserves case-sensitive Sui coin type identity', () => {
  const base = pool(), tag = `0x${'1'.repeat(64)}::coin::`, a = tag + 'COIN', b = tag + 'coin';
  const sui = (suffix: string): PoolStateEnvelope => ({ ...base,identity: { chain: 'sui',network: 'mainnet',height: '1',checkpointDigest: toBase58(new Uint8Array(32).fill(1)) },poolId: `sui:mainnet:${suffix}`,poolAddress: `0x${suffix.repeat(64)}`,revisionHash: toBase58(new Uint8Array(32).fill(2)),token0: a,token1: b,state: { protocol: 'cetus',...cetus() } });
  const pools = [sui('a'),sui('b')], r = { ...sizing(pools,'20'),borrowAsset: a,route: [{ poolId: pools[0].poolId,tokenIn: a },{ poolId: pools[1].poolId,tokenIn: b }] };
  assert.equal(compareRouteDirections(pools,r).selectedDirection,null);
});
test('direction selection compiles exact quote-bound lender calldata and shadow simulation never signs', async () => {
  const pools = [pool('a'),pool('b',['15000','20000'])], r = { ...sizing(pools,'200'),flashFeeNumerator: '0',costInBorrowAsset: '10' };
  const snapshot = { schemaVersion: '3.0' as const,identity: pools[0].identity,sourceId: 'fixture',cursor: '1',observedAtMs: 1000,complete: true,poolIds: pools.map(p => p.poolId),stateDigest: digest(pools) };
  const binding: ArbitrumTradeBinding = { kind: 'morpho-blue',lender: `0x${'3'.repeat(40)}`,deadline: '2',roots: pools.map(p => ({ poolId: p.poolId,root: `0x${'4'.repeat(40)}`,adapterRevision: p.adapterRevision,revisionHash: p.revisionHash })),adapterId: 'fixture-only',adapterRevision: 'fixture',expiresAtMs: 2000,maxGasCost: '5' };
  const prepared = prepareArbitrumTrade(pools,r,snapshot,binding);
  const schema = JSON.parse(await readFile('schemas/liquidity-analytics.schema.json','utf8'));
  const validate = new Ajv2020({ strict: true,allErrors: true }).compile(schema);
  assert.equal(validate({ schemaVersion: '4.0',pools,request: r,snapshot,binding }),true,JSON.stringify(validate.errors));
  assert.equal(validate(prepared),true,JSON.stringify(validate.errors));
  assert.equal(prepared.comparison.selectedDirection,'forward'); assert.ok(prepared.unsignedPayload && prepared.candidate);
  const route = decodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI,data: prepared.unsignedPayload }).args[0];
  assert.equal(route.flashAmount.toString(),prepared.comparison.selected!.amountIn); assert.equal(route.minProfit,11n);
  assert.deepEqual(route.legs.map(leg => leg.minAmountOut.toString()),prepared.comparison.selected!.legs.map(leg => leg.amountOut));
  assert.ok(route.legs.every(leg => leg.venueVersion === 2 && leg.sqrtPriceLimitX96 === 0n && leg.hooks === zeroAddress));
  const opposite = compareRouteDirections([pool('a',['15000','20000']),pool('b')],{ ...r,snapshotDigest: digest([pool('a',['15000','20000']),pool('b')]) });
  assert.equal(opposite.selectedDirection,'reverse');
  assert.equal(validate(opposite),true,JSON.stringify(validate.errors));
  const noTrade = prepareArbitrumTrade(pools,{ ...r,minProfit: '999999' },snapshot,binding);
  assert.equal(noTrade.candidate,null); assert.equal(noTrade.unsignedPayload,null);
  assert.throws(() => prepareArbitrumTrade(pools,{ ...r,minProfit: '999999' },{ ...snapshot,complete: false },binding),/STATE_MISMATCH/);
  assert.throws(() => prepareArbitrumTrade(pools,{ ...r,minProfit: '999999' },snapshot,{ ...binding,maxGasCost: '0' }),/INVALID_TRADE_BINDING/);
  assert.throws(() => prepareArbitrumTrade(pools,r,snapshot,{ ...binding,roots: binding.roots.map(root => ({ ...root,revisionHash: `0x${'c'.repeat(64)}` })) }),/REVISION_MISMATCH/);
  assert.throws(() => prepareArbitrumTrade(pools,{ ...r,flashFeeNumerator: '1' },snapshot,binding),/LENDER_FEE_MISMATCH/);
  assert.throws(() => prepareArbitrumTrade(pools,r,snapshot,{ ...binding,deadline: '1' }),/INVALID_TRADE_BINDING/);
  const directory = await mkdtemp(join(tmpdir(),'analytics-shadow-')); let simulated = 0;
  try {
    const candidate = prepared.candidate, forbidden = async (): Promise<never> => { throw new Error('SHADOW_SIGNING_FORBIDDEN'); };
    const store = new SnapshotStore(1000); store.apply(snapshot);
    const adapter = { admission: { chain: 'arbitrum' as const,network: '42161',revision: 'fixture',expiresAtMs: 2000,evidence: { schema: 'fixture',math: 'fixture',simulation: 'fixture',canary: 'offline-only' } },
      simulate: async () => { simulated++; return { candidateDigest: digest(candidate),payloadDigest: candidate.payloadDigest,stateDigest: candidate.stateDigest,success: true,profitAfterDebt: (BigInt(prepared.comparison.selected!.amountOut) - BigInt(prepared.comparison.selected!.repayment)).toString(),conservativeGasCostInProfitAsset: '5' }; },
      preflight: forbidden,resource: forbidden,sign: forbidden,submit: forbidden,receipt: forbidden };
    const decisions = await new LiquidityRuntime(store,new AttemptJournal(join(directory,'journal.jsonl')),new Map([[candidate.adapterId,adapter]]),() => 1000).run([candidate],{ mode: 'shadow',concurrency: 1,maxCandidates: 1,minProfit: '1',maxDailyLoss: '100',budgetAssets: { 'arbitrum:42161': candidate.profitAsset } });
    assert.equal(simulated,1); assert.equal(decisions[0].status,'simulated');
    const input = { schemaVersion: '4.0',pools,request: r,snapshot,binding }, path = join(directory,'input.json'); await writeFile(path,JSON.stringify(input));
    const cli = spawnSync(process.execPath,['dist/liquidity/cli.js','prepare-arbitrum',path],{ encoding: 'utf8' });
    assert.equal(cli.status,0,cli.stderr); assert.deepEqual(JSON.parse(cli.stdout),prepared);
  } finally { await rm(directory,{ recursive: true,force: true }); }
});
test('V3 and static V4 compilation preserves covered limits and the executor manager sentinel', () => {
  const clmmPool = (suffix: string,tick: number): PoolStateEnvelope => ({ ...pool(suffix),state: { protocol: 'uniswap-v3',sqrtPriceX96: sqrtRatioAtTick(tick).toString(),tick,liquidity: '1000000',feePips: 3000,tickSpacing: 1,unlocked: true,lowerTick: tick - 200,upperTick: tick + 200,bitmapWords: [Math.floor((tick - 200) / 256),Math.floor((tick + 200) / 256)].map(wordPosition => ({ wordPosition,bitmap: '0' })),initializedTicks: [] } });
  const first = clmmPool('a',1000), second = clmmPool('b',0), key = { currency0: token0 as `0x${string}`,currency1: token1 as `0x${string}`,fee: 3000,tickSpacing: 1,hooks: zeroAddress };
  assert.equal(second.state.protocol,'uniswap-v3');
  const { feePips: _fee,unlocked: _unlocked,...state } = second.state as Extract<PoolStateEnvelope['state'],{ protocol: 'uniswap-v3' }>;
  const manager = `0x${'4'.repeat(40)}` as `0x${string}`;
  const v4: PoolStateEnvelope = { ...second,poolAddress: manager,state: { ...state,protocol: 'uniswap-v4',key,poolId: poolIdFromKey(key),lpFeePips: 3000,protocolFeePips: 0 } };
  for (const last of [second,v4]) {
    const pools = [first,last], r = { ...sizing(pools,'200'),flashFeeNumerator: '0' }, snapshot = { schemaVersion: '3.0' as const,identity: first.identity,sourceId: 'fixture',cursor: '1',observedAtMs: 1000,complete: true,poolIds: pools.map(p => p.poolId),stateDigest: digest(pools) };
    const binding: ArbitrumTradeBinding = { kind: 'morpho-blue',lender: `0x${'3'.repeat(40)}`,deadline: '2',roots: pools.map(p => ({ poolId: p.poolId,root: manager,adapterRevision: p.adapterRevision,revisionHash: p.revisionHash })),adapterId: 'fixture',adapterRevision: 'fixture',expiresAtMs: 2000,maxGasCost: '1' };
    const result = prepareArbitrumTrade(pools,r,snapshot,binding); assert.ok(result.unsignedPayload);
    const route = decodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI,data: result.unsignedPayload }).args[0];
    assert.equal(route.legs[0].sqrtPriceLimitX96,sqrtRatioAtTick(800));
    assert.equal(route.legs[1].sqrtPriceLimitX96,sqrtRatioAtTick(200));
    assert.equal(route.legs[1].pool.toLowerCase(),last === v4 ? zeroAddress : second.poolAddress.toLowerCase());
    assert.equal(route.legs[1].root.toLowerCase(),manager); assert.equal(route.legs[1].fee,3000);
    assert.equal(route.legs[1].tickSpacing,1);
    assert.equal(route.legs[1].venueVersion,last === v4 ? 4 : 3);
    if (last === v4) assert.throws(() => prepareArbitrumTrade(pools,r,snapshot,{ ...binding,roots: binding.roots.map(root => ({ ...root,root: `0x${'5'.repeat(40)}` })) }),/REVISION_MISMATCH/);
  }
});
test('sizing-to-runtime handoff re-quotes, rejects projected/tampered state, and cannot bypass admission', async () => {
  const pools = [pool('a'),pool('b',['15000','20000'])], r = { ...sizing(pools,'200'),costInBorrowAsset: '10' }, result = sizeRoute(pools,r);
  const snapshot = { schemaVersion: '3.0' as const,identity: pools[0].identity,sourceId: 'independent-test-capture',cursor: '1',observedAtMs: 1000,complete: true,poolIds: pools.map(p => p.poolId),stateDigest: digest(pools) };
  const binding = { unsignedPayload: 'exact-unsigned-test-payload',adapterId: 'unadmitted-test-adapter',adapterRevision: 'test-revision',expiresAtMs: 2000,maxGasCost: '5' };
  const c = sizingToCandidate(pools,r,result,snapshot,binding);
  assert.equal(c.borrowAmount,result.amountIn); assert.equal(c.payloadDigest,digest(binding.unsignedPayload));
  assert.throws(() => sizingToCandidate(pools,r,{ ...result,netProfit: '999999' },snapshot,binding),/QUOTE_MISMATCH/);
  assert.throws(() => sizingToCandidate(pools,r,{ ...result,stateClass: 'projected' },snapshot,binding),/STATE_MISMATCH/);
  assert.throws(() => sizingToCandidate(pools,r,result,{ ...snapshot,stateDigest: digest('substitution') },binding),/STATE_MISMATCH/);
  const directory = await mkdtemp(join(tmpdir(),'analytics-runtime-'));
  try {
    const store = new SnapshotStore(1000); store.apply(snapshot);
    const runtime = new LiquidityRuntime(store,new AttemptJournal(join(directory,'journal.jsonl')),new Map(),() => 1000);
    const decisions = await runtime.run([c],{ mode: 'auto',concurrency: 1,maxCandidates: 1,minProfit: '1',maxDailyLoss: '100',budgetAssets: { 'arbitrum:42161': c.profitAsset } });
    assert.equal(decisions[0].code,'UNSUPPORTED_CAPABILITY');
  } finally { await rm(directory,{ recursive: true,force: true }); }
});
test('worker and CLI execute the complete wallet-free project and size flow; malformed inputs fail', async () => {
  const p = pool(), input = { schemaVersion: '4.0',pool: p,request: request(p) };
  assert.deepEqual(await runLiquidityAnalytics('project',input),analyzeLiquidity('project',input));
  await assert.rejects(runLiquidityAnalytics('project',input,{ signal: AbortSignal.abort() }),/CANCELLED/);
  await assert.rejects(runLiquidityAnalytics('project',input,{ timeoutMs: 1 }),/TIMEOUT/);
  const directory = await mkdtemp(join(tmpdir(),'liquidity-analytics-'));
  try {
    const path = join(directory,'input.json'); await writeFile(path,JSON.stringify(input));
    const result = spawnSync(process.execPath,['dist/liquidity/cli.js','project',path],{ encoding: 'utf8' });
    assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).amountOut,'1813');
    const sourceCli = spawnSync(process.execPath,['--import','tsx','src/liquidity/cli.ts','project',path],{ encoding: 'utf8' });
    assert.equal(sourceCli.status,0,sourceCli.stderr); assert.equal(JSON.parse(sourceCli.stdout).amountOut,'1813');
    await writeFile(path,JSON.stringify({ ...input,secret: 'not-accepted' }));
    const bad = spawnSync(process.execPath,['dist/liquidity/cli.js','project',path],{ encoding: 'utf8' });
    assert.equal(bad.status,1); assert.match(bad.stderr,/INVALID_ANALYTICS_FIELDS/); assert.equal(bad.stdout,'');
    const pools = [p,pool('b',['15000','20000'])]; await writeFile(path,JSON.stringify({ schemaVersion: '4.0',pools,request: sizing(pools,'200') }));
    const sized = spawnSync(process.execPath,['dist/liquidity/cli.js','size',path],{ encoding: 'utf8' });
    assert.equal(sized.status,0,sized.stderr); assert.equal(JSON.parse(sized.stdout).status,'selected');
    const schema = JSON.parse(await readFile('schemas/liquidity-analytics.schema.json','utf8')); assert.equal(schema.$defs.pool.properties.schemaVersion.const,'4.0');
  } finally { await rm(directory,{ recursive: true,force: true }); }
});
