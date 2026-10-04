---
name: flashloan-agent
description: "Operate the installed Arbitrum flashloan runtime from a user prompt: validate configuration, inspect opportunities, simulate exact executor calldata, and report or execute risk-approved trades. Use only when the user explicitly requests flashloan analysis or execution."
---

# Flashloan Agent

Use the installed `flashloan-agent` package. It is self-contained: never read, import, or run code from `bd-team/scripts`.

## Prompt workflow

Interpret the request as one of these operations:

- **status/configure**: run `node dist/cli.js validate-config`; report whether a wallet, executor, and private relay are configured, without printing a secret.
- **scan**: run `node dist/cli.js scan --config <scanner-config.json> --once` for a key-free, public-RPC scan. The result is a `ScanEnvelope` JSON line, not executor calldata. Use `--watch` only when the user asks to keep monitoring. Never add `--live` or `--execute` to scan.
- **solve**: run `node dist/cli.js solve <solver-input.json> --config <solver-config.json>` to build only block-bound, capability-proven Aave/Morpho proposals. Report blocked candidates as decisions, not as failures to bypass.
- **simulate**: accepts only schema-valid, executor-ready opportunity JSON. Run `node dist/cli.js simulate <opportunities.json>`; it never sends a transaction.
- **execute**: only after the user explicitly asks for autonomous execution and the environment supplies `OPERATOR_PRIVATE_KEY`, `FLASH_EXECUTOR_ADDRESS`, `PRIVATE_RELAY_URL`, and live valuation input. Run `node dist/cli.js execute-auto <opportunities.json>` and report the decision and receipt. Never fall back to a public transaction endpoint.

The runtime verifies executor bytecode, chain ID, ABI selector, and `owner()` signer; requires every split to total 10,000 bps; enforces gas/price-impact/daily-loss limits; rejects stale proposals; and repeats the exact simulation immediately before broadcast. Unknown receipt P&L halts future autonomous sends until reviewed.

## Constraints

- Secrets stay in the local environment. Never request, print, store, or place a private key in a prompt, JSON file, or response.
- Never construct calldata for an address other than the explicitly configured `FLASH_EXECUTOR_ADDRESS`.
- Scanner findings are observations or validated intents, not permission to execute. Balancer v2 flash-loan callbacks and Uniswap v4 `unlock` delta settlement require a separately capability-verified executor transformer.
- Treat a quote, simulation, or estimated profit as non-final. Report failures and rejections verbatim enough for the operator to act on them.
- Do not deploy contracts, change risk limits, or bypass the execution lock unless the user expressly asks.

## Installation

From the package root, run `npm install`, `npm run build`, then `flashloan-agent install`. The installer copies this skill to the Codex skills directory. Invoke it as `$flashloan-agent` in a prompt.
