# flashloan-agent-skill

## Client outcome

An operator can submit executor-ready opportunities to one runtime that builds protocol-owned candidates, binds them to source and quote evidence, proves exact calldata twice, and autonomously sends only a risk-compliant Arbitrum transaction.

## Audience

DeFi operators who control an Arbitrum executor contract and a dedicated wallet, and protocol engineers adding a strategy, provider, or chain adapter.

## Scope

- Arbitrum raw-call execution, typed configuration, risk gating, allocation selection, JSON opportunity ingestion, schemas, and unit tests.
- An installable `$flashloan-agent` prompt skill and package CLI that copies its own skill definition to the Codex skill directory.
- A local daily-loss ledger, unknown-P&L halt, and cross-process execution lock for the autonomous execution path.
- Extension interfaces for additional chains, protocols, and scanner/data providers.
- A key-free Arbitrum scanner that indexes Aave v3, Morpho Blue, Balancer v2, and Uniswap v4 events from a configured start block, persists reorg-aware checkpoints, and emits versioned JSONL scan envelopes.
- A dynamic proposal bridge that accepts typed candidates and exact route evidence, enforces protocol close-factor/capability rules, and records sanitized run outcomes into local Nim memory.

## Non-goals

- Deploying, upgrading, or funding an executor contract.
- Generating private keys, discovering untrusted contracts, or treating an estimated profit as realized profit.
- Broadcasting during development or automated test runs.

## Alternatives considered

- Continue invoking the existing 2,621-line script directly: rejected because configuration, risk controls, and execution semantics cannot be tested independently.
- Rewrite every protocol scanner first: deferred because the stable opportunity contract allows scanners to migrate incrementally.

## Selected approach and why

Copy the proven execution boundary into a typed orchestrator and make scanners feed a common exact-calldata opportunity format. This preserves current strategy coverage while requiring all channels to satisfy the same bytecode, simulation, allocation, gas, and loss gates.

## System boundaries

- Reads on-chain data and quotes through registered chain, protocol, and data-provider connectors.
- The scanner is public-RPC-only and never builds a wallet client or sends a transaction. It emits typed protocol candidates and non-executable intents.
- Simulates exact executor calldata before every broadcast; only a configured local wallet that matches executor `owner()` permits autonomous execution.
- Broadcasts are Arbitrum-only in v1, through an explicit private relay. Other chains require a registered connector and verified executor adapter.

## Data models

- `AllocationPlan` carries capability, source/quote blocks, expiry, and optional P&L valuation metadata. `SimulationResult` and `ExecutionReceipt` include typed outcomes; unknown receipt P&L persists a safety halt.
- `ScannerConfig`, `ScanEnvelope`, `ScanOpportunity`, `ScanCandidate`, and `ScanIntent` are defined in `src/scan/` and mirrored by `scan-config.schema.json` and `scan-envelope.schema.json`. Amounts and block numbers are strings to preserve integer precision in JSON.
- `DynamicCandidate`, `RouteQuote`, and `DynamicSolverConfig` form the solver input contract. A proposal is eligible only after exact source/quote block evidence and a locally configured `enabled + forkVerified` executor capability.

## Scanner contract

`scan --config scanner.json --once` requires chain 42161, an HTTP(S) public RPC, a decimal `startBlock`, and protocol contract addresses. It polls finalized blocks only, validates its checkpoint hash before advancing, persists its discovered borrower universe, and records diagnostics instead of silently dropping RPC failures. With a configured `protocols.aaveV3.multicall3`, Aave health reads are split into account batches (default 200) instead of one RPC call per borrower. Aave and Morpho candidates include typed current position state; Balancer candidates describe Vault flash-liquidity; Uniswap v4 candidates describe `PoolManager.unlock` settlement requirements. Neither Balancer's callback flash loan nor v4 transient deltas are modeled as generic executor calldata.

## Dynamic solver contract

`solve <solver-input.json> --config <solver-config.json>` is the sole bridge from dynamic candidates to executable calldata. Aave sizing uses the current health-factor close-factor boundary; Morpho includes current market parameters and repayment/seizure quantities. Quotes carry router/approval targets, fee, input/output minimums, impact, calldata, and quote block. The bridge rejects unknown candidates, stale/expired evidence, unproven capabilities, route impact over the policy, empty split-route calldata, and insufficient profit. It writes sanitized events to `.nim/memory.jsonl` and only one deduplicated reusable failure pattern to `.nim/lessons.jsonl` per process.

## Tracer-bullet path

1. Load configuration, collect candidates, build dynamic plans, simulate, apply risk gates, re-check freshness and exact calldata, broadcast, then value the receipt or halt.

## Acceptance criteria

- No secret value is logged or serialized.
- An executor call is sent only after bytecode, chain, capability selector, owner, private-relay, and immediately preceding exact-simulation verification.
- Dynamic builders are the default. Legacy borrow tiers are opt-in through `BORROW_TIERS_USD`; gas, daily-loss, price-impact, block-freshness, and RPC-concurrency limits are configurable.

## Risks

- Quotes, gas, and state can change between discovery and inclusion. The executor rejects expired/block-stale proposals and repeats preflight immediately before send.
- A correct EVM simulation does not guarantee post-inclusion profit. Daily-loss, gas, price-impact, and minimum-profit gates bound the action.
- A connector may report an unsupported route. An unregistered chain or missing executor bytecode blocks the run.

## Rollout and rollback

Start with fixture opportunities and read-only simulation. Enable an operator wallet only after owner and private-relay verification. Roll back by removing `OPERATOR_PRIVATE_KEY`, `FLASH_EXECUTOR_ADDRESS`, or `PRIVATE_RELAY_URL`; the orchestrator then records decisions but cannot broadcast. An unknown-P&L halt also blocks later autonomous sends.

## Environment contract

`OPERATOR_PRIVATE_KEY` is a local secret and must never be copied into JSON, logs, or source control. `ARBITRUM_RPC_URL` and `PRIVATE_RELAY_URL` must be HTTPS endpoints. `FLASH_EXECUTOR_ADDRESS` is explicit configuration and must identify bytecode owned by the local signer on chain 42161. The runtime needs live valuation input for gas-cost and receipt P&L accounting.

## Post-delivery evidence

- `npm test` covers dynamic allocation selection, stale/capability rejection, simulation-only behavior, unknown-P&L halting, and typed execution outcomes.
- `npm run typecheck` passes.
- Optional `E2E_ARBITRUM_RPC_URL` validates the reviewed executor bytecode and owner ABI without signing. A funded dedicated-wallet broadcast remains a manual production acceptance step.
