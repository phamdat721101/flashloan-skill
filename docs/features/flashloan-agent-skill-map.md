# System Map: flashloan-agent-skill

```json nim-deliver
{
  "featureId": "flashloan-agent-skill",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "src/cli.ts run <opportunities.json>",
    "payload": "SkillConfig plus schema-valid executor-ready Opportunity records"
  },
  "processing": {
    "apiHops": ["Arbitrum JSON-RPC: chain ID, bytecode, exact call simulation, gas estimate, transaction receipt"],
    "datastores": ["local environment variables", "operator-provided opportunity JSON"],
    "services": ["Arbitrum executor contract", "registered opportunity providers"]
  },
  "output": {
    "state": "ExecutionDecision[] with optional ExecutionReceipt",
    "transitions": ["configured -> discovered -> allocated -> simulated -> risk-approved -> broadcast -> settled", "any failure -> rejected with diagnostic"]
  },
  "seams": [
    { "id": "config-to-connector", "description": "Environment parsing must prevent malformed secrets and endpoints reaching a connector." },
    { "id": "rpc-to-executor", "description": "RPC chain and deployed executor bytecode must agree before execution." },
    { "id": "provider-to-orchestrator", "description": "Expired and foreign-chain quotes must not become allocations." },
    { "id": "allocation-to-risk", "description": "Multi-route allocations must sum exactly to 10,000 basis points." },
    { "id": "simulation-to-broadcast", "description": "The final raw-call simulation must pass immediately before signing." }
  ],
  "edgeProofs": [
    { "edgeId": "EDGE-01", "seamId": "config-to-connector", "command": "npm test", "logMarker": "EDGE-01", "sourceFiles": ["src/config.ts"] },
    { "edgeId": "EDGE-02", "seamId": "rpc-to-executor", "command": "npm test", "logMarker": "EDGE-02", "sourceFiles": ["src/arbitrum.ts"] },
    { "edgeId": "EDGE-03", "seamId": "provider-to-orchestrator", "command": "npm test", "logMarker": "EDGE-03", "sourceFiles": ["src/orchestrator.ts"] },
    { "edgeId": "EDGE-04", "seamId": "allocation-to-risk", "command": "npm test", "logMarker": "EDGE-04", "sourceFiles": ["src/risk.ts"] },
    { "edgeId": "EDGE-05", "seamId": "simulation-to-broadcast", "command": "npm test", "logMarker": "EDGE-05", "sourceFiles": ["src/arbitrum.ts"] }
  ]
}
```

## Input Flow

The CLI receives a validated environment and a scanner-produced JSON opportunity array. Each plan contains executor-ready calldata, route splits, quote expiry, and a borrow tier.

## Processing Pipeline

Providers discover candidates. The orchestrator builds every allowed tier, runs exact simulations, applies risk policy, and sends only the highest-net eligible plan. The adapter verifies chain ID and executor bytecode and owns signing.

## Output State

Rejected plans retain reasons. A successful send returns a transaction hash, block number, and gas used; no private key is emitted.
