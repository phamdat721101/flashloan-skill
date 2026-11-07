# System Map: Limitless prediction

```json nim-deliver
{
  "featureId": "limitless-prediction",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "prediction CLI JSON stdin",
    "payload": "prediction-request/1 with owner-approved config and optional signed grant"
  },
  "processing": {
    "apiHops": [
      "Public Limitless REST -> normalized snapshots",
      "HMAC profile and history -> account-bound order state",
      "SDK builder/signature -> exact authenticated submission",
      "Base RPC -> pinned contracts, bounded approvals and safe receipts"
    ],
    "datastores": [
      "fsynced hash-linked account journal, isolated by paper/live and fixture/production"
    ],
    "services": [
      "optional pinned Limitless SDK; existing viem and Node CLI"
    ]
  },
  "output": {
    "state": "Offline implementation and public-data paper lifecycle verified; funded acceptance NOT_RUN",
    "transitions": [
      "prepared -> authorized -> reserved -> dispatching",
      "dispatching -> acknowledged|acceptance-unknown",
      "open -> partially-filled -> filled|cancelled",
      "resolved -> redemption-pending -> redeemed"
    ]
  },
  "seams": [
    {
      "id": "provider-to-snapshot",
      "description": "Canonical chain, market, account and unit identity"
    },
    {
      "id": "intent-to-plan",
      "description": "Bounded amounts, fees, approvals and SDK parity"
    },
    {
      "id": "authority-to-signature",
      "description": "Independent owner grants before keys or writes"
    },
    {
      "id": "dispatch-to-recovery",
      "description": "Persisted identities, unknown acceptance and restart"
    },
    {
      "id": "fills-to-accounting",
      "description": "Canonical deduplication, FIFO and redemption"
    }
  ],
  "edgeProofs": [
    {
      "edgeId": "EDGE-01",
      "seamId": "provider-to-snapshot",
      "command": "node --test --test-name-pattern=EDGE-01 dist/test/limitless-e2e.test.js",
      "logMarker": "limitless_edge_01_verified",
      "sourceFiles": [
        "src/test/limitless-e2e.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-02",
      "seamId": "intent-to-plan",
      "command": "node --test --test-name-pattern=EDGE-02 dist/test/limitless-e2e.test.js",
      "logMarker": "limitless_edge_02_verified",
      "sourceFiles": [
        "src/test/limitless-e2e.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-03",
      "seamId": "authority-to-signature",
      "command": "node --test --test-name-pattern=EDGE-03 dist/test/limitless-e2e.test.js",
      "logMarker": "limitless_edge_03_verified",
      "sourceFiles": [
        "src/test/limitless-e2e.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-04",
      "seamId": "dispatch-to-recovery",
      "command": "node --test --test-name-pattern=EDGE-04 dist/test/limitless-e2e.test.js",
      "logMarker": "limitless_edge_04_verified",
      "sourceFiles": [
        "src/test/limitless-e2e.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-05",
      "seamId": "fills-to-accounting",
      "command": "node --test --test-name-pattern=EDGE-05 dist/test/limitless-e2e.test.js",
      "logMarker": "limitless_edge_05_verified",
      "sourceFiles": [
        "src/test/limitless-e2e.test.ts"
      ]
    }
  ]
}
```

Owner approved the implementation plan in this session. Fixture transport cannot establish production readiness. Funded acceptance remains separately gated.
