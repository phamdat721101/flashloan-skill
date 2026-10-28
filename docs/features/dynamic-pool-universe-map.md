# System Map: dynamic-pool-universe

```json nim-deliver
{
  "featureId": "dynamic-pool-universe",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "node dist/evm/cli.js universe --inventory <mcp.json> --policy <policy.json> --out <universe.json>",
    "payload": "raw flashloan MCP inventory (flashloan.inventory.v2, discovery only) plus a checked-in per-chain asset policy (feeds, lenders, factory allowlist, executor venue map)"
  },
  "processing": {
    "apiHops": [
      "MCP inventory -> pre-filter (eligibility, chain, staleness, denylist, duplicates)",
      "pinned block -> factory/token0/token1/state raw reads -> decimals -> pool-universe/1",
      "consumers re-read live state: Rust signal per pair, Rust arb combos, Aero pairs -> discoverAeroPools"
    ],
    "datastores": [
      ".nim/universe/<chain>.json verified universe (expires)",
      "config/arbitrum-asset-policy.json"
    ],
    "services": [
      "flashloan MCP (agent-side only)",
      "Arbitrum/Base RPC",
      "Chainlink feeds"
    ]
  },
  "output": {
    "state": "pool-universe/1 with pairs, candidatePairs and explicit rejected reasons; per-pair signals or fail-closed errors",
    "transitions": [
      "inventory -> verified universe | rejected (reason)",
      "universe -> signal per pair | UNIVERSE_EXPIRED | VENUE_MAP_UNVERIFIED"
    ]
  },
  "seams": [
    { "id": "inventory-ingest", "description": "MCP inventory freshness, chain binding and shape" },
    { "id": "pool-identity", "description": "Pool token order, decimals and price orientation from chain, not provider labels" },
    { "id": "venue-trust", "description": "Factory allowlist decides venue; no silent drops" },
    { "id": "asset-pricing", "description": "Flash/profit assets need a feed and lender; no $1/6dp default" },
    { "id": "aero-execution", "description": "Aero universe mode plans only executor-trusted pools; non-WETH borrow needs pinned valuation" }
  ],
  "edgeProofs": [
    {
      "edgeId": "EDGE-01",
      "seamId": "inventory-ingest",
      "command": "node --test --test-name-pattern=EDGE-01 dist/test/pool-universe.test.js",
      "logMarker": "universe_inventory_freshness_and_chain_binding_proven",
      "sourceFiles": ["src/test/pool-universe.test.ts"]
    },
    {
      "edgeId": "EDGE-02",
      "seamId": "pool-identity",
      "command": "node --test --test-name-pattern=EDGE-02 dist/test/pool-universe.test.js",
      "logMarker": "universe_token_order_and_decimal_gap_proven",
      "sourceFiles": ["src/test/pool-universe.test.ts"]
    },
    {
      "edgeId": "EDGE-03",
      "seamId": "venue-trust",
      "command": "node --test --test-name-pattern=EDGE-03 dist/test/pool-universe.test.js",
      "logMarker": "universe_factory_spoof_and_silent_drop_rejection_proven",
      "sourceFiles": ["src/test/pool-universe.test.ts"]
    },
    {
      "edgeId": "EDGE-04",
      "seamId": "asset-pricing",
      "command": "cargo test -p flashloan-scan edge_04 -- --nocapture",
      "logMarker": "universe_no_unpriced_flash_asset_proven",
      "sourceFiles": ["crates/flashloan-scan/src/arb.rs"]
    },
    {
      "edgeId": "EDGE-05",
      "seamId": "aero-execution",
      "command": "node --test --test-name-pattern=EDGE-05 dist/test/aero-v2.test.js",
      "logMarker": "aero_universe_fallback_and_valuation_gate_proven",
      "sourceFiles": ["src/test/aero-v2.test.ts"]
    }
  ]
}
```

Local edges are proven. Arbitrum MultiVenue v2 0x2502…9de2 is deployed and L1-finalized; trading admission is separate. Live read-only evidence (Arbitrum block 518930711) is in `.nim/universe/`. DexPair venue ids for executor 0x093e…d192 are trace-verified at block 518952544 (`executorVenues.verifiedBlock`). Aero pools outside the executor's on-chain `trustedPool` set need an owner configuration transaction before they can be executed.
