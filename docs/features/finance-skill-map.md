# System Map: AI Finance lane

Status stays Draft until the owner approves; live/funded evidence is NOT_RUN.

```json nim-deliver
{
  "featureId": "finance-skill-v1",
  "taskType": "feature",
  "status": "Draft",
  "input": {
    "entrypoint": "node dist/finance/cli.js --config <owner-profile.json>",
    "payload": "finance.request/1 for remote reads; finance.local-request/1 and Plan for local operations"
  },
  "processing": {
    "apiHops": [
      "Authenticated MCP client (read/prepare only)",
      "Native provider read/simulation",
      "Owner-controlled signer and admitted submission endpoint"
    ],
    "datastores": [
      "Restricted local owner attempt/grant/budget journal",
      "Imported content-addressed plans"
    ],
    "services": [
      "Existing EVM runtime and optional native XRPL codec/signing host",
      "Independent PredictionRuntime"
    ]
  },
  "output": {
    "state": "Fixture/local-chain implementation verified (EDGE-01..05, Forge R3); live read matrix and funded pilot NOT_RUN",
    "transitions": [
      "PREPARED -> SIMULATED -> AWAITING_APPROVAL -> SUBMITTING -> SUBMITTED -> native confirmation -> FINALIZED",
      "Unknown send -> UNKNOWN/HALTED -> reconcile; never blind resend"
    ]
  },
  "seams": [
    {
      "id": "boundary",
      "description": "Untrusted JSON or MCP transport to validated Finance input"
    },
    {
      "id": "state",
      "description": "Capability and protocol state acquisition under a deadline"
    },
    {
      "id": "authority",
      "description": "Owner/plan/policy and concurrent reservation boundary"
    },
    {
      "id": "native",
      "description": "Native payload preparation or local simulation boundary"
    },
    {
      "id": "recovery",
      "description": "Job/artifact/action publication and recovery boundary"
    }
  ],
  "edgeProofs": [
    {
      "edgeId": "EDGE-01",
      "seamId": "boundary",
      "command": "node --test --test-name-pattern=EDGE-01 dist/test/finance-e2e.test.js",
      "logMarker": "FINANCE_SKILL_EDGE-01_PROVEN",
      "sourceFiles": [
        "src/test/finance-e2e.test.ts",
        "src/finance/runtime.ts"
      ]
    },
    {
      "edgeId": "EDGE-02",
      "seamId": "state",
      "command": "node --test --test-name-pattern=EDGE-02 dist/test/finance-e2e.test.js",
      "logMarker": "FINANCE_SKILL_EDGE-02_PROVEN",
      "sourceFiles": [
        "src/test/finance-e2e.test.ts",
        "src/finance/runtime.ts"
      ]
    },
    {
      "edgeId": "EDGE-03",
      "seamId": "authority",
      "command": "node --test --test-name-pattern=EDGE-03 dist/test/finance-e2e.test.js",
      "logMarker": "FINANCE_SKILL_EDGE-03_PROVEN",
      "sourceFiles": [
        "src/test/finance-e2e.test.ts",
        "src/finance/runtime.ts"
      ]
    },
    {
      "edgeId": "EDGE-04",
      "seamId": "native",
      "command": "node --test --test-name-pattern=EDGE-04 dist/test/finance-e2e.test.js",
      "logMarker": "FINANCE_SKILL_EDGE-04_PROVEN",
      "sourceFiles": [
        "src/test/finance-e2e.test.ts",
        "src/finance/runtime.ts"
      ]
    },
    {
      "edgeId": "EDGE-05",
      "seamId": "recovery",
      "command": "node --test --test-name-pattern=EDGE-05 dist/test/finance-e2e.test.js",
      "logMarker": "FINANCE_SKILL_EDGE-05_PROVEN",
      "sourceFiles": [
        "src/test/finance-e2e.test.ts",
        "src/finance/runtime.ts"
      ]
    }
  ]
}
```
