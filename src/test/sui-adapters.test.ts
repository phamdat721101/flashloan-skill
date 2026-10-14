import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAutonomousRoute, validateAdapterRegistry } from '../sui/manifest.js';
import type { MoveTarget, RevisionPin, SuiAdapterRegistry, SuiAutonomousRoute } from '../sui/types.js';

const SUI = '0x2::sui::SUI';
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const revision: RevisionPin = { packageId: '0x1', publishedAt: '0x1', packageDigest: 'digest', verifiedCheckpoint: '1' };
const target = (module: string, fn: string): MoveTarget => ({ ...revision, module, function: fn });

const registry: SuiAdapterRegistry = {
  id: 'mainnet-reviewed',
  network: 'mainnet',
  lenders: ['navi', 'suilend', 'scallop'].map((kind, index) => ({
    id: kind,
    kind: kind as 'navi' | 'suilend' | 'scallop',
    revision,
    borrow: target('flash', `borrow_${index}`),
    repay: target('flash', `repay_${index}`),
    supportedAssets: [SUI, USDC],
    mutableObjectIds: [`0x${index + 2}`],
    receiptMode: 'hot-potato' as const,
    enabled: true
  })),
  venues: ['cetus', 'turbos'].map((kind, index) => ({
    id: kind,
    kind: kind as 'cetus' | 'turbos',
    revision,
    exactIn: target('pool', `swap_${index}`),
    supportedAssets: [SUI, USDC],
    mutableObjectIds: [`0x${index + 9}`],
    feeSource: 'route-asset' as const,
    enabled: true
  }))
};

const route: SuiAutonomousRoute = {
  lenderAdapterId: 'navi',
  venueAdapterIds: ['cetus', 'turbos'],
  borrowAssetType: USDC,
  baseAssetType: USDC,
  borrowAmount: '1000000',
  repayAmount: '1000500',
  finalBaseAmount: '1010000',
  minProfitBase: '5000',
  gasReserveMist: '1000000',
  expiresAtCheckpoint: '100',
  externalFungibleInputs: [SUI],
  feeBreakdown: [{ assetType: USDC, amount: '500', source: 'route-asset' }]
};

test('admits all selected lenders and venues only with reviewed route-asset fees', () => {
  assert.doesNotThrow(() => validateAdapterRegistry(registry));
  assert.doesNotThrow(() => assertAutonomousRoute(registry, route));
});

test('rejects missing protocol coverage and external fee coins', () => {
  assert.throws(() => validateAdapterRegistry({ ...registry, lenders: registry.lenders.slice(0, 2) }), /missing scallop/);
  assert.throws(() => assertAutonomousRoute(registry, { ...route, externalFungibleInputs: [SUI, USDC] }), /only an owned SUI gas coin/);
  assert.throws(() => assertAutonomousRoute(registry, {
    ...route,
    feeBreakdown: [{ assetType: USDC, amount: '1', source: 'operator-fee-coin' as 'route-asset' }]
  }), /external fee coin/);
  assert.throws(() => validateAdapterRegistry({
    ...registry,
    lenders: registry.lenders.map((lender) => lender.id === 'navi' ? {
      ...lender,
      borrow: { ...lender.borrow, packageDigest: 'unreviewed-upgrade' }
    } : lender)
  }), /must use its adapter revision/);
});

test('rejects disabled adapters and routes that cannot repay and profit', () => {
  assert.throws(() => assertAutonomousRoute({
    ...registry,
    lenders: registry.lenders.map((lender) => lender.id === 'navi' ? { ...lender, enabled: false } : lender)
  }, route), /lender is not enabled/);
  assert.throws(() => assertAutonomousRoute(registry, { ...route, finalBaseAmount: '1005499' }), /cannot meet its minimum profit/);
  assert.throws(() => assertAutonomousRoute(registry, { ...route, baseAssetType: SUI, finalBaseAmount: '1000000000000000' }), /same asset units/);
  assert.throws(() => validateAdapterRegistry({ ...registry, venues: registry.venues.map(venue => ({ ...venue, supportedAssets: [SUI, SUI] })) }), /without duplicates/);
});
