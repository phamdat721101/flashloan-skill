import assert from 'node:assert/strict';
import test from 'node:test';
import { Transaction } from '@mysten/sui/transactions';
import {
  assertDeepBookCanarySnapshot,
  buildDeepBookFlashloanCanary,
  loadDeepBookFlashloanCanary,
  validateDeepBookFlashloanCanary,
  type DeepBookFlashloanCanary
} from '../sui/deepbook.js';

const canary: DeepBookFlashloanCanary = {
  network: 'mainnet',
  packageId: '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497',
  packageDigest: 'package-digest',
  verifiedCheckpoint: '1',
  poolTypeOrigin: '0x2',
  poolId: '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407',
  baseAssetType: '0x2::sui::SUI',
  quoteAssetType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  borrowAmount: '1000000000'
};

test('builds one DeepBook hot-potato borrow and return flow without a swap command', () => {
  const transaction = new Transaction();
  buildDeepBookFlashloanCanary(transaction, canary, '0xf6005efc186b6a4821375eff7d4f7f927132f5528e67421c1821d4917c70c30a');
  assert.equal(transaction.getData().commands.length, 4);
});

test('rejects stale package and shared-pool pins', () => {
  validateDeepBookFlashloanCanary(canary);
  assert.doesNotThrow(() => assertDeepBookCanarySnapshot(canary, {
    checkpoint: '2', packageDigest: 'package-digest', pool: { id: canary.poolId, version: '7', digest: 'pool-digest' },
    poolType: `0x2::pool::Pool<${canary.baseAssetType},${canary.quoteAssetType}>`
  }));
  assert.throws(() => assertDeepBookCanarySnapshot(canary, {
    checkpoint: '2', packageDigest: 'changed', pool: { id: canary.poolId, version: '7', digest: 'pool-digest' },
    poolType: `0x2::pool::Pool<${canary.baseAssetType},${canary.quoteAssetType}>`
  }), /package digest mismatch/);
  assert.throws(() => validateDeepBookFlashloanCanary({ ...canary, borrowAmount: '0' }), /borrowAmount/);
});

test('loads only complete public DeepBook canary configuration', () => {
  const env = {
    SUI_DEEPBOOK_PACKAGE_ID: canary.packageId,
    SUI_DEEPBOOK_PACKAGE_DIGEST: canary.packageDigest,
    SUI_DEEPBOOK_VERIFIED_CHECKPOINT: canary.verifiedCheckpoint,
    SUI_DEEPBOOK_POOL_TYPE_ORIGIN: canary.poolTypeOrigin,
    SUI_DEEPBOOK_POOL_ID: canary.poolId,
    SUI_DEEPBOOK_BASE_ASSET_TYPE: canary.baseAssetType,
    SUI_DEEPBOOK_QUOTE_ASSET_TYPE: canary.quoteAssetType,
    SUI_DEEPBOOK_BORROW_AMOUNT: canary.borrowAmount
  };
  assert.deepEqual(loadDeepBookFlashloanCanary(env), canary);
  assert.throws(() => loadDeepBookFlashloanCanary({ ...env, SUI_DEEPBOOK_BORROW_AMOUNT: '' }), /SUI_DEEPBOOK_BORROW_AMOUNT/);
});
