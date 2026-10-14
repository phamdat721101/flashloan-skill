// Optional independent verification tool. The published SDK is installed outside
// this repository; production and the default test suite do not require it.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { quoteCetusExactInput,cetusSqrtPriceAtTick } from './cetus-math.js';

const directory = process.argv[2];
if (!directory) throw new Error('usage: cetus-reference <SDK installation directory> [fixture-output.json]');
const requireReference = createRequire(join(resolve(directory),'package.json'));
const metadata = requireReference('@cetusprotocol/cetus-sui-clmm-sdk/package.json');
assert.equal(metadata.version,'5.1.8','reference version must remain pinned');
const { TickMath,computeSwapStep } = requireReference('@cetusprotocol/cetus-sui-clmm-sdk'), BN = requireReference('bn.js');
let seed = 1729n, quoted = 0, exhausted = 0, crossed = 0;
const random = () => { seed = seed * 48271n % 2147483647n; return seed; };
const fixtures: unknown[] = [];
for (let i = 0; i < 10000; i++) {
  const tick = Number(random() % 10001n) - 5000, aToB = i % 2 === 0;
  const liquidity = i < 1000 ? 10n * (1n << 64n) : 1000000000000n + random() * 1000n;
  const amount = i < 1000 ? random() % 100n + 1n : random() * 4n + 1000n, net = liquidity / 2n;
  const state = { sqrtPriceX64: TickMath.tickIndexToSqrtPriceX64(tick).toString(),tick,liquidity: liquidity.toString(),feePips: Number(random() % 10000n),tickSpacing: 1,lowerTick: tick - 200,upperTick: tick + 200,complete: true,initializedTicks: [{ tick: tick - 60,liquidityGross: net.toString(),liquidityNet: net.toString() },{ tick: tick + 60,liquidityGross: net.toString(),liquidityNet: net.toString() }] };
  assert.equal(cetusSqrtPriceAtTick(tick).toString(),state.sqrtPriceX64);
  let price = new BN(state.sqrtPriceX64), l = new BN(state.liquidity), remaining = new BN(amount.toString()), out = new BN(0), fee = new BN(0);
  const boundaries = aToB ? [state.initializedTicks[0],{ tick: state.lowerTick,liquidityNet: '0' }] : [state.initializedTicks[1],{ tick: state.upperTick,liquidityNet: '0' }];
  for (const boundary of boundaries) {
    if (remaining.isZero()) break;
    const target = TickMath.tickIndexToSqrtPriceX64(boundary.tick);
    const step = computeSwapStep(price,target,l,remaining,new BN(state.feePips),true);
    out = out.add(step.amountOut); fee = fee.add(step.feeAmount);
    remaining = remaining.sub(step.amountIn).sub(step.feeAmount); price = step.nextSqrtPrice;
    if (price.eq(target)) l = aToB ? l.sub(new BN(boundary.liquidityNet)) : l.add(new BN(boundary.liquidityNet));
  }
  if (!remaining.isZero()) {
    assert.throws(() => quoteCetusExactInput(state,aToB,amount.toString()),/CETUS_COVERAGE_EXHAUSTED/);
    exhausted++; continue;
  }
  const actual = quoteCetusExactInput(state,aToB,amount.toString());
  const expected = { amountOut: out.toString(),feeAmount: fee.toString(),sqrtPriceAfterX64: price.toString(),liquidityAfter: l.toString() };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) assert.equal(actual[key],expected[key],`vector=${i} field=${key}`);
  quoted++; if (actual.crossedTicks.length) crossed++;
  if (i < 16 || i % 157 === 0) fixtures.push({ state,aToB,amount: amount.toString(),expected });
}
const evidence = { source: '@cetusprotocol/cetus-sui-clmm-sdk@5.1.8',reference: 'computeSwapStep and TickMath',seed: '1729',vectors: quoted + exhausted,quoted,exhausted,crossed,fixtureCount: fixtures.length };
assert.equal(evidence.vectors,10000);
if (process.argv[3]) await writeFile(process.argv[3],JSON.stringify({ ...evidence,fixtures },null,2) + '\n');
console.log(JSON.stringify({ ...evidence,result: 'PASS',scope: 'independent SDK mathematics; not Move execution admission' }));
