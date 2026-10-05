import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDecimal, usdFloorToTokenWei } from '../fixed-point.js';

test('parses decimal configuration without binary floating point', () => {
  assert.equal(parseDecimal('50.125', 8, 'target'), 5_012_500_000n);
  assert.throws(() => parseDecimal('1.000000001', 8, 'target'), /more than/);
});

test('always rounds a USD-derived token floor upward', () => {
  assert.equal(usdFloorToTokenWei(1n, 3n, 0), 1n);
  assert.equal(usdFloorToTokenWei(100_000_000n, 3_000_000_000n, 6), 33_334n);
});
