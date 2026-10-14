import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, zeroAddress, type Address } from 'viem';
import { encodeLenderArbitrage, MULTI_LENDER_ROUTE_ABI, type LenderRouteInput } from '../liquidity/arbitrum.js';
const a = `0x${'1'.repeat(40)}` as Address, b = `0x${'2'.repeat(40)}` as Address;
const route: LenderRouteInput = { kind: 'morpho-blue', lender: a, flashAsset: a, flashAmount: '100', minProfit: '10', deadline: '1000', legs: [
  { venueVersion: 4, root: b, pool: zeroAddress, tokenIn: a, tokenOut: b, minAmountOut: '110', fee: 500, sqrtPriceLimitX96: '1', tickSpacing: 10, hooks: zeroAddress, hookData: '0x' },
  { venueVersion: 4, root: b, pool: zeroAddress, tokenIn: b, tokenOut: a, minAmountOut: '120', fee: 500, sqrtPriceLimitX96: '1', tickSpacing: 10, hooks: zeroAddress, hookData: '0x' }
] };
test('encodes independent Morpho and Balancer lender kinds and exact native amounts', () => {
  for (const kind of ['morpho-blue', 'balancer-v2'] as const) {
    const decoded = decodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI, data: encodeLenderArbitrage({ ...route, kind }) });
    assert.equal(decoded.functionName, 'executeLenderArbitrage');
    assert.equal(decoded.args[0].kind, kind === 'morpho-blue' ? 1 : 2);
    assert.equal(decoded.args[0].flashAmount, 100n); assert.equal(decoded.args[0].legs[1].minAmountOut, 120n);
  }
});
test('rejects disconnected routes, unsafe numbers and missing profit floors before encoding', () => {
  assert.throws(() => encodeLenderArbitrage({ ...route, flashAmount: '1.5' }), /INVALID_DECIMAL/);
  assert.throws(() => encodeLenderArbitrage({ ...route, minProfit: '0' }), /INVALID_LENDER/);
  assert.throws(() => encodeLenderArbitrage({ ...route, legs: [route.legs[0], { ...route.legs[1], tokenIn: a }] }), /INVALID_ROUTE_LEG/);
});
