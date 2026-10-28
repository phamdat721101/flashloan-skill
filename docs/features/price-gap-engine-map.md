# System Map: price-gap-engine

Done means the constructed local implementation passed. Public stream formats, native per-venue forks, operator admission and live profit remain separate gates.

```json nim-deliver
{
  "featureId": "price-gap-engine",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "npm run liquidity -- evidence-gap-run <request.json>; runGapEvidence with explicit host for native execution",
    "payload": "GapRunRequest plus trusted EvidenceHost graph/funding/state capture; see price-gap-engine.md"
  },
  "processing": {
    "apiHops": [
      "inventory -> graph and funding options",
      "exact pattern candidates -> native proof",
      "final cost refresh -> authorized local dispatch -> receipt reconciliation"
    ],
    "datastores": [
      "existing ArtifactStore",
      "generation-keyed bounded hot state",
      "append-only receipt journal"
    ],
    "services": [
      "explicit RPC/stream adapters",
      "existing native simulator",
      "local Anvil for offline E2E"
    ]
  },
  "output": {
    "state": "Constructed local execution and E2E verified; public network admission pending",
    "transitions": [
      "input -> candidate | rejected | inconclusive",
      "candidate -> admitted | stale | unsupported",
      "admitted -> reconciled | submission unknown | PNL unknown"
    ]
  },
  "seams": [
    {
      "id": "graph-funding",
      "description": "Identity, graph completeness and dynamic lender capacity"
    },
    {
      "id": "math-economics",
      "description": "Exact atomic accounting and bounded optimization"
    },
    {
      "id": "state-lineage",
      "description": "Stream cursor, parentage and canonical generation"
    },
    {
      "id": "native-admission",
      "description": "Exact payload and code capability proof"
    },
    {
      "id": "receipt-accounting",
      "description": "Dispatch deduplication, receipts and restart"
    }
  ],
  "edgeProofs": [
    {
      "edgeId": "EDGE-01",
      "seamId": "graph-funding",
      "command": "node --test --test-name-pattern=EDGE-03 dist/test/flashloan-evidence-gap.test.js",
      "logMarker": "gap_dynamic_funding_budget_proven",
      "sourceFiles": [
        "src/test/flashloan-evidence-gap.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-02",
      "seamId": "math-economics",
      "command": "node --test --test-name-pattern=EDGE-02 dist/test/flashloan-evidence-gap.test.js",
      "logMarker": "gap_exact_serial_and_allocation_proven",
      "sourceFiles": [
        "src/test/flashloan-evidence-gap.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-03",
      "seamId": "state-lineage",
      "command": "node --test --test-name-pattern=EDGE-04 dist/test/flashloan-evidence-gap.test.js",
      "logMarker": "gap_stream_lineage_proven",
      "sourceFiles": [
        "src/test/flashloan-evidence-gap.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-04",
      "seamId": "native-admission",
      "command": "node --test --test-name-pattern=EDGE-05 dist/test/flashloan-evidence-gap.test.js",
      "logMarker": "gap_artifact_integrity_proven",
      "sourceFiles": [
        "src/test/flashloan-evidence-gap.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-05",
      "seamId": "receipt-accounting",
      "command": "PRICE_GAP_E2E=1 node scripts/flashloan-evidence-local-e2e.mjs",
      "logMarker": "price_gap_local_receipt_proven",
      "sourceFiles": [
        "scripts/flashloan-evidence-local-e2e.mjs"
      ]
    }
  ]
}
```
