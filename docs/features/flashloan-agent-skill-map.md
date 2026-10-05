# System Map: flashloan-agent-skill

```json nim-deliver
{
  "featureId": "flashloan-agent-skill",
  "taskType": "feature",
  "status": "In progress — DEX-pair bridge implementation requires fork proof",
  "input": {
    "entrypoint": "src/cli.ts bridge --config <bridge-config.json> --once",
    "payload": "secret-free bridge policy, head-pinned public Arbitrum RPC, Chainlink price attestations, and exact DEX quote evidence"
  },
  "processing": {
    "apiHops": ["Arbitrum JSON-RPC: head block/hash, Chainlink price attestations, exact two-leg quote simulation, executor call simulation, gas estimate, final preflight, transaction receipt"],
    "datastores": ["atomic scanner JSON state", "operator-provided opportunity JSON", ".nim/memory.jsonl", ".nim/lessons.jsonl"],
    "services": ["Arbitrum executor contract", "configured quote venues", "registered opportunity providers", "private relay"]
  },
  "output": {
    "state": "head-pinned DEX BridgeDecision records, plus block-bound AllocationPlan proposals and sanitized Nim runtime events",
    "transitions": ["configured -> finalized-block-indexed -> live-state-validated -> typed-candidate-emitted", "candidate + route evidence -> capability-gated proposal|blocked", "proposal -> simulated -> risk-approved -> final-preflight -> private-relay receipt-valued|pnl-halted", "any RPC failure -> classified diagnostic"]
  },
  "seams": [
    { "id": "config-to-scanner", "description": "Scanner and bridge configuration are secret-free and constrain RPC, chain, approved quoters, on-chain oracles, and executor capabilities." },
    { "id": "checkpoint-to-logs", "description": "A changed checkpoint block hash rewinds the finality window before new logs are trusted." },
    { "id": "logs-to-state", "description": "Aave and Morpho event candidates are checked against current on-chain state." },
    { "id": "pool-to-intent", "description": "Balancer flash callbacks and Uniswap v4 unlock deltas remain distinct tagged intents." },
    { "id": "scanner-to-output", "description": "Only atomic checkpoint updates and schema-valid JSONL output occur; no wallet client or broadcast is reachable." },
    { "id": "candidate-to-proposal", "description": "A typed liquidation or DEX-pair candidate requires same-head exact quote/oracle evidence, bounded sizing, cumulative profit floors, and a fork-proven capability before calldata exists." },
    { "id": "runtime-to-memory", "description": "Every solver outcome is sanitized before Nim memory append; only deduplicated reusable failure codes become lessons." },
    { "id": "proposal-to-send", "description": "Exact calldata must match a reviewed executor capability, signer owner, quote block freshness, final simulation, and risk limits before autonomous send." },
    { "id": "receipt-to-ledger", "description": "Receipt events and gas must produce conservative realized P&L; unknown valuation persists a safety halt." }
  ],
  "edgeProofs": [
    { "edgeId": "EDGE-01", "seamId": "config-to-scanner", "command": "npm test", "logMarker": "EDGE-01", "sourceFiles": ["src/scan/config.ts"] },
    { "edgeId": "EDGE-02", "seamId": "checkpoint-to-logs", "command": "npm test", "logMarker": "EDGE-02", "sourceFiles": ["src/scan/store.ts"] },
    { "edgeId": "EDGE-03", "seamId": "logs-to-state", "command": "npm test", "logMarker": "EDGE-03", "sourceFiles": ["src/scan/scanner.ts"] },
    { "edgeId": "EDGE-04", "seamId": "pool-to-intent", "command": "npm test", "logMarker": "EDGE-04", "sourceFiles": ["src/scan/scanner.ts"] },
    { "edgeId": "EDGE-05", "seamId": "scanner-to-output", "command": "npm test", "logMarker": "EDGE-05", "sourceFiles": ["src/cli.ts"] },
    { "edgeId": "EDGE-06", "seamId": "candidate-to-proposal", "command": "npm test", "logMarker": "fork-proven capability", "sourceFiles": ["src/dynamic.ts"] },
    { "edgeId": "EDGE-07", "seamId": "runtime-to-memory", "command": "npm test", "logMarker": "sanitized runtime events", "sourceFiles": ["src/nim-memory.ts"] }
  ]
}
```

## Input Flow

The CLI receives a validated environment and executor-ready opportunity JSON. Each plan includes calldata, route splits, expiry, optional source/quote blocks, capability, and P&L valuation metadata.

## Processing Pipeline

Providers can build protocol-owned dynamic candidates or use legacy tiers. The orchestrator runs bounded simulations, applies risk policy, and sends only the highest-net eligible plan. The adapter verifies chain, bytecode, signer ownership, capability selector, freshness, and final simulation before signing.

The dynamic bridge accepts only typed Aave/Morpho candidates and exact route quotes. It rejects callback-dependent Balancer/v4 observations, stale evidence, unproven executor capabilities, unsafe split calldata, and route impact over policy. The send adapter uses the configured private relay and never falls back to the public RPC transport.

## Output State

Rejected plans retain typed outcomes. A successful send returns receipt data and either conservative realized P&L or a persisted safety halt; no private key is emitted.

Every solve result also creates a sanitized Nim memory event. Raw calldata, private keys, RPC credentials, signatures, and signed transactions are excluded; repeated reusable failure codes are promoted once as a lesson.
