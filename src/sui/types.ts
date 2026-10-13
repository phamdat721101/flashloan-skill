export type Decimal = string;
export type SuiNetworkName = 'mainnet' | 'testnet' | 'localnet';
export type SuiAddress = `0x${string}`;

export interface SuiObjectRef {
  id: SuiAddress;
  version: Decimal;
  digest: string;
}

export interface RevisionPin {
  packageId: SuiAddress;
  publishedAt: SuiAddress;
  packageDigest: string;
  verifiedCheckpoint: Decimal;
}

export interface MoveTarget extends RevisionPin {
  module: string;
  function: string;
}

export interface SuiAdapterManifest {
  id: string;
  network: SuiNetworkName;
  baseAssetType: string;
  lender: MoveTarget;
  venue: MoveTarget;
  /** Stable shared-object identities admitted by the reviewed adapter revision. */
  mutableObjectIds: SuiAddress[];
  receiptMode: 'hot-potato';
  enabled: boolean;
}

export interface SuiStateSnapshot {
  checkpoint: Decimal;
  packageDigests: Record<string, string>;
  objects: SuiObjectRef[];
}

export interface SwapLeg {
  target: MoveTarget;
  minAmountOut: Decimal;
}

export type RouteCommand =
  | { kind: 'borrow'; receipt: 'loan-receipt' }
  | { kind: 'swap'; minAmountOut: Decimal }
  | { kind: 'split-repayment'; repayment: Decimal; profit: Decimal }
  | { kind: 'repay'; receipt: 'loan-receipt'; amount: Decimal }
  | { kind: 'merge-profit' }
  | { kind: 'guard-transfer'; minProfit: Decimal };

export interface SuiRoutePlan {
  repayment: Decimal;
  profit: Decimal;
  commands: RouteCommand[];
}

export type SuiFlashLenderKind = 'navi' | 'suilend' | 'scallop';
export type SuiSwapVenueKind = 'cetus' | 'turbos';
export type RouteFeeSource = 'route-asset';

/** A lender-specific receipt remains opaque to the generic compiler. */
export interface SuiFlashLenderAdapter {
  id: string;
  kind: SuiFlashLenderKind;
  revision: RevisionPin;
  borrow: MoveTarget;
  repay: MoveTarget;
  supportedAssets: string[];
  mutableObjectIds: SuiAddress[];
  receiptMode: 'hot-potato';
  enabled: boolean;
}

export interface SuiSwapVenueAdapter {
  id: string;
  kind: SuiSwapVenueKind;
  revision: RevisionPin;
  exactIn: MoveTarget;
  supportedAssets: string[];
  mutableObjectIds: SuiAddress[];
  /** A venue requiring an operator-owned fee coin is never admitted. */
  feeSource: RouteFeeSource;
  enabled: boolean;
}

export interface SuiAdapterRegistry {
  id: string;
  network: SuiNetworkName;
  lenders: SuiFlashLenderAdapter[];
  venues: SuiSwapVenueAdapter[];
}

export interface SuiRouteFee {
  assetType: string;
  amount: Decimal;
  source: RouteFeeSource;
}

/** Non-SUI coins may only be produced by an earlier command in the same PTB. */
export interface SuiAutonomousRoute {
  lenderAdapterId: string;
  venueAdapterIds: string[];
  borrowAssetType: string;
  baseAssetType: string;
  borrowAmount: Decimal;
  repayAmount: Decimal;
  finalBaseAmount: Decimal;
  minProfitBase: Decimal;
  gasReserveMist: Decimal;
  expiresAtCheckpoint: Decimal;
  externalFungibleInputs: string[];
  feeBreakdown: SuiRouteFee[];
}
