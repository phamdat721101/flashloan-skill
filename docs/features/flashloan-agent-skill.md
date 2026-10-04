# flashloan-agent-skill

## Client outcome

An operator can submit scanner-produced, executor-ready opportunities to one runtime that evaluates the approved borrow tiers, proves the selected transaction by exact simulation, and autonomously sends only a risk-compliant Arbitrum transaction.

## Audience

DeFi operators who control an Arbitrum executor contract and a dedicated wallet, and protocol engineers adding a strategy, provider, or chain adapter.

## Scope

- Arbitrum raw-call execution, typed configuration, risk gating, allocation selection, JSON opportunity ingestion, schemas, and unit tests.
- An installable `$flashloan-agent` prompt skill and package CLI that copies its own skill definition to the Codex skill directory.
- A local daily-loss ledger and cross-process execution lock for the autonomous execution path.
- Extension interfaces for additional chains, protocols, and scanner/data providers.

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
- Simulates exact executor calldata before every broadcast; only a configured wallet and verified executor permit autonomous execution.
- Broadcasts are Arbitrum-only in v1. Other chains require a registered connector and verified executor adapter.

## Data models

- `SkillConfig`, `Opportunity`, `AllocationPlan`, `SimulationResult`, `ExecutionDecision`, and `ExecutionReceipt` are defined in `src/types.ts` and mirrored in `schemas/`.

## Tracer-bullet path

1. Load validated configuration, collect candidates, build allocation plans, simulate the exact transaction, apply risk gates, broadcast, then audit the receipt.

## Acceptance criteria

- No secret value is logged or serialized.
- An executor call is sent only after bytecode and chain verification and an immediately preceding exact simulation.
- The $100k, $200k, and $500k borrow tiers, $2k gas cap, $10k daily-loss stop, and 200-bps price-impact cap are enforced unless overridden by configuration.

## Risks

- Quotes, gas, and state can change between discovery and inclusion. The raw-call executor repeats preflight immediately before send.
- A correct EVM simulation does not guarantee post-inclusion profit. Daily-loss, gas, price-impact, and minimum-profit gates bound the action.
- A connector may report an unsupported route. An unregistered chain or missing executor bytecode blocks the run.

## Rollout and rollback

Start with fixture opportunities and read-only simulation. Enable an operator wallet only after a verified executor address is configured. Roll back by removing `OPERATOR_PRIVATE_KEY` or `FLASH_EXECUTOR_ADDRESS`; the orchestrator then records decisions but cannot broadcast.

## Environment contract

`OPERATOR_PRIVATE_KEY` is a local secret and must never be copied into JSON, logs, or source control. `ARBITRUM_RPC_URL` must be an HTTPS endpoint. `FLASH_EXECUTOR_ADDRESS` must identify deployed bytecode on chain 42161. The runtime needs `NATIVE_TOKEN_USD` only for live gas-cost accounting.

## Post-delivery evidence

- `npm test` passes four fixture tests for configuration, allocation, simulation selection, and execution blocking.
- `npm run typecheck` passes.
- A production E2E must use a dedicated wallet and a verified executor, capture only transaction hashes and receipts, and never expose the private key.
