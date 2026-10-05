# Flashloan Agent Skill

Install a prompt-driven Arbitrum flashloan skill for Codex agents. Its Rust/Alloy live-state engine is source-built and deliberately wallet-free until a reviewed executor capability and private relay are configured.

## Install

```sh
npm install
npm run build
cargo build --locked --release -p flashloan-daemon
node dist/agent-cli.js install
```

Restart the agent session, then use:

```text
Use $flashloan-agent to scan Aave, Morpho, Balancer, and Uniswap v4 using my scanner configuration without exposing secrets.
```

For a configured executor, private relay, and dedicated wallet, ask the agent to simulate or autonomously execute a schema-valid opportunity file. The runtime verifies chain, executor bytecode, owner signer, capability selector, proposal freshness, private relay, and final simulation before broadcast; it persists realized P&L and halts if P&L cannot be valued.

## Configuration

Copy `.env.example` to `.env`. Keep `OPERATOR_PRIVATE_KEY` only in your local environment; never put credentials in prompts, JSON input, or Git. Validate safely with:

```sh
node dist/cli.js validate-config
```

The runtime accepts exact executor-ready opportunities matching `schemas/opportunity.schema.json`. `FLASH_EXECUTOR_ADDRESS`, `PRIVATE_RELAY_URL`, and `OPERATOR_PRIVATE_KEY` are explicit local configuration; no executor address or secret is implied.

## Read-only real-time scanning

## Rust/Alloy live route engine

`flashloan-daemon` consumes validated sequencer and canonical-head events, keeps only current live pool state in memory, and emits versioned JSONL decisions. It refuses to route until both sources agree on a live canonical/tentative epoch; a hash, parent, or sequence conflict halts route eligibility. V2 pools are executable, V3 quotes are executable only within a supplied known tick interval, and V4 remains discovery-only.

The current executor ABI can submit a two-leg DEX pair arbitrage only. The daemon analyzes 2–6-hop affected-subgraph cycles but marks routes longer than two hops `EXECUTOR_CAPABILITY_UNAVAILABLE` until a separately reviewed ABI supports them.

```sh
cargo run --locked --release -p flashloan-daemon -- validate-config engine.json
cargo run --locked --release -p flashloan-daemon -- replay engine.json live-events.jsonl
```

`engine.json` uses `schemaVersion: "2.0"`, `chainId: 42161`, explicit factory addresses, risk limits in decimal-string USD E8 units, an executor address/code hash/current selector, and an `rpc-send-raw-transaction` relay URL environment-variable name. `live-events.jsonl` accepts `head`, `poolUpsert`, and `scan` records; it is the deterministic replay contract for dual-ingress E2E tests and adapter integration.

The legacy TypeScript scanner below remains available for liquidation and protocol-observation compatibility while its feed adapters migrate. It is not the production boundary for new DEX route calculation.

Scanning is separate from execution. It needs a public Arbitrum RPC and no wallet, executor address, or private key. Create a secret-free configuration such as:

```json
{
  "chainId": 42161,
  "rpcUrl": "https://your-arbitrum-rpc.example",
  "startBlock": "123456789",
  "assetAllowlist": ["0x0000000000000000000000000000000000000001"],
  "protocols": {
    "aaveV3": { "pool": "0x0000000000000000000000000000000000000001", "multicall3": "0x0000000000000000000000000000000000000001", "healthBatchSize": 200 },
    "morphoBlue": { "blue": "0x0000000000000000000000000000000000000001" },
    "balancerV2": { "vault": "0x0000000000000000000000000000000000000001" },
    "uniswapV4": { "poolManager": "0x0000000000000000000000000000000000000001" }
  }
}
```

Run once or continuously:

```sh
node dist/cli.js scan --config scanner.json --once
node dist/cli.js scan --config scanner.json --watch
```

The scanner emits `schemas/scan-envelope.schema.json` records with typed candidates. Its intents describe protocol-specific requirements, including Balancer Vault callbacks and Uniswap v4 `unlock` delta settlement; they are not directly executable calldata.

When `protocols.aaveV3.multicall3` is configured, Aave account health is queried in bounded account batches (default 200) through that verified address. Legacy scanner configurations retain sequential reads for compatibility.

## Dynamic proposal bridge

`solve <solver-input.json> --config <solver-config.json>` turns a typed Aave or Morpho candidate and block-bound route quotes into an executor proposal. The solver configuration declares the executor and which capabilities are both enabled and fork-verified. A proposal is rejected if its evidence is stale, its quote exceeds the configured impact, its capability is unproven, or it cannot meet minimum net profit. Balancer v2 and Uniswap v4 observations remain non-broadcastable until their callback semantics are proven against an executor fork.

Every solve run appends a sanitized event to `.nim/memory.jsonl`; repeated reusable failure codes are promoted once to `.nim/lessons.jsonl`. Keys, endpoint credentials, signatures, raw calldata, and signed transactions are never recorded.

To run the opt-in live E2E without credentials, point `E2E_ARBITRUM_SCANNER_CONFIG` at a bounded scanner configuration and run `npm test`. The test asserts a real finalized-block envelope and accepts zero opportunities; it never signs or broadcasts.
