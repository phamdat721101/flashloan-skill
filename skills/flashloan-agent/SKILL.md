---
name: flashloan-agent
description: "Operate the installed Arbitrum & Sui flashloan runtime and liquidity-pattern pipeline from a user prompt: validate configuration, inspect opportunities, ingest pool snapshots, simulate exact executor calldata, and report or execute risk-approved trades. Use only when the user explicitly requests flashloan analysis or execution."
---

# Flashloan Agent

Use the installed `flashloan-agent` package. It is self-contained: never read, import, or run code from `bd-team/scripts`. Build the Rust workspace with the pinned toolchain before using the live route engine.

## Prompt workflow

Interpret the request as one of these operations:

- **live-route replay**: run `cargo run --locked --release -p flashloan-daemon -- validate-config <engine.json>` or `... replay <engine.json> <live-events.jsonl>`. This is wallet-free and emits JSONL only. It requires matching canonical and sequencer state; any desync, stale state, or unknown route capability is a blocked decision, never permission to send.
- **status/configure**: run `node dist/cli.js validate-config`; report whether a legacy wallet, executor, and private relay are configured, without printing a secret.
- **scan**: run `node dist/cli.js scan --config <scanner-config.json> --once` for a key-free, public-RPC scan. The result is a `ScanEnvelope` JSON line, not executor calldata. Use `--watch` only when the user asks to keep monitoring. Never add `--live` or `--execute` to scan.
- **solve**: run `node dist/cli.js solve <solver-input.json> --config <solver-config.json>` to build only block-bound, capability-proven Aave/Morpho proposals. Report blocked candidates as decisions, not as failures to bypass.
- **simulate**: accepts only schema-valid, executor-ready opportunity JSON. Run `node dist/cli.js simulate <opportunities.json>`; it never sends a transaction.
- **execute**: only after the user explicitly asks for autonomous execution and the environment supplies `OPERATOR_PRIVATE_KEY`, `FLASH_EXECUTOR_ADDRESS`, `PRIVATE_RELAY_URL`, and live valuation input. Run `node dist/cli.js execute-auto <opportunities.json>` and report the decision and receipt. Never fall back to a public transaction endpoint.
- **liquidity pipeline**: run `npm run liquidity -- <command>` (or `node dist/liquidity/cli.js <command>`) for key-free, reproducible state capture, ingestion, and replay:
  - `sources`: inspect registered source capabilities and supported chain adapters.
  - `snapshot-arbitrum <source-config.json>`: fetch block-pinned Arbitrum V2 pool snapshots with runtime code hash validation and state digests.
  - `checkpoint-sui <source-config.json>`: fetch checkpoint effects pinned to full Base58 genesis digest.
  - `ingest-arbitrum` / `ingest-sui <source-config.json>`: backfill consecutive ranges into a durable fsynced source journal (`SourceJournal`).
  - `follow-arbitrum` / `follow-sui <source-config.json>`: continuously poll and commit heads to durable journals with bounded gaps.
  - `state-sui <source-config.json>`: deterministic checkpoint effect replay and tracked object state recovery without RPC.
  - `replay <snapshots.jsonl>`: replay source snapshots through `SnapshotStore`.
- **exact clmm & execution adapters**:
  - `src/liquidity/clmm.ts`: exact CLMM tick-crossing and bitmap quotes for V3 and static no-hook V4; fails if tick horizon is exhausted.
  - `src/liquidity/arbitrum-execution.ts` (`ArbitrumLiquidityExecutionAdapter`): simulation, attempt custody, local signing, raw broadcast, and receipt/effects reconciliation for Arbitrum.
  - `src/liquidity/sui-execution.ts` (`SuiLiquidityExecutionAdapter`): simulation, gas-object version reservation, attempt custody, local signing, raw broadcast, and receipt/effects reconciliation for Sui.
  (Note: Execution adapters are library exports for the durable runtime; they are not auto-send CLI commands.)

For the latest liquidity upgrade, use `LIQUIDITY_UPGRADE_DEPLOYMENT` from `src/contracts/flash-executor.ts`: executor `0xba4681b7cae1a67c703f43f1476b25fef2635b0a` and V4 state quoter `0x552d73e6b424b98a9d74fb335e62ee198d0601ad`. The record includes verified code hashes and Aave/V2/V3/V4/Morpho/Balancer pins. Prepare unsigned Morpho/Balancer trades with `prepare-arbitrum`, then integrate `ArbitrumLiquidityExecutionAdapter` with `LiquidityRuntime`; these are separate from the legacy opportunity CLI. Historical `MULTI_VENUE_EXECUTOR_DEPLOYMENT` and `DYNAMIC_V4_EXECUTOR_DEPLOYMENT` records remain revoked for V4. Deployment metadata does not admit trading; retain fresh simulation, canary evidence, explicit execution authorization and budget gates. See the README's liquid-pattern flashloan workflow.

For >= $100,000 multi-pool split and multi-hop triangular arbitrage, use `ArbitrumMultiSplitFlashExecutor` at `0xb1aac2079c52fd31e038ec348505a0f55859d60f` (deploy tx `0x0996d0328a43ae3f23cb5d0297c76292d910f59a88a1276c928578a52010f5ef`). It supports 0%-fee Morpho Blue flash loans >= $100k (e.g. 40 WETH), convex multi-pool routing across non-USDC assets (WETH, ARB, USDT on PancakeSwap v3, Camelot v3, Uniswap v3), dynamic intermediate balance unwinding, and atomic profit verification. Live verified on Arbitrum One at Block #513468682 (tx: `0xa27982015c84388c2e9a41993a937d5fa227ff76017ff6ea60ce1da10767733c`).

The runtime verifies executor bytecode, chain ID, ABI selector, and `owner()` signer; requires every split to total 10,000 bps; enforces gas/price-impact/daily-loss limits; rejects stale proposals; and repeats the exact simulation immediately before broadcast. Unknown receipt P&L halts future autonomous sends until reviewed.

## Constraints

- Secrets stay in the local environment. Never request, print, store, or place a private key in a prompt, JSON file, or response.
- Never construct calldata for an address other than the explicitly configured `FLASH_EXECUTOR_ADDRESS`.
- Scanner findings are observations or validated intents, not permission to execute. Balancer v2 flash-loan callbacks and Uniswap v4 `unlock` delta settlement require a separately capability-verified executor transformer.
- Treat a quote, simulation, or estimated profit as non-final. Report failures and rejections verbatim enough for the operator to act on them.
- Do not deploy contracts, change risk limits, or bypass the execution lock unless the user expressly asks.

## Installation

From the package root, run `npm install`, `npm run build`, `cargo build --locked --release -p flashloan-daemon`, then `node dist/agent-cli.js install`. The installer copies this skill to the agent skills directories. Invoke it as `$flashloan-agent` in a prompt.
