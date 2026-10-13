import type {
  Decimal,
  MoveTarget,
  RevisionPin,
  SuiAdapterManifest,
  SuiAdapterRegistry,
  SuiAutonomousRoute,
  SuiObjectRef,
  SuiStateSnapshot
} from './types.js';

const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export function decimal(value: Decimal, field: string): bigint {
  if (!DECIMAL.test(value)) throw new Error(`${field} must be a non-negative decimal integer`);
  return BigInt(value);
}

function address(value: string, field: string): void {
  if (!ADDRESS.test(value)) throw new Error(`${field} must be a Sui address`);
}

function objectRef(value: SuiObjectRef, field: string): void {
  address(value.id, `${field}.id`);
  decimal(value.version, `${field}.version`);
  if (!value.digest) throw new Error(`${field}.digest is required`);
}

export function validateRevisionPin(pin: RevisionPin, field: string): void {
  address(pin.packageId, `${field}.packageId`);
  address(pin.publishedAt, `${field}.publishedAt`);
  if (!pin.packageDigest) throw new Error(`${field}.packageDigest is required`);
  decimal(pin.verifiedCheckpoint, `${field}.verifiedCheckpoint`);
}

export function validateMoveTarget(value: MoveTarget, field: string): void {
  validateRevisionPin(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.module)) throw new Error(`${field}.module is invalid`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.function)) throw new Error(`${field}.function is invalid`);
}

/** Validates data supplied by a reviewed manifest before it reaches a PTB builder. */
export function validateAdapterManifest(manifest: SuiAdapterManifest): void {
  if (!manifest.id) throw new Error('manifest.id is required');
  if (!['mainnet', 'testnet', 'localnet'].includes(manifest.network)) throw new Error('manifest.network is invalid');
  if (!manifest.baseAssetType.includes('::')) throw new Error('manifest.baseAssetType must be a normalized Move type');
  if (manifest.receiptMode !== 'hot-potato') throw new Error('only hot-potato receipt manifests are supported');
  validateMoveTarget(manifest.lender, 'manifest.lender');
  validateMoveTarget(manifest.venue, 'manifest.venue');
  if (manifest.mutableObjectIds.length === 0) throw new Error('manifest.mutableObjectIds must not be empty');
  manifest.mutableObjectIds.forEach((id, index) => address(id, `manifest.mutableObjectIds[${index}]`));
}

const SUI_TYPE = '0x2::sui::SUI';
const NATIVE_USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

function supportedAsset(value: string, field: string): void {
  if (value !== SUI_TYPE && value !== NATIVE_USDC_TYPE) {
    throw new Error(`${field} must be SUI or native USDC`);
  }
}

function targetUsesRevision(target: MoveTarget, revision: RevisionPin, field: string): void {
  if (target.packageId.toLowerCase() !== revision.packageId.toLowerCase() ||
      target.publishedAt.toLowerCase() !== revision.publishedAt.toLowerCase() ||
      target.packageDigest !== revision.packageDigest) {
    throw new Error(`${field} must use its adapter revision`);
  }
}

/** Validates a reviewed registry; unverified protocol templates must remain disabled. */
export function validateAdapterRegistry(registry: SuiAdapterRegistry): void {
  if (!registry.id) throw new Error('registry.id is required');
  if (!['mainnet', 'testnet', 'localnet'].includes(registry.network)) throw new Error('registry.network is invalid');
  const lenderKinds = new Set(registry.lenders.map((lender) => lender.kind));
  for (const kind of ['navi', 'suilend', 'scallop']) {
    if (!lenderKinds.has(kind as typeof registry.lenders[number]['kind'])) throw new Error(`registry is missing ${kind} lender`);
  }
  const ids = new Set<string>();
  for (const lender of registry.lenders) {
    if (!lender.id || ids.has(lender.id)) throw new Error('lender adapter IDs must be unique');
    ids.add(lender.id);
    validateRevisionPin(lender.revision, `lender ${lender.id}.revision`);
    validateMoveTarget(lender.borrow, `lender ${lender.id}.borrow`);
    validateMoveTarget(lender.repay, `lender ${lender.id}.repay`);
    targetUsesRevision(lender.borrow, lender.revision, `lender ${lender.id}.borrow`);
    targetUsesRevision(lender.repay, lender.revision, `lender ${lender.id}.repay`);
    if (lender.receiptMode !== 'hot-potato') throw new Error(`lender ${lender.id} must use a hot-potato receipt`);
    if (lender.supportedAssets.length === 0) throw new Error(`lender ${lender.id} must support an asset`);
    lender.supportedAssets.forEach((asset, index) => supportedAsset(asset, `lender ${lender.id}.supportedAssets[${index}]`));
    lender.mutableObjectIds.forEach((id, index) => address(id, `lender ${lender.id}.mutableObjectIds[${index}]`));
  }
  const venueKinds = new Set(registry.venues.map((venue) => venue.kind));
  for (const kind of ['cetus', 'turbos']) {
    if (!venueKinds.has(kind as typeof registry.venues[number]['kind'])) throw new Error(`registry is missing ${kind} venue`);
  }
  for (const venue of registry.venues) {
    if (!venue.id || ids.has(venue.id)) throw new Error('adapter IDs must be unique');
    ids.add(venue.id);
    validateRevisionPin(venue.revision, `venue ${venue.id}.revision`);
    validateMoveTarget(venue.exactIn, `venue ${venue.id}.exactIn`);
    targetUsesRevision(venue.exactIn, venue.revision, `venue ${venue.id}.exactIn`);
    if (venue.feeSource !== 'route-asset') throw new Error(`venue ${venue.id} requires an external fee coin`);
    if (venue.supportedAssets.length < 2) throw new Error(`venue ${venue.id} must support SUI and native USDC`);
    venue.supportedAssets.forEach((asset, index) => supportedAsset(asset, `venue ${venue.id}.supportedAssets[${index}]`));
    venue.mutableObjectIds.forEach((id, index) => address(id, `venue ${venue.id}.mutableObjectIds[${index}]`));
  }
}

/** Enforces the SUI-only external-wallet policy before an autonomous route is compiled. */
export function assertAutonomousRoute(registry: SuiAdapterRegistry, route: SuiAutonomousRoute): void {
  validateAdapterRegistry(registry);
  const lender = registry.lenders.find((candidate) => candidate.id === route.lenderAdapterId && candidate.enabled);
  if (!lender) throw new Error('route lender is not enabled');
  if (!lender.supportedAssets.includes(route.borrowAssetType)) throw new Error('route borrow asset is not supported by lender');
  if (route.venueAdapterIds.length < 2 || route.venueAdapterIds.length > 3) throw new Error('route must use two to three swap venues');
  const venues = route.venueAdapterIds.map((id) => registry.venues.find((candidate) => candidate.id === id && candidate.enabled));
  if (venues.some((venue) => !venue)) throw new Error('route venue is not enabled');
  supportedAsset(route.borrowAssetType, 'route.borrowAssetType');
  supportedAsset(route.baseAssetType, 'route.baseAssetType');
  if (route.externalFungibleInputs.length !== 1 || route.externalFungibleInputs[0] !== SUI_TYPE) {
    throw new Error('only an owned SUI gas coin may be an external fungible input');
  }
  route.feeBreakdown.forEach((fee, index) => {
    if (fee.source !== 'route-asset') throw new Error(`route fee ${index} requires an external fee coin`);
    supportedAsset(fee.assetType, `route fee ${index}.assetType`);
    decimal(fee.amount, `route fee ${index}.amount`);
  });
  const borrow = decimal(route.borrowAmount, 'route.borrowAmount');
  const repay = decimal(route.repayAmount, 'route.repayAmount');
  const finalBase = decimal(route.finalBaseAmount, 'route.finalBaseAmount');
  const minProfit = decimal(route.minProfitBase, 'route.minProfitBase');
  if (borrow === 0n || repay < borrow) throw new Error('route repayment must cover a positive borrow');
  if (minProfit === 0n || finalBase < repay + minProfit) throw new Error('route cannot meet its minimum profit after repayment');
  if (decimal(route.gasReserveMist, 'route.gasReserveMist') === 0n) throw new Error('route gas reserve must be positive');
  if (decimal(route.expiresAtCheckpoint, 'route.expiresAtCheckpoint') === 0n) throw new Error('route expiry checkpoint must be positive');
}

/** Rejects a quote if package digest, object version, or checkpoint has drifted. */
export function assertSnapshotMatchesManifest(manifest: SuiAdapterManifest, snapshot: SuiStateSnapshot): void {
  validateAdapterManifest(manifest);
  decimal(snapshot.checkpoint, 'snapshot.checkpoint');
  const checkpoint = decimal(snapshot.checkpoint, 'snapshot.checkpoint');
  for (const [name, target] of [['lender', manifest.lender], ['venue', manifest.venue]] as const) {
    if (checkpoint < decimal(target.verifiedCheckpoint, `${name}.verifiedCheckpoint`)) {
      throw new Error(`snapshot checkpoint predates ${name} verification`);
    }
    if (snapshot.packageDigests[target.packageId.toLowerCase()] !== target.packageDigest) {
      throw new Error(`${name} package digest mismatch`);
    }
  }
  for (const id of manifest.mutableObjectIds) {
    const observed = snapshot.objects.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
    if (!observed) {
      throw new Error(`mutable object reference missing for ${id}`);
    }
    objectRef(observed, `snapshot object ${id}`);
  }
}
