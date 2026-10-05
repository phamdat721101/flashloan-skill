# System Map: flashloan-agent-skill

```json nim-deliver
{
  "featureId": "flashloan-agent-skill",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "flashloan-daemon replay <engine.json> <events.jsonl>",
    "payload": "secret-free Rust/Alloy factory and risk policy, normalized sequencer/canonical live-state events, executor manifest fields, and optional explicit relay configuration"
  },
  "processing": {
    "apiHops": ["sequencer feed adapter and canonical Arbitrum log adapter -> live-head reconciliation -> in-memory V2/V3 pool state -> affected-subgraph route calculation -> existing two-leg executor ABI calldata"],
    "datastores": ["factory metadata/checkpoints only; no persisted pool state is route eligible", "operator-provided JSONL replay fixtures", ".nim/memory.jsonl", ".nim/lessons.jsonl"],
    "services": ["Arbitrum executor contract", "configured quote venues", "registered opportunity providers", "private relay"]
  },
  "output": {
    "state": "versioned JSONL live-head, pool-discovery, route-candidate, and typed rejection records; executable two-hop candidates include reviewed executor calldata",
    "transitions": ["configured -> both live heads -> tentative|canonical live state", "any head mismatch/staleness -> resync-required|halted", "affected pool update -> 2..6-hop route candidate", "two-hop route -> ABI calldata; longer route -> capability-unavailable"]
  },
  "seams": [
    { "id": "config-to-scanner", "description": "Rust engine configuration rejects unreviewed relay protocols, bad chain IDs, malformed amounts, and selector mismatch before any route can be evaluated." },
    { "id": "checkpoint-to-logs", "description": "Canonical and sequencer head records must be monotonic and mutually consistent; a changed hash or parent invalidates executable state." },
    { "id": "dual-head-to-live-state", "description": "A sequencer child must name the current canonical hash; any sequence/hash/parent mismatch invalidates all executable state." },
    { "id": "pool-state-to-route", "description": "Only current in-memory V2/V3 state can produce a bounded cycle; V3 tick crossing and V4 execution fail closed." },
    { "id": "route-to-calldata", "description": "Only a two-hop candidate can map to the reviewed executor ABI; longer routes preserve analysis output but have no execution capability." },
    { "id": "logs-to-state", "description": "Aave and Morpho event candidates are checked against current on-chain state." },
    { "id": "pool-to-intent", "description": "V3 routes stay within their known tick interval and V4 remains discovery-only, so unknown tick crossings cannot become executable estimates." },
    { "id": "scanner-to-output", "description": "Dual-head JSONL replay produces an executable two-hop candidate with ABI calldata and does not construct a signer or broadcast transaction." },
    { "id": "candidate-to-proposal", "description": "A typed liquidation or DEX-pair candidate requires same-head exact quote/oracle evidence, bounded sizing, cumulative profit floors, and a fork-proven capability before calldata exists." },
    { "id": "bridge-to-scheduler", "description": "DEX bridge plans join liquidation plans only through the common AllocationPlan contract; target-token valuation, head hash, source/quote blocks, and source tag are retained." },
    { "id": "scheduler-to-winner", "description": "All sources are simulated under one bounded limit and stable global ordering; exactly one risk-approved plan may reach final preflight." },
    { "id": "manifest-to-executor", "description": "Chain ID, bytecode hash, ABI version, owner, selector, and fork proof bind each plan to a versioned v1 or v2 executor." },
    { "id": "preflight-to-relay", "description": "A typed relay adapter receives one freshly preflighted signed transaction and has no public-RPC fallback." },
    { "id": "runtime-to-memory", "description": "Every solver outcome is sanitized before Nim memory append; only deduplicated reusable failure codes become lessons." },
    { "id": "proposal-to-send", "description": "Exact calldata must match a reviewed executor capability, signer owner, quote block freshness, final simulation, and risk limits before autonomous send." },
    { "id": "receipt-to-ledger", "description": "Receipt events and gas must produce conservative realized P&L; unknown valuation persists a safety halt." }
  ],
  "edgeProofs": [
    { "edgeId": "EDGE-01", "seamId": "config-to-scanner", "command": "cargo test --workspace --locked", "logMarker": "config_rejects_unreviewed_relay_protocol", "sourceFiles": ["crates/flashloan-core/src/lib.rs"] },
    { "edgeId": "EDGE-02", "seamId": "checkpoint-to-logs", "command": "cargo test --workspace --locked", "logMarker": "heads_require_both_feeds_and_reject_divergence", "sourceFiles": ["crates/flashloan-core/src/lib.rs"] },
    { "edgeId": "EDGE-03", "seamId": "logs-to-state", "command": "cargo test --workspace --locked", "logMarker": "affected_cycle_finds_two_hop_profit_and_flags_longer_routes", "sourceFiles": ["crates/flashloan-core/src/lib.rs"] },
    { "edgeId": "EDGE-04", "seamId": "pool-to-intent", "command": "cargo test --workspace --locked", "logMarker": "v3_quote_rejects_tick_crossing_instead_of_estimating", "sourceFiles": ["crates/flashloan-core/src/lib.rs"] },
    { "edgeId": "EDGE-05", "seamId": "scanner-to-output", "command": "cargo test --workspace --locked", "logMarker": "replay_requires_dual_live_heads_and_emits_an_executable_two_hop_candidate", "sourceFiles": ["crates/flashloan-daemon/tests/replay.rs"] },
    { "edgeId": "EDGE-13", "seamId": "dual-head-to-live-state", "command": "cargo test --workspace --locked", "logMarker": "heads_require_both_feeds_and_reject_divergence", "sourceFiles": ["crates/flashloan-core/src/lib.rs"] },
    { "edgeId": "EDGE-14", "seamId": "pool-state-to-route", "command": "cargo test --workspace --locked", "logMarker": "affected_cycle_finds_two_hop_profit_and_flags_longer_routes", "sourceFiles": ["crates/flashloan-core/src/lib.rs"] },
    { "edgeId": "EDGE-15", "seamId": "route-to-calldata", "command": "cargo test --workspace --locked", "logMarker": "replay_requires_dual_live_heads_and_emits_an_executable_two_hop_candidate", "sourceFiles": ["crates/flashloan-daemon/tests/replay.rs"] },
    { "edgeId": "EDGE-06", "seamId": "candidate-to-proposal", "command": "npm test", "logMarker": "fork-proven capability", "sourceFiles": ["src/dynamic.ts"] },
    { "edgeId": "EDGE-07", "seamId": "runtime-to-memory", "command": "npm test", "logMarker": "sanitized runtime events", "sourceFiles": ["src/nim-memory.ts"] },
    { "edgeId": "EDGE-08", "seamId": "bridge-to-scheduler", "command": "npm test", "logMarker": "DEX target-token decimals", "sourceFiles": ["src/bridge/runtime.ts"] },
    { "edgeId": "EDGE-09", "seamId": "scheduler-to-winner", "command": "npm test", "logMarker": "global winner", "sourceFiles": ["src/orchestrator.ts"] },
    { "edgeId": "EDGE-10", "seamId": "manifest-to-executor", "command": "npm test", "logMarker": "executor manifest", "sourceFiles": ["src/arbitrum.ts"] },
    { "edgeId": "EDGE-11", "seamId": "preflight-to-relay", "command": "npm test", "logMarker": "no public fallback", "sourceFiles": ["src/arbitrum.ts"] },
    { "edgeId": "EDGE-12", "seamId": "receipt-to-ledger", "command": "npm test", "logMarker": "receipt valued", "sourceFiles": ["src/arbitrum.ts"] }
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
