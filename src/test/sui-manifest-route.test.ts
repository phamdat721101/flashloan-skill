import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSnapshotMatchesManifest, validateAdapterManifest } from '../sui/manifest.js';
import { assertTerminalCustody, compileReferenceRoute } from '../sui/route.js';
import type { MoveTarget, SuiAdapterManifest } from '../sui/types.js';

const lender: MoveTarget = { packageId: '0x1', publishedAt: '0x1', packageDigest: 'lender-digest', verifiedCheckpoint: '10', module: 'flash', function: 'borrow' };
const venue: MoveTarget = { packageId: '0x2', publishedAt: '0x2', packageDigest: 'venue-digest', verifiedCheckpoint: '10', module: 'pool', function: 'swap' };
const manifest: SuiAdapterManifest = {
  id: 'reference-testnet', network: 'testnet', baseAssetType: '0x2::sui::SUI', lender, venue,
  mutableObjects: [{ id: '0xa', version: '7', digest: 'pool-digest' }], receiptMode: 'hot-potato', enabled: false
};

test('accepts only a snapshot pinned to reviewed package and object revisions', () => {
  validateAdapterManifest(manifest);
  assert.doesNotThrow(() => assertSnapshotMatchesManifest(manifest, {
    checkpoint: '11', packageDigests: { '0x1': 'lender-digest', '0x2': 'venue-digest' },
    objects: [{ id: '0xa', version: '7', digest: 'pool-digest' }]
  }));
  assert.throws(() => assertSnapshotMatchesManifest(manifest, {
    checkpoint: '11', packageDigests: { '0x1': 'changed', '0x2': 'venue-digest' },
    objects: [{ id: '0xa', version: '7', digest: 'pool-digest' }]
  }), /digest mismatch/);
});

test('compiles exact repayment and rejects terminal-profit diversion', () => {
  const plan = compileReferenceRoute({
    borrowAmount: '100', fee: '1', finalBaseAmount: '110', minProfitBase: '9',
    legs: [{ target: venue, minAmountOut: '1' }]
  });
  assert.equal(plan.repayment, '101');
  assert.equal(plan.profit, '9');
  assert.throws(() => assertTerminalCustody({ ...plan, commands: plan.commands.slice(0, -1) }), /sole terminal guard/);
  assert.throws(() => compileReferenceRoute({
    borrowAmount: '100', fee: '1', finalBaseAmount: '109', minProfitBase: '9', legs: [{ target: venue, minAmountOut: '1' }]
  }), /cannot repay debt/);
});
