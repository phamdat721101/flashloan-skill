---
name: flashloan-agent
description: "Operate the installed Arbitrum & Sui flashloan runtime and liquidity-pattern pipeline from a user prompt: validate configuration, inspect opportunities, ingest pool snapshots, simulate exact executor calldata, and report or execute risk-approved trades. Use only when the user explicitly requests flashloan analysis or execution."
---

# Flashloan Agent

Use the installed `flashloan-agent` package. It is self-contained: never read, import, or run code from `bd-team/scripts`. Build the Rust workspace with the pinned toolchain before using the live route engine.

## Evidence-driven workflow (prompt version 6)

Use the stable prompt in `skills/flashloan-agent/prompt-v6.md` (pinned by SHA256 in `config/flashloan-versions.json`; a mismatch fails closed with `CAPABILITY_UNSUPPORTED`). Keep its prefix unchanged during a round and pass only a `flash-run-request/1` packet as dynamic input (`schemas/flashloan-v6.schema.json`, unknown keys rejected). Research and unsigned simulation do not authorize signing; `mode: execute` is a request, never authority, and no request can lower the owner floor. `prompt-v4.md` remains for 5.0/5.1 `evidence-run` requests. `evidence-integrity <round-directory> [--previous <round-directory>]` is read-only.

### v6 round

`node --env-file=.env dist/liquidity/cli.js evidence-gap-run <flash-run-request.json> [--movers <movers.json>]` with `FLASHLOAN_EVIDENCE_HOST_FILE` set to a `gap-host/1.0` file whose options share one owner-approved profile (`policy_ref.hash` = `sha256:` + digest of that profile). `--movers` takes hypermove `flashloan_get_token_movers` output (`flashloan.movers.v1`, bare or inside the public response). Output adds `candidates` counts, `coverage` and `ledgerPath`: a `candidate-ledger/1` where every requested token ends `EVALUATED` (a route containing it was actually quoted), `REJECTED`, `DEFERRED_BUDGET`, `INCOMPLETE_DATA` (e.g. `NOT_IN_CAPTURED_STATE`: capture its pools) or `UNSUPPORTED`. Price gaps only rank; overlapping or CLMM route subsets get bounded unequal-split refinement and never claim a global optimum. Live receipts reconcile only when the EVM adapter's `reconcileAccounts` is configured; `UNKNOWN` or `MISMATCH` halts the lane.

Watch only included canonical swaps, then reacquire state and solve. Hypothetical entry bands rank observations; they are not proof or execution authority. Require exact costs, ledger conservation, native fidelity and pre-save integrity. Preserve incomplete searches and unavailable inputs. No principal floor, utilization target, fixed split weight or additional hop is mandatory.

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

For the historical liquidity upgrade, use `LIQUIDITY_UPGRADE_DEPLOYMENT` from `src/contracts/flash-executor.ts`: executor `0xba4681b7cae1a67c703f43f1476b25fef2635b0a` and V4 state quoter `0x552d73e6b424b98a9d74fb335e62ee198d0601ad`. The record includes verified code hashes and Aave/V2/V3/V4/Morpho/Balancer pins. Prepare unsigned Morpho/Balancer trades with `prepare-arbitrum`, then integrate `ArbitrumLiquidityExecutionAdapter` with `LiquidityRuntime`; these are separate from the legacy opportunity CLI. Historical `MULTI_VENUE_EXECUTOR_DEPLOYMENT` and `DYNAMIC_V4_EXECUTOR_DEPLOYMENT` records remain revoked for V4. Deployment metadata does not admit trading; retain fresh simulation, canary evidence, explicit execution authorization and budget gates. See the README's liquid-pattern flashloan workflow.

Historical deployment evidence (not an operating recipe): `ArbitrumMultiSplitFlashExecutor` at `0xb1aac2079c52fd31e038ec348505a0f55859d60f` (deploy tx `0x0996d0328a43ae3f23cb5d0297c76292d910f59a88a1276c928578a52010f5ef`). This deployment was exercised with Morpho Blue funding and multi-pool routing across non-USDC assets (WETH, ARB, USDT on PancakeSwap v3, Camelot v3, Uniswap v3), dynamic intermediate balance unwinding, and atomic profit verification. Live verified on Arbitrum One at Block #513468682 (tx: `0xa27982015c84388c2e9a41993a937d5fa227ff76017ff6ea60ce1da10767733c`).

The runtime verifies executor bytecode, chain ID, ABI selector, and `owner()` signer; requires every split to total 10,000 bps; enforces gas/price-impact/daily-loss limits; rejects stale proposals; and repeats the exact simulation immediately before broadcast. Unknown receipt P&L halts future autonomous sends until reviewed.

## Base and Robinhood

Use the shared EVM CLI `node dist/evm/cli.js` and chain-specific manifests in
`config/base-mainnet.json` and `config/robinhood-mainnet.json`. The host adapter
is Node/viem; Rust `deploy-evm` explicitly delegates to it. The legacy Arbitrum
opportunity signer remains Arbitrum-only. Never reuse an Arbitrum deployment or
ABI pin for a new chain. Read `docs/features/evm-flashloan.md` for exact schemas,
receipt evidence, budgets, recovery and current admission status. The EVM adapter
is `EvmLiquidityExecutionAdapter`; its old Arbitrum export remains compatible.

## Dynamic pool universe

When the user asks to scan or analyse pools beyond WETH/USDC:
1. Call `flashloan_discover_arbitrage_pools` for the network with the policy's asset tokens, and save the raw response unchanged to `.nim/universe/raw-<network>.json`.
2. Run `node dist/evm/cli.js universe --inventory … --policy config/<network>-asset-policy.json --out .nim/universe/<network>.json`.
3. Report `pairs`, `rejected` reasons and `topGaps`. Never treat MCP `price_usd`/`liquidity_usd` or an unverified pool as execution input.

## Constraints

- **Level 2 context:** use `node dist/liquidity/cli.js l2-sources` to inspect actual
  capabilities and `l2-follow|l2-replay|l2-inspect|l2-serve|l2-evaluate <config.json>`
  for evidence ingestion, replay, facts, local stdio MCP or offline research. Inputs
  use `schemas/level-2.schema.json`; see `docs/features/level-2.md` in the source repo.
  Missing coverage, stale state and unvalidated predictions must remain explicit.
  Fast Feed is ordered/executed provisional activity, not a mempool. MCP staging
  requests shadow evaluation only; it never authorizes signing. Integrate through
  `runL2Candidates` only with existing adapter admission and operator budgets;
  predictive ranking additionally requires an exact operator-pinned report.

- Secrets stay in the local environment. Never request, print, store, or place a private key in a prompt, JSON file, or response.
- Bind calldata to the explicitly configured executor and its matching ABI/runtime hash. `FLASH_EXECUTOR_ADDRESS` belongs to DexPair; portable split hosts use their own explicit executor binding. Never substitute an address or reinterpret one capability as another.
- Scanner findings are observations or validated intents, not permission to execute. Balancer v2 flash-loan callbacks and Uniswap v4 `unlock` delta settlement require a separately capability-verified executor transformer.
- Treat a quote, simulation, or estimated profit as non-final. Report failures and rejections verbatim enough for the operator to act on them.
- Do not deploy contracts, change risk limits, or bypass the execution lock unless the user expressly asks.

## Installation

From the package root, run `npm install`, `npm run build`, `cargo build --locked --release -p flashloan-daemon`, then `node dist/agent-cli.js install`. The installer copies this skill to the agent skills directories. Invoke it as `$flashloan-agent` in a prompt.

## Shared local runtime and verified deployments

For every agent host, use the single installed runtime at `~/.flashloan-agent/flashloan-skill`. The CLI does not automatically load its .env: start in that directory and use Node's explicit loader, for example `cd ~/.flashloan-agent/flashloan-skill && node --env-file=.env dist/cli.js validate-config`. Use the same loader for `dist/sui/cli.js` and `dist/evm/cli.js`. EVM signing commands additionally require the explicit `--env-file .env` argument. Keep the private file local; do not copy secrets to skills or reports.

Arbitrum DexPair uses FLASH_EXECUTOR_ADDRESS=0x093e98a6e2e278426adc7161b61bb2132e0ad192; the latest portable split replacement uses MULTI_VENUE_EXECUTOR_ADDRESS=0x1df55df59413e823d2bbd926ee76c9a3fd63c478 for its inherited MultiVenue entrypoints. The earlier MultiVenue v2 at 0x2502539753df1182f015378f32fbdef0ec9c9de2 remains a rollback address. They have different ABIs. Base and Robinhood chain-specific addresses and pinned code hashes are in `docs/deployments/base-executors.json` and `docs/deployments/robinhood-executors.json`; Base Aero v2 is in `config/aero-base-executor-v2.json`. Select the matching manifest and chain; never reuse Arbitrum FLASH_EXECUTOR_ADDRESS on another chain. Sui uses the active package and capabilities in the shared .env. Existing execution admission, fresh verification and canary gates remain in force.

## Price-gap engine v5.2

Use `node --env-file=.env dist/liquidity/cli.js evidence-gap-run <request.json>`
for multi-funding research. Validate `GapRunRequest` against
`schemas/flashloan-evidence-v5.2.schema.json`; provide the nested 5.2 request,
owner-approved profile, asset/lender allowlists, per-option principal caps and
bounded attempts/deadline. The configured `FLASHLOAN_EVIDENCE_HOST_FILE` uses
`gap-host/1.0` and `funding-snapshot-file`; it does not sign or send transactions.
Existing 5.0/5.1 requests retain their policy semantics. No fixed large principal,
$10 floor, 18% weight or added hop is mandatory in the opt-in 5.2 engine; an
approved owner limit still binds. Use `universe --cycles` when singleton edges
are needed for mixed-quote cycles.

The Arbitrum `PortableMultiSplitFlashExecutor` at
`0x1df55df59413e823d2bbd926ee76c9a3fd63c478` has runtime hash
`0xa86825585912690c2d008410bf9315f8691ee0ffcad92f6e390b774ab05d89bb`
and split selector `0xec01ba1f`. It permits up to eight branches of six hops,
with Morpho/Balancer split loans and inherited linear Morpho/Balancer/Aave routes.
The deployment and ten trust roots are recorded in
`docs/deployments/arbitrum-price-gap-executor-20261028.json`. Read current finality
from that record or fresh RPC; do not reuse an earlier finality claim.

Native hosts use `runGapEvidence()` with explicit `funding`, `captureFunding`,
`compileFunding` and `simulateFunding` adapters. Bind the selected option, state,
policy, exact payload and executor code before existing execution admission.
`CANDIDATE_FOUND` is research evidence, not authorization. Repayment, external
costs, opening custody, nonce/budget locks and receipt reconciliation remain
mandatory. Deployment itself does not admit a live strategy. See the README's
latest-upgrade section for installation, verification and ABI selection.
