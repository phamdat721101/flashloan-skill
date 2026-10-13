# Sui Data Schemas & Runtime Interfaces

## 1. Overview & Data Schema Topology

To preserve strict type safety and cross-language interoperability between the Rust daemon, the TypeScript CLI, and agent prompts, the Sui Flashloan Service defines formal JSON Schemas and TypeScript contracts.

```
schemas/
├── sui-scan-config.schema.json          # Public-RPC configuration for Sui indexing
├── sui-scan-envelope.schema.json        # Checkpoint-pinned candidates and object states
├── sui-opportunity.schema.json          # Executor-ready cyclic arbitrage proposals
├── sui-ptb-route.schema.json            # Deterministic PTB command serialization
└── sui-execution-receipt.schema.json    # Finalized transaction execution & P&L receipt
```

---

## 2. Core JSON Schemas

### 2.1 `sui-scan-config.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Sui Scanner Configuration",
  "type": "object",
  "required": ["network", "rpcUrl", "startCheckpoint", "protocols"],
  "properties": {
    "network": { "enum": ["mainnet", "testnet", "devnet", "localnet"] },
    "rpcUrl": { "type": "string", "format": "uri" },
    "wsUrl": { "type": "string", "format": "uri" },
    "startCheckpoint": { "type": "string", "pattern": "^[0-9]+$" },
    "assetAllowlist": {
      "type": "array",
      "items": { "type": "string", "description": "Fully qualified Move struct type, e.g. 0x2::sui::SUI" }
    },
    "protocols": {
      "type": "object",
      "required": ["hotPotatoLender", "cetus", "deepbook"],
      "properties": {
        "hotPotatoLender": {
          "type": "object",
          "required": ["packageId", "poolId"],
          "properties": {
            "packageId": { "type": "string", "pattern": "^0x[0-9a-fA-F]{64}$" },
            "poolId": { "type": "string", "pattern": "^0x[0-9a-fA-F]{64}$" }
          }
        },
        "scallop": {
          "type": "object",
          "properties": {
            "marketId": { "type": "string", "pattern": "^0x[0-9a-fA-F]{64}$" }
          }
        },
        "cetus": {
          "type": "object",
          "required": ["globalConfigId", "pools"],
          "properties": {
            "globalConfigId": { "type": "string", "pattern": "^0x[0-9a-fA-F]{64}$" },
            "pools": { "type": "array", "items": { "type": "string", "pattern": "^0x[0-9a-fA-F]{64}$" } }
          }
        },
        "deepbook": {
          "type": "object",
          "required": ["pools"],
          "properties": {
            "pools": { "type": "array", "items": { "type": "string", "pattern": "^0x[0-9a-fA-F]{64}$" } }
          }
        }
      }
    }
  }
}
```

---

### 2.2 `sui-opportunity.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Sui Flashloan Opportunity",
  "type": "object",
  "required": ["id", "network", "channel", "strategy", "expiresAtCheckpoint", "plans"],
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "network": { "enum": ["mainnet", "testnet", "localnet"] },
    "channel": { "type": "string", "minLength": 1 },
    "strategy": { "enum": ["hot-potato-cetus-deepbook", "scallop-cetus-arbitrage", "navi-triangular-arbitrage"] },
    "expiresAtCheckpoint": { "type": "string", "pattern": "^[0-9]+$" },
    "plans": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["planId", "borrowAsset", "borrowAmount", "quotedNetProfitMist", "quotedNetProfitUsd", "ptbRoute"],
        "properties": {
          "planId": { "type": "string", "minLength": 1 },
          "borrowAsset": { "type": "string" },
          "borrowAmount": { "type": "string", "pattern": "^[0-9]+$" },
          "priceImpactBps": { "type": "number", "minimum": 0 },
          "quotedNetProfitMist": { "type": "string", "pattern": "^[0-9]+$" },
          "quotedNetProfitUsd": { "type": "number", "exclusiveMinimum": 0 },
          "ptbRoute": { "$ref": "sui-ptb-route.schema.json" }
        }
      }
    }
  }
}
```

---

### 2.3 `sui-execution-receipt.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Sui Execution Receipt",
  "type": "object",
  "required": ["digest", "checkpoint", "status", "realizedProfitMist", "gasUsed", "timestamp"],
  "properties": {
    "digest": { "type": "string", "pattern": "^[1-9A-HJ-NP-Za-km-z]{43,44}$", "description": "Base58 transaction digest" },
    "checkpoint": { "type": "string", "pattern": "^[0-9]+$" },
    "status": { "enum": ["success", "failure", "halted"] },
    "realizedProfitMist": { "type": "string", "pattern": "^[0-9]+$" },
    "realizedProfitUsd": { "type": "number" },
    "gasUsed": {
      "type": "object",
      "required": ["computationCost", "storageCost", "storageRebate", "netGasMist"],
      "properties": {
        "computationCost": { "type": "string", "pattern": "^[0-9]+$" },
        "storageCost": { "type": "string", "pattern": "^[0-9]+$" },
        "storageRebate": { "type": "string", "pattern": "^[0-9]+$" },
        "netGasMist": { "type": "string", "pattern": "^-?[0-9]+$" }
      }
    },
    "errorMessage": { "type": "string" },
    "timestamp": { "type": "string", "format": "date-time" }
  }
}
```

---

## 3. TypeScript Runtime Interfaces (`src/sui/types.ts`)

```typescript
export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet' | 'localnet';
export type SuiAddress = `0x${string}`;
export type SuiObjectId = `0x${string}`;
export type Base58Digest = string;

export interface SuiGasSummary {
  computationCost: bigint;
  storageCost: bigint;
  storageRebate: bigint;
  netGasCost: bigint;
}

export interface SuiHotPotatoRouteLeg {
  venue: 'cetus' | 'deepbook' | 'turbos' | 'aftermath';
  poolId: SuiObjectId;
  coinInType: string;
  coinOutType: string;
  minAmountOut: bigint;
}

export interface SuiArbitragePlan {
  planId: string;
  borrowAssetType: string;
  borrowAmount: bigint;
  flashLoanFee: bigint;
  legs: SuiHotPotatoRouteLeg[];
  minNetProfitMist: bigint;
  minNetProfitUsd: number;
}

export interface SuiExecutionReceipt {
  digest: Base58Digest;
  checkpoint: bigint;
  status: 'success' | 'failure' | 'halted';
  realizedProfitMist: bigint;
  realizedProfitUsd: number;
  gasSummary: SuiGasSummary;
  timestamp: string;
}
```
