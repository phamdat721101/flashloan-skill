# System Map: chainlink-native-price

```json nim-deliver
{
  "featureId": "chainlink-native-price",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "node dist/cli.js simulate|execute-auto|run <opportunities.json>; ArbitrumReadOnlySimulator",
    "payload": "SkillConfig.nativePrice from NATIVE_USD_FEED, NATIVE_USD_MAX_AGE_SECONDS, SEQUENCER_UPTIME_FEED, SEQUENCER_GRACE_SECONDS (Arbitrum defaults); NATIVE_TOKEN_USD deprecated"
  },
  "processing": {
    "apiHops": [
      "simulate: latest block -> eth_call/estimateGas -> quoteNativeUsd(block) -> exact USD·1e8 gas -> profit floor",
      "broadcast: receipt block -> quoteWithRetry(3) -> realized P&L or unknown halt"
    ],
    "datastores": ["daily loss ledger"],
    "services": ["Arbitrum RPC", "Chainlink ETH/USD 0x639f…a612", "L2 sequencer uptime 0xfdb6…697d"]
  },
  "output": {
    "state": "SimulationResult/ExecutionReceipt carry nativePrice evidence; gas cost and P&L priced at the valued block",
    "transitions": ["simulated -> priced | NATIVE_PRICE_* rejection", "receipt -> known P&L | unknown -> halted"]
  },
  "seams": [
    { "id": "config-feed", "description": "Feed policy binding and validation" },
    { "id": "feed-round", "description": "Round freshness, positivity and completeness" },
    { "id": "sequencer", "description": "L2 sequencer uptime and grace period" },
    { "id": "gas-floor", "description": "Exact ceiling gas cost reaches the profit floor" },
    { "id": "receipt-pnl", "description": "Bounded receipt valuation retries before halt" }
  ],
  "edgeProofs": [
    { "edgeId": "EDGE-01", "seamId": "config-feed", "command": "node --test --test-name-pattern=EDGE-01 dist/test/native-price.test.js", "logMarker": "native_price_config_binding_proven", "sourceFiles": ["src/test/native-price.test.ts"] },
    { "edgeId": "EDGE-02", "seamId": "feed-round", "command": "node --test --test-name-pattern=EDGE-02 dist/test/native-price.test.js", "logMarker": "native_price_round_validity_proven", "sourceFiles": ["src/test/native-price.test.ts"] },
    { "edgeId": "EDGE-03", "seamId": "sequencer", "command": "node --test --test-name-pattern=EDGE-03 dist/test/native-price.test.js", "logMarker": "native_price_sequencer_gate_proven", "sourceFiles": ["src/test/native-price.test.ts"] },
    { "edgeId": "EDGE-04", "seamId": "gas-floor", "command": "node --test --test-name-pattern=EDGE-04 dist/test/native-price.test.js", "logMarker": "native_price_gas_profit_floor_proven", "sourceFiles": ["src/test/native-price.test.ts"] },
    { "edgeId": "EDGE-05", "seamId": "receipt-pnl", "command": "node --test --test-name-pattern=EDGE-05 dist/test/native-price.test.js", "logMarker": "native_price_receipt_retry_bound_proven", "sourceFiles": ["src/test/native-price.test.ts"] }
  ]
}
```

Live read-only e2e (`.nim/native-price/e2e.json`): Chainlink ETH/USD $2,352.58 at Arbitrum block 518966437 with the sequencer up, and `ArbitrumReadOnlySimulator` priced real gas with no `NATIVE_TOKEN_USD` set.
