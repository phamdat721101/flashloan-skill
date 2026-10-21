# System Map: evm-flashloan

```json nim-deliver
{
  "featureId": "evm-flashloan",
  "taskType": "feature",
  "status": "Draft",
  "input": {
    "entrypoint": "evm deploy|deployment-status|discover|acceptance|acceptance-reconcile",
    "payload": "versioned manifests, verified artifacts, pinned pools and price feeds, local signer reference"
  },
  "processing": {
    "apiHops": [
      "RPC -> pinned snapshots -> sizing -> exact simulation",
      "durable intent -> signing -> chain-native submission -> canonical receipts"
    ],
    "datastores": [
      "canonical signer/chain budget and deployment ledgers",
      "attempt journal and acceptance/finality evidence"
    ],
    "services": [
      "Base RPC and OP fee oracle",
      "Robinhood RPC and Morpho/Uniswap",
      "local signer"
    ]
  },
  "output": {
    "state": "verified deployments and reconciled receipts or explicit rejection/halt",
    "transitions": [
      "planned -> deployed -> configured -> verified",
      "candidate -> simulated -> signed -> submitted -> reconciled | halted"
    ]
  },
  "seams": [
    {
      "id": "config-chain",
      "description": "Network, secret binding and identity"
    },
    {
      "id": "snapshot-route",
      "description": "ABI and integer route provenance"
    },
    {
      "id": "route-admission",
      "description": "Artifacts and protocol roots"
    },
    {
      "id": "lease-submit",
      "description": "Durable exclusive resources and restart"
    },
    {
      "id": "receipt-accounting",
      "description": "Actual fees and profit or halt"
    }
  ],
  "edgeProofs": [
    {
      "edgeId": "EDGE-01",
      "seamId": "config-chain",
      "command": "node --test --test-name-pattern=EDGE-01 dist/test/evm-profiles.test.js",
      "logMarker": "evm_configuration_and_chain_binding_proven",
      "sourceFiles": [
        "src/test/evm-profiles.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-02",
      "seamId": "snapshot-route",
      "command": "node --test --test-name-pattern=EDGE-02 dist/test/evm-profiles.test.js",
      "logMarker": "evm_route_abi_and_math_boundary_proven",
      "sourceFiles": [
        "src/test/evm-profiles.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-03",
      "seamId": "route-admission",
      "command": "node --test --test-name-pattern=EDGE-03 dist/test/evm-profiles.test.js",
      "logMarker": "evm_protocol_and_artifact_admission_proven",
      "sourceFiles": [
        "src/test/evm-profiles.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-04",
      "seamId": "lease-submit",
      "command": "node --test --test-name-pattern=EDGE-04 dist/test/evm-profiles.test.js",
      "logMarker": "evm_nonce_lease_and_restart_exclusion_proven",
      "sourceFiles": [
        "src/test/evm-profiles.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-05",
      "seamId": "receipt-accounting",
      "command": "node --test --test-name-pattern=EDGE-05 dist/test/evm-profiles.test.js",
      "logMarker": "evm_receipt_fee_accounting_or_halt_proven",
      "sourceFiles": [
        "src/test/evm-profiles.test.ts"
      ]
    }
  ]
}
```

Local edges are testable. Production admission remains pending independently verified deployment/finality and profitable live receipt evidence.
