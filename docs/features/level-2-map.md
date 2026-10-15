# System Map: level-2

```json nim-deliver
{
  "featureId": "level-2",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "liquidity l2-follow|l2-replay|l2-inspect|l2-evaluate|l2-serve; runL2Candidates API",
    "payload": "Strict Level 2 1.0 observations, pinned pool/checkpoint state, research outcomes and operator-owned execution bindings"
  },
  "processing": {
    "apiHops": [
      "Arbitrum RPC/optional feed or Sui gRPC -> durable evidence -> coherent state -> exact features",
      "optional external order books -> asset-bound stale-aware market basis",
      "context -> MCP/CLI; chronological model -> pinned report -> existing execution runtime"
    ],
    "datastores": [
      "raw and derived hash-linked JSONL segments",
      "immutable model/evaluation artifacts and dataset pins",
      "existing attempt accounting plus receipt-deduplicated risk journal"
    ],
    "services": [
      "existing Arbitrum/Sui provider interfaces",
      "optional native WebSocket transport",
      "local stdio MCP server; no signer creation"
    ]
  },
  "output": {
    "state": "Local protocol/runtime proofs only; production execution is not admitted.",
    "transitions": [
      "observation -> committed|duplicate|rejected",
      "generation -> coherent|resync-required|invalidated",
      "context -> fresh|stale|incomplete",
      "prediction -> research|operator-pinned-validated",
      "execution -> existing simulated|rejected|reconciled|halted"
    ]
  },
  "seams": [
    {
      "id": "source-to-context",
      "description": "Incremental evidence, parent continuity and source coherence precede context."
    },
    {
      "id": "state-to-metrics",
      "description": "Exact protocol-native math, coverage and unit semantics justify metrics."
    },
    {
      "id": "context-to-agent",
      "description": "Causal frames and strict stdio MCP publish facts without signing authority."
    },
    {
      "id": "context-to-execution",
      "description": "Fresh immutable bindings and risk gates precede existing signing/submission."
    },
    {
      "id": "effects-to-reflection",
      "description": "Distinct authoritative receipt identities govern risk reduction and halts."
    }
  ],
  "edgeProofs": [
    {
      "edgeId": "EDGE-01",
      "seamId": "source-to-context",
      "command": "node --test --test-name-pattern=EDGE-01 dist/test/level-2-e2e.test.js",
      "logMarker": "l2_source_recovered_or_rejected",
      "sourceFiles": [
        "src/test/level-2-e2e.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-02",
      "seamId": "state-to-metrics",
      "command": "node --test --test-name-pattern=EDGE-02 dist/test/level-2-e2e.test.js",
      "logMarker": "l2_math_units_and_coverage_proven",
      "sourceFiles": [
        "src/test/level-2-e2e.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-03",
      "seamId": "context-to-agent",
      "command": "node --test --test-name-pattern=EDGE-03 dist/test/level-2-e2e.test.js",
      "logMarker": "l2_agent_contract_and_causality_proven",
      "sourceFiles": [
        "src/test/level-2-e2e.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-04",
      "seamId": "context-to-execution",
      "command": "node --test --test-name-pattern=EDGE-04 dist/test/level-2-e2e.test.js",
      "logMarker": "l2_execution_binding_rejected_before_send",
      "sourceFiles": [
        "src/test/level-2-e2e.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-05",
      "seamId": "effects-to-reflection",
      "command": "node --test --test-name-pattern=EDGE-05 dist/test/level-2-e2e.test.js",
      "logMarker": "l2_accounting_reflection_halts_or_reconciles",
      "sourceFiles": [
        "src/test/level-2-e2e.test.ts"
      ]
    }
  ]
}
```

## Input Flow

The approved specification is level-2.md. This map verifies local code boundaries only.

## Processing Pipeline

Validated source evidence is journaled before deterministic context processing. External books and provisional feeds remain separate from canonical state. Agent tools request shadow evaluation only; exact execution remains in the existing runtime.

## Output State

Failures are typed rejections, explicit resync states or persistent risk halts. Each EDGE marker is emitted only after assertions pass. Tests include synthetic protocol/runtime inputs and an actual local CLI subprocess; they are not public-source certification, profitable strategy evidence, deployment proof or a mainnet canary.

## Local verification

Run `npm run l2:test`, `npm run l2:proof`, then `nim-skill deliver verify --map docs/features/level-2-map.md --json`. The local evidence is `.nim/e2e/level-2-local-evidence.json`. Existing global liquidity/production admission remains separately gated.
