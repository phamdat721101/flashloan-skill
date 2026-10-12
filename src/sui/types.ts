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
  mutableObjects: SuiObjectRef[];
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
