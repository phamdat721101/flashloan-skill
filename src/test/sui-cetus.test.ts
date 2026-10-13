import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCetusPoolCanarySnapshot,
  loadCetusPoolCanary,
  validateCetusPoolCanary,
  type CetusPoolCanary
} from '../sui/cetus.js';

const canary: CetusPoolCanary = {
  network: 'mainnet',
  packageId: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb',
  packageDigest: 'package-digest',
  verifiedCheckpoint: '1',
  globalConfigId: '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f',
  poolId: '0x413ddc5745aa6398e9da66c4843947e479f4bf63bade39ffc94c9197b433b332',
  coinAType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  coinBType: '0x2::sui::SUI',
  feeRate: '100'
};

test('accepts only the selected active Cetus SUI/native-USDC pool revision', () => {
  validateCetusPoolCanary(canary);
  assert.doesNotThrow(() => assertCetusPoolCanarySnapshot(canary, {
    checkpoint: '2',
    packageDigest: canary.packageDigest,
    pool: { id: canary.poolId, version: '7', digest: 'pool-digest' },
    poolType: `${canary.packageId}::pool::Pool<${canary.coinAType},${canary.coinBType}>`,
    isPaused: false,
    feeRate: canary.feeRate,
    liquidity: '1'
  }));
  assert.throws(() => assertCetusPoolCanarySnapshot(canary, {
    checkpoint: '2', packageDigest: canary.packageDigest, pool: { id: canary.poolId, version: '7', digest: 'pool-digest' },
    poolType: `${canary.packageId}::pool::Pool<${canary.coinAType},${canary.coinBType}>`, isPaused: true, feeRate: canary.feeRate, liquidity: '1'
  }), /paused/);
  assert.throws(() => assertCetusPoolCanarySnapshot(canary, {
    checkpoint: '2', packageDigest: canary.packageDigest, pool: { id: canary.poolId, version: '7', digest: 'pool-digest' },
    poolType: `${canary.packageId}::pool::Pool<${canary.coinAType},${canary.coinBType}>`, isPaused: false, feeRate: '101', liquidity: '1'
  }), /fee rate mismatch/);
});

test('loads only complete public Cetus pool configuration', () => {
  const env = {
    SUI_CETUS_PACKAGE_ID: canary.packageId,
    SUI_CETUS_PACKAGE_DIGEST: canary.packageDigest,
    SUI_CETUS_VERIFIED_CHECKPOINT: canary.verifiedCheckpoint,
    SUI_CETUS_GLOBAL_CONFIG_ID: canary.globalConfigId,
    SUI_CETUS_POOL_ID: canary.poolId,
    SUI_CETUS_COIN_A_TYPE: canary.coinAType,
    SUI_CETUS_COIN_B_TYPE: canary.coinBType,
    SUI_CETUS_FEE_RATE: canary.feeRate
  };
  assert.deepEqual(loadCetusPoolCanary(env), canary);
  assert.throws(() => loadCetusPoolCanary({ ...env, SUI_CETUS_POOL_ID: '' }), /SUI_CETUS_POOL_ID/);
});
