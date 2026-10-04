# System Map: flashloan-agent-skill

```json nim-deliver
{
  "featureId": "flashloan-agent-skill",
  "taskType": "feature",
  "status": "Implemented — pending live E2E and client acceptance",
  "input": {
    "entrypoint": "src/cli.ts scan --config <scanner-config.json> --once",
    "payload": "secret-free ScannerConfig plus public Arbitrum RPC"
  },
  "processing": {
    "apiHops": ["Arbitrum JSON-RPC: chain ID, bytecode, exact call simulation, gas estimate, transaction receipt"],
    "datastores": ["local environment variables", "operator-provided opportunity JSON"],
    "services": ["Arbitrum executor contract", "registered opportunity providers"]
  },
  "output": {
    "state": "ScanEnvelope JSONL with ScanOpportunity[] and diagnostics",
    "transitions": ["configured -> finalized-block-indexed -> live-state-validated -> intent-emitted", "any RPC failure -> classified diagnostic"]
  },
  "seams": [
    { "id": "config-to-scanner", "description": "Scanner configuration is secret-free and constrains the RPC, chain, bootstrap, and protocol addresses." },
    { "id": "checkpoint-to-logs", "description": "A changed checkpoint block hash rewinds the finality window before new logs are trusted." },
    { "id": "logs-to-state", "description": "Aave and Morpho event candidates are checked against current on-chain state." },
    { "id": "pool-to-intent", "description": "Balancer flash callbacks and Uniswap v4 unlock deltas remain distinct tagged intents." },
    { "id": "scanner-to-output", "description": "Only atomic checkpoint updates and schema-valid JSONL output occur; no wallet client or broadcast is reachable." }
  ],
  "edgeProofs": [
    { "edgeId": "EDGE-01", "seamId": "config-to-scanner", "command": "npm test", "logMarker": "EDGE-01", "sourceFiles": ["src/scan/config.ts"] },
    { "edgeId": "EDGE-02", "seamId": "checkpoint-to-logs", "command": "npm test", "logMarker": "EDGE-02", "sourceFiles": ["src/scan/store.ts"] },
    { "edgeId": "EDGE-03", "seamId": "logs-to-state", "command": "npm test", "logMarker": "EDGE-03", "sourceFiles": ["src/scan/scanner.ts"] },
    { "edgeId": "EDGE-04", "seamId": "pool-to-intent", "command": "npm test", "logMarker": "EDGE-04", "sourceFiles": ["src/scan/scanner.ts"] },
    { "edgeId": "EDGE-05", "seamId": "scanner-to-output", "command": "npm test", "logMarker": "EDGE-05", "sourceFiles": ["src/cli.ts"] }
  ]
}
```

## Input Flow

The CLI receives a validated environment and a scanner-produced JSON opportunity array. Each plan contains executor-ready calldata, route splits, quote expiry, and a borrow tier.

## Processing Pipeline

Providers discover candidates. The orchestrator builds every allowed tier, runs exact simulations, applies risk policy, and sends only the highest-net eligible plan. The adapter verifies chain ID and executor bytecode and owns signing.

## Output State

Rejected plans retain reasons. A successful send returns a transaction hash, block number, and gas used; no private key is emitted.
