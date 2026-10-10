---
name: flashloan-agent
description: "Operate the installed Arbitrum flashloan runtime from a user prompt: validate configuration, inspect opportunities, simulate exact executor calldata, and report or execute risk-approved trades. Use only when the user explicitly requests flashloan analysis or execution."
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

For authenticated V2/V3/V4 routes, use the checked-in `MULTI_VENUE_EXECUTOR_DEPLOYMENT` record from `src/contracts/flash-executor.ts`: address `0xd130b45b7e7d08fb7dbb1c79fa5d9b95ea8e27b2`, deployment transaction `0x566b9d729cefe4af9f11a2673f15ab7cee8ae8c9c449276890c49d41391d6568`, and the `multi-venue-arbitrage` capability. Do not substitute the legacy or V4-only executor record, and do not treat this record as permission to execute without the normal simulation and explicit-user-approval gates.

For >= $100,000 multi-pool split and multi-hop triangular arbitrage, use `ArbitrumMultiSplitFlashExecutor` at `0xb1aac2079c52fd31e038ec348505a0f55859d60f` (deploy tx `0x0996d0328a43ae3f23cb5d0297c76292d910f59a88a1276c928578a52010f5ef`). It supports 0%-fee Morpho Blue flash loans >= $100k (e.g. 40 WETH), convex multi-pool routing across non-USDC assets (WETH, ARB, USDT on PancakeSwap v3, Camelot v3, Uniswap v3), dynamic intermediate balance unwinding, and atomic profit verification. Live verified on Arbitrum One at Block #513468682 (tx: `0xa27982015c84388c2e9a41993a937d5fa227ff76017ff6ea60ce1da10767733c`).

The runtime verifies executor bytecode, chain ID, ABI selector, and `owner()` signer; requires every split to total 10,000 bps; enforces gas/price-impact/daily-loss limits; rejects stale proposals; and repeats the exact simulation immediately before broadcast. Unknown receipt P&L halts future autonomous sends until reviewed.

## Constraints

- Secrets stay in the local environment. Never request, print, store, or place a private key in a prompt, JSON file, or response.
- Never construct calldata for an address other than the explicitly configured `FLASH_EXECUTOR_ADDRESS`.
- Scanner findings are observations or validated intents, not permission to execute. Balancer v2 flash-loan callbacks and Uniswap v4 `unlock` delta settlement require a separately capability-verified executor transformer.
- Treat a quote, simulation, or estimated profit as non-final. Report failures and rejections verbatim enough for the operator to act on them.
- Do not deploy contracts, change risk limits, or bypass the execution lock unless the user expressly asks.

## Installation

From the package root, run `npm install`, `npm run build`, `cargo build --locked --release -p flashloan-daemon`, then `flashloan-agent install`. The installer copies this skill to the Codex skills directory. Invoke it as `$flashloan-agent` in a prompt.
