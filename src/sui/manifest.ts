import type { Decimal, MoveTarget, RevisionPin, SuiAdapterManifest, SuiObjectRef, SuiStateSnapshot } from './types.js';

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

function target(value: MoveTarget, field: string): void {
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
  target(manifest.lender, 'manifest.lender');
  target(manifest.venue, 'manifest.venue');
  if (manifest.mutableObjectIds.length === 0) throw new Error('manifest.mutableObjectIds must not be empty');
  manifest.mutableObjectIds.forEach((id, index) => address(id, `manifest.mutableObjectIds[${index}]`));
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
