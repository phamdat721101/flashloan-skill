# Flashloan evidence: separate delivery maps

## Specification delivery

Done means the offline specification proofs pass. It grants no runtime capability or trading authority.

```json nim-deliver
{
  "featureId": "flashloan-evidence-spec",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "node scripts/verify-flashloan-evidence-spec.mjs",
    "payload": "Corrected v5 schema, fixture records, PRD baseline and hashed dependencies"
  },
  "processing": {
    "apiHops": [
      "Offline TypeScript AST, Ajv and independent arithmetic; no RPC"
    ],
    "datastores": [
      "Tracked specification artifacts",
      "Ignored local verification evidence"
    ],
    "services": [
      "Explicit local Node/nim host adapter"
    ]
  },
  "output": {
    "state": "Verified implementation specification only",
    "transitions": [
      "requirements -> corrected contracts",
      "source pins -> dependency verification",
      "specification proof -> handoff; runtime remains Draft"
    ]
  },
  "seams": [
    {
      "id": "S1",
      "description": "schema specification boundary"
    },
    {
      "id": "S2",
      "description": "search specification boundary"
    },
    {
      "id": "S3",
      "description": "economics specification boundary"
    },
    {
      "id": "S4",
      "description": "dependencies specification boundary"
    },
    {
      "id": "S5",
      "description": "handoff specification boundary"
    }
  ],
  "edgeProofs": [
    {
      "edgeId": "EDGE-01",
      "seamId": "S1",
      "command": "node scripts/verify-flashloan-evidence-spec.mjs --edge EDGE-01",
      "logMarker": "FLASHLOAN_SPEC_EDGE_01_SCHEMA",
      "sourceFiles": [
        "docs/features/flashloan-evidence-driven-execution.md",
        "docs/features/flashloan-evidence-driven-execution.spec.json",
        "schemas/flashloan-evidence-v5.schema.json",
        "scripts/verify-flashloan-evidence-spec.mjs"
      ]
    },
    {
      "edgeId": "EDGE-02",
      "seamId": "S2",
      "command": "node scripts/verify-flashloan-evidence-spec.mjs --edge EDGE-02",
      "logMarker": "FLASHLOAN_SPEC_EDGE_02_SEARCH",
      "sourceFiles": [
        "docs/features/flashloan-evidence-driven-execution.md",
        "docs/features/flashloan-evidence-driven-execution.spec.json",
        "schemas/flashloan-evidence-v5.schema.json",
        "scripts/verify-flashloan-evidence-spec.mjs"
      ]
    },
    {
      "edgeId": "EDGE-03",
      "seamId": "S3",
      "command": "node scripts/verify-flashloan-evidence-spec.mjs --edge EDGE-03",
      "logMarker": "FLASHLOAN_SPEC_EDGE_03_ECONOMICS",
      "sourceFiles": [
        "docs/features/flashloan-evidence-driven-execution.md",
        "docs/features/flashloan-evidence-driven-execution.spec.json",
        "schemas/flashloan-evidence-v5.schema.json",
        "scripts/verify-flashloan-evidence-spec.mjs"
      ]
    },
    {
      "edgeId": "EDGE-04",
      "seamId": "S4",
      "command": "node scripts/verify-flashloan-evidence-spec.mjs --edge EDGE-04",
      "logMarker": "FLASHLOAN_SPEC_EDGE_04_DEPENDENCIES",
      "sourceFiles": [
        "docs/features/flashloan-evidence-driven-execution.md",
        "docs/features/flashloan-evidence-driven-execution.spec.json",
        "schemas/flashloan-evidence-v5.schema.json",
        "scripts/verify-flashloan-evidence-spec.mjs"
      ]
    },
    {
      "edgeId": "EDGE-05",
      "seamId": "S5",
      "command": "node scripts/verify-flashloan-evidence-spec.mjs --edge EDGE-05",
      "logMarker": "FLASHLOAN_SPEC_EDGE_05_HANDOFF",
      "sourceFiles": [
        "docs/features/flashloan-evidence-driven-execution.md",
        "docs/features/flashloan-evidence-driven-execution.spec.json",
        "schemas/flashloan-evidence-v5.schema.json",
        "scripts/verify-flashloan-evidence-spec.mjs"
      ]
    }
  ]
}
```

## Runtime delivery

Draft until implementation, owner approval and actual full local/native/fork/canary evidence exist. Do not copy specification proof commands into this map. Complete the edge proofs from the companion acceptance criteria, including structured markers and raw evidence hashes.

```json nim-deliver
{
  "featureId": "flashloan-evidence-runtime",
  "taskType": "feature",
  "status": "Draft",
  "input": {
    "entrypoint": "Validated evidence-run CLI and explicit host adapters; public acceptance gated",
    "payload": "v5 run packet, approved profile and coherent state"
  },
  "processing": {
    "apiHops": [
      "discovery/state/quote/native simulation",
      "separately authorized existing private execution"
    ],
    "datastores": [
      "source/attempt journals",
      "protected evidence artifacts",
      "cited memory"
    ],
    "services": [
      "existing local runtime",
      "public MCP owner dependency"
    ]
  },
  "output": {
    "state": "Local core implemented; full historical/native/public acceptance pending",
    "transitions": [
      "input-blocked or canonical-state",
      "bounded search -> native simulation",
      "authorized admission -> submitted/unknown",
      "reconciled or halted"
    ]
  },
  "seams": [
    {
      "id": "S1",
      "description": "Network response to canonical evidence"
    },
    {
      "id": "S2",
      "description": "Attempt and deadline budget"
    },
    {
      "id": "S3",
      "description": "State/policy/context/payload binding"
    },
    {
      "id": "S4",
      "description": "Untrusted input and evidence classes"
    },
    {
      "id": "S5",
      "description": "Submission recovery and receipt truth"
    }
  ],
  "edgeProofs": []
}
```
