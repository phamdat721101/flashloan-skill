# System Map: flashloan-skill-v7-integration

Implementation spec: [flashloan-v7-integration.md](flashloan-v7-integration.md). Ledger: [flashloan-v7-integration.spec.json](flashloan-v7-integration.spec.json). Contract: `schemas/flashloan-integration-v1.schema.json` (sha256 `1de7fced…aaaf`).

Status is **Implementing**. SK-00..SK-10 are implemented. Each EDGE proof runs the contract check and its SK runtime tests, and prints `runtime:"LANE_A", pendingLanes:["B","C","D","E"]`. The map is not `Done` until the pinned fork lane (B) passes and the owner authorizes lanes C/D/E.

```json nim-deliver
{
  "featureId": "flashloan-skill-v7-integration",
  "taskType": "feature",
  "status": "Implementing",
  "input": {
    "entrypoint": "Proposed: node dist/evm/cli.js integration-run --intent <flash-intent/1> --inventory <inventory.v2|v3> --resolutions <pool-resolution-report/1> --profile <approved profile> (not registered until SK-02)",
    "payload": "urn:flashloan-integration:1 Intent; null profileRef/authorizationRef => research ledger + INPUT_BLOCKED for sizing/execution"
  },
  "processing": {
    "apiHops": [
      "validateIntegration(Intent) -> adaptIntent -> resolveV4Pools(readV4Initialize, deriveV4PoolId) -> PoolResolutionReport + AnalyticsPoolConfig[] -> readEvmAnalyticsSnapshot",
      "compilePolicy(request, approved, asset, valuation, nowNs, requestedConstraints) -> toEffectivePolicy -> buildRouteCost -> solve/size -> Plan(domainHash flash/execution-plan/1)",
      "selectRouteCodec(ExecutorManifest.capabilities, mode) -> exact unsigned payload -> native simulation -> verifyAdmissionBundle -> EvmBudget.reserve + AttemptJournal.prepare -> sign/submit -> reconcileReceipt -> ExecutionEvidence/2 -> flash-round-result/1"
    ],
    "datastores": [
      ".nim/evm-budgets/<chain>-<signer>.json (existing reservation ledger)",
      "AttemptJournal JSONL (existing) and .nim/deployment-ledger (existing)",
      "Content-addressed executor artifact store (SK-03)"
    ],
    "services": [
      "Existing EvmLiquidityExecutionAdapter with selected RouteCodec",
      "Chain RPC (read-only for lanes A/B)"
    ]
  },
  "output": {
    "state": "SK-00..SK-10 implemented and proven in lane A (local deterministic + Foundry); fork (B) and live (C/D/E) lanes PENDING owner authorization",
    "transitions": [
      "discovered -> resolved -> evaluated -> simulated",
      "unresolved/unsupported -> typed CandidateItem with nextDependency",
      "authorized admitted local path only -> submitted -> reconciled | halted"
    ]
  },
  "seams": [
    { "id": "identity", "description": "v4 manager+poolId+PoolKey canonical identity; never a hash-to-address cast" },
    { "id": "economics", "description": "uint256 bounds, upward cost rounding, strict > threshold, principal/cost conservation" },
    { "id": "admission", "description": "domain-separated canonical hashes bind policy/plan/manifest; no self-hash or JSON success flag admits" },
    { "id": "recovery", "description": "unresolved reservation survives restart and blocks any second send" },
    { "id": "receipt", "description": "v7 result statuses map explicitly to legacy outcomes; unknown receipt never becomes realized" }
  ],
  "edgeProofs": [
    { "edgeId": "EDGE-01", "seamId": "identity", "command": "node --test --test-name-pattern=\"FLASHLOAN_V7_EDGE_01|v7 SK-01\" dist/test/flashloan-v7-integration.test.js dist/test/flashloan-v7-runtime.test.js", "logMarker": "FLASHLOAN_V7_EDGE_01", "sourceFiles": ["src/test/flashloan-v7-integration.test.ts", "src/test/flashloan-v7-runtime.test.ts"] },
    { "edgeId": "EDGE-02", "seamId": "economics", "command": "node --test --test-name-pattern=\"FLASHLOAN_V7_EDGE_02|v7 SK-0[24]\" dist/test/flashloan-v7-integration.test.js dist/test/flashloan-v7-runtime.test.js", "logMarker": "FLASHLOAN_V7_EDGE_02", "sourceFiles": ["src/test/flashloan-v7-integration.test.ts", "src/test/flashloan-v7-runtime.test.ts"] },
    { "edgeId": "EDGE-03", "seamId": "admission", "command": "node --test --test-name-pattern=\"FLASHLOAN_V7_EDGE_03|v7 SK-0[367]\" dist/test/flashloan-v7-integration.test.js dist/test/flashloan-v7-runtime.test.js", "logMarker": "FLASHLOAN_V7_EDGE_03", "sourceFiles": ["src/test/flashloan-v7-integration.test.ts", "src/test/flashloan-v7-runtime.test.ts"] },
    { "edgeId": "EDGE-04", "seamId": "recovery", "command": "node --test --test-name-pattern=\"FLASHLOAN_V7_EDGE_04|v7 SK-08\" dist/test/flashloan-v7-integration.test.js dist/test/flashloan-v7-runtime.test.js", "logMarker": "FLASHLOAN_V7_EDGE_04", "sourceFiles": ["src/test/flashloan-v7-integration.test.ts", "src/test/flashloan-v7-runtime.test.ts"] },
    { "edgeId": "EDGE-05", "seamId": "receipt", "command": "node --test --test-name-pattern=\"FLASHLOAN_V7_EDGE_05|v7 SK-09|v7 integration round\" dist/test/flashloan-v7-integration.test.js dist/test/flashloan-v7-runtime.test.js", "logMarker": "FLASHLOAN_V7_EDGE_05", "sourceFiles": ["src/test/flashloan-v7-integration.test.ts", "src/test/flashloan-v7-runtime.test.ts"] }
  ]
}
```
