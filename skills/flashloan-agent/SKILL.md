---
name: flashloan-agent
description: "Operate the installed Arbitrum flashloan runtime from a user prompt: validate configuration, inspect opportunities, simulate exact executor calldata, and report or execute risk-approved trades. Use only when the user explicitly requests flashloan analysis or execution."
---

# Flashloan Agent

Use the installed `flashloan-agent` package. It is self-contained: never read, import, or run code from `bd-team/scripts`.

## Prompt workflow

Interpret the request as one of these operations:

- **status/configure**: run `node dist/cli.js validate-config`; report whether a wallet and executor are configured, without printing a secret.
- **scan**: run `node dist/cli.js scan --config <scanner-config.json> --once` for a key-free, public-RPC scan. The result is a `ScanEnvelope` JSON line, not executor calldata. Use `--watch` only when the user asks to keep monitoring. Never add `--live` or `--execute` to scan.
- **simulate**: accepts only schema-valid, executor-ready opportunity JSON through the existing `run` path and therefore requires the configured executor and operator account used by its exact preflight.
- **execute**: only after the user explicitly asks to execute and the environment supplies `OPERATOR_PRIVATE_KEY`, `FLASH_EXECUTOR_ADDRESS`, and `NATIVE_TOKEN_USD`. Run `node dist/cli.js run <opportunities.json>` and report the decision and receipt.

The runtime evaluates the configured borrow tiers, verifies executor bytecode and chain ID, requires every split to total 10,000 bps, enforces gas/price-impact/daily-loss limits, and repeats the exact simulation immediately before broadcast.

## Constraints

- Secrets stay in the local environment. Never request, print, store, or place a private key in a prompt, JSON file, or response.
- Never construct calldata for an address other than `FLASH_EXECUTOR_ADDRESS`.
- Scanner findings are observations or validated intents, not permission to execute. Balancer v2 flash-loan callbacks and Uniswap v4 `unlock` delta settlement require a separately capability-verified executor transformer.
- Treat a quote, simulation, or estimated profit as non-final. Report failures and rejections verbatim enough for the operator to act on them.
- Do not deploy contracts, change risk limits, or bypass the execution lock unless the user expressly asks.

## Installation

From the package root, run `npm install`, `npm run build`, then `flashloan-agent install`. The installer copies this skill to the Codex skills directory. Invoke it as `$flashloan-agent` in a prompt.
