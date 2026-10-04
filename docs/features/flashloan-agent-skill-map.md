# System Map: flashloan-agent-skill

```json nim-deliver
{
  "featureId": "flashloan-agent-skill",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "src/cli.ts scan --config <scanner-config.json> --once",
    "payload": "secret-free ScannerConfig plus public Arbitrum RPC"
  },
  "processing": {
    "apiHops": ["Arbitrum JSON-RPC: chain ID, bytecode, owner, exact call simulation, gas estimate, final preflight, transaction receipt"],
    "datastores": ["local environment variables", "operator-provided opportunity JSON"],
    "services": ["Arbitrum executor contract", "registered opportunity providers"]
  },
  "output": {
    "state": "ScanEnvelope JSONL with ScanOpportunity[] and diagnostics",
    "transitions": ["configured -> finalized-block-indexed -> live-state-validated -> intent-emitted", "proposal -> simulated -> risk-approved -> final-preflight -> receipt-valued|pnl-halted", "any RPC failure -> classified diagnostic"]
  },
  "seams": [
    { "id": "config-to-scanner", "description": "Scanner configuration is secret-free and constrains the RPC, chain, bootstrap, and protocol addresses." },
    { "id": "checkpoint-to-logs", "description": "A changed checkpoint block hash rewinds the finality window before new logs are trusted." },
    { "id": "logs-to-state", "description": "Aave and Morpho event candidates are checked against current on-chain state." },
    { "id": "pool-to-intent", "description": "Balancer flash callbacks and Uniswap v4 unlock deltas remain distinct tagged intents." },
    { "id": "scanner-to-output", "description": "Only atomic checkpoint updates and schema-valid JSONL output occur; no wallet client or broadcast is reachable." },
    { "id": "proposal-to-send", "description": "Exact calldata must match a reviewed executor capability, signer owner, quote block freshness, final simulation, and risk limits before autonomous send." },
    { "id": "receipt-to-ledger", "description": "Receipt events and gas must produce conservative realized P&L; unknown valuation persists a safety halt." }
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

The CLI receives a validated environment and executor-ready opportunity JSON. Each plan includes calldata, route splits, expiry, optional source/quote blocks, capability, and P&L valuation metadata.

## Processing Pipeline

Providers can build protocol-owned dynamic candidates or use legacy tiers. The orchestrator runs bounded simulations, applies risk policy, and sends only the highest-net eligible plan. The adapter verifies chain, bytecode, signer ownership, capability selector, freshness, and final simulation before signing.

## Output State

Rejected plans retain typed outcomes. A successful send returns receipt data and either conservative realized P&L or a persisted safety halt; no private key is emitted.
