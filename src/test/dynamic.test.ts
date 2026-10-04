import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDynamicPlan, closeFactorBps, maxAaveRepay, type AaveLiquidationCandidate, type DynamicSolverConfig, type RouteQuote } from '../dynamic.js';
import { ConfiguredRouteSolver } from '../route-solver.js';

const address = '0x1111111111111111111111111111111111111111' as const;
const candidate: AaveLiquidationCandidate = {
  id: 'aave-1', chainId: 42161, protocol: 'aave-v3', observedBlock: '100', observedAt: '2026-10-04T00:00:00.000Z', expiresAt: '2099-10-04T00:00:00.000Z',
  borrower: address, pool: address, debtToken: address, collateralToken: '0x2222222222222222222222222222222222222222', debtAmount: '1000', healthFactorWad: '949999999999999999', liquidationBonusBps: 500
};
const quote: RouteQuote = { venue: 'uniswap-v3', router: address, approveTarget: address, path: [candidate.collateralToken, address], amountIn: 1_000n, amountOut: 1_200n, minAmountOut: 1_100n, priceImpactBps: 10, fee: 500, quoteBlock: 100n, calldata: '0x' };
const config: DynamicSolverConfig = { executorAddress: address, minNetProfitUsd: 1, maxPriceImpactBps: 200, maxProposalBlockAge: 1, capabilities: { 'aave-v3-liquidation': { enabled: true, forkVerified: true } } };

test('uses the protocol close-factor boundary rather than a static borrow tier', () => {
  assert.equal(closeFactorBps(950_000_000_000_000_000n), 5_000);
  assert.equal(closeFactorBps(949_999_999_999_999_999n), 10_000);
  assert.equal(maxAaveRepay(candidate), 1_000n);
});

test('builds a block-bound Aave proposal only with enabled fork-proven capability', () => {
  const plan = buildDynamicPlan(candidate, [quote], config, 10, 1, 0);
  assert.equal(plan?.capability, 'aave-v3-liquidation');
  assert.equal(plan?.sourceBlock, 100n);
  assert.match(plan?.transaction.data ?? '', /^0x/);
  assert.equal(buildDynamicPlan(candidate, [quote], { ...config, capabilities: {} }, 10, 1, 0), undefined);
});

test('does not turn callback-dependent observations into executable plans', () => {
  const observation = { id: 'balancer-1', chainId: 42161, protocol: 'balancer-v2' as const, observedBlock: '100', observedAt: candidate.observedAt, expiresAt: candidate.expiresAt, contract: address, reason: 'callback-capability-unverified' as const };
  assert.equal(buildDynamicPlan(observation, [quote], config, 10, 1, 0), undefined);
});

test('selects the best configured fee tier without a hardcoded pool address', async () => {
  const solver = new ConfiguredRouteSolver([{ id: 'venue-a', quoter: address, router: address, approveTarget: address, feeTiers: [100, 500] }], {
    quoteExactInputSingle: async ({ fee }) => ({ amountOut: BigInt(fee === 100 ? 120 : 110), quoteBlock: 100n, calldata: '0x1234' })
  });
  const routes = await solver.quote({ candidate, repayAmount: 100n });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].fee, 100);
  assert.equal(routes[0].amountOut, 120n);
});
