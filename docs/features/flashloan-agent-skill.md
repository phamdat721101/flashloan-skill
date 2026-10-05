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

## Rust/Alloy live-route engine

`cargo run --locked --release -p flashloan-daemon -- replay <engine.json> <events.jsonl>` is the new deterministic scanner and routing boundary. It is wallet-free: it consumes a feed adapter's normalized JSONL, maintains only in-memory live pool state, and emits versioned JSONL candidates. It never treats a persisted checkpoint or prior replay as executable state.

`engine.json` is strict `schemaVersion: "2.0"` JSON. It requires chain `42161`, explicit V2/V3/V4 factory descriptors, `risk.maxHops` from 2 through 6, `maxStateAgeMs`, decimal-string USD E8 liquidity/canary limits, `execution.minProfitWei`, and an executor address/runtime code hash/current selector. Its relay section permits only `rpc-send-raw-transaction` with an environment-variable name for the URL; it does not serialize endpoint credentials or private keys.

The replay input accepts these camel-case JSONL records:

```json
{"eventType":"head","head":{"source":"canonical|sequencer","sequence":1,"blockNumber":123,"blockHash":"0x...","parentHash":"0x...","observedAtMs":0}}
{"eventType":"poolUpsert","pool":{"id":"...","venue":"uniswap-v2|uniswap-v3|uniswap-v4","venueId":1,"token0":"0x...","token1":"0x...","state":{"kind":"v2|v3|v4-discovery-only"}}}
{"eventType":"scan","anchorToken":"0x...","amountIn":"1000000","nowMs":0}
```

Both head sources are mandatory. Equal canonical/sequencer hashes are `CANONICAL_LIVE`; one sequencer child of the canonical hash is `TENTATIVE_LIVE`; a sequence regression, hash mismatch, parent mismatch, or stale latest observation becomes `RESYNC_REQUIRED`/`STALE_LIVE_STATE` and emits no candidate. V2 uses checked U256 constant-product arithmetic. V3 executes only when the adapter supplies the full current tick interval; any quote that crosses the supplied limit is rejected. V4 pools are discovered but cannot quote.

Affected pools are searched as bounded, simple 2–6-hop cycles. All route amounts are decimal strings. Two-hop candidates are encoded into the existing `executeDexPairArbitrage` ABI layout using Alloy primitives and carry `executorCalldata`; longer candidates are kept for analysis with `EXECUTOR_CAPABILITY_UNAVAILABLE`, because the reviewed executor ABI cannot safely represent arbitrary multi-hop calls. The Rust daemon currently builds calldata but does not sign, simulate, or submit; the existing manifest-gated TypeScript execution path remains the only broadcast boundary until an Alloy relay/simulation adapter and fork proof are added.

Rust evidence is `cargo test --workspace --locked`: core tests cover U256 V2 pricing, live-head reconciliation, V3 bounds, configuration/relay rejection, route executability, and ABI word layout. The daemon replay integration test covers two ingress heads, pool JSON decoding, an affected two-hop opportunity, and calldata emission. The separate opt-in fork and live-read-only E2E requirements below remain mandatory before moving submission ownership from the existing adapter.

## Unified scheduler, private relay, and executor-v2 implementation specification

### Outcome and non-negotiable invariants

The next release turns the current read-only DEX bridge into a second `OpportunityProvider` for `FlashloanOrchestrator`. Liquidation and DEX plans are discovered concurrently, normalized into the existing block-bound `AllocationPlan`, simulated under one concurrency limit, risk-evaluated once, and globally ranked once. The scheduler submits at most one winner per run.

The runtime must never compare values from different heads, silently replace a failed private submission with a public RPC send, or select a plan from an unproven executor. Decimal values remain strings at every JSON boundary; native token quantities, block numbers, gas, and profit floors remain decimal integer strings. `bigint` conversion happens only after validation.

```
finalized liquidation scan ─┐
                            ├─ provider discovery ─┐
head-pinned DEX bridge ────┘                        │
                                                     ▼
                      AllocationPlan[] → bounded exact simulation
                                                     │
                                                     ▼
                    common risk gate → deterministic global winner
                                                     │
                         read-only / simulate / relay submit mode
                                                     ▼
                executor-v1 or pinned executor-v2 → receipt → P&L ledger
```

`bridge` stays wallet-free in `read-only` mode. It may produce candidates and plans, but can never send. `run` consumes the bridge provider only when `scheduler.mode` is `simulate` or `relay`; relay mode additionally requires the operator key, executor manifest, and a verified relay protocol capability.

### Inputs, outputs, and schemas

The implementation extends `SkillConfig` with a `scheduler` section and adds a secret-free `executorManifest` file. `bridge-config.schema.json` gains a `targetTokenDecimals` integer for each pair; current code incorrectly uses `flashTokenDecimals` to value first-leg target output, so this field is required before DEX plans can enter the global winner calculation.

```json
{
  "scheduler": {
    "mode": "read-only | simulate | relay",
    "maxCandidates": 100,
    "cycleTimeoutMs": 12000,
    "headPolicy": "latest-head",
    "singleWinner": true
  },
  "executorManifest": {
    "version": "v1 | v2",
    "address": "0x...",
    "runtimeCodeHash": "0x...",
    "abiVersion": "semver",
    "capabilities": {
      "dex-pair-arbitrage": { "selector": "0x....", "forkVerified": true }
    }
  },
  "relay": {
    "protocol": "rpc-send-raw-transaction",
    "url": "https://...",
    "targetBlockOffset": 1,
    "maxInclusionBlocks": 1
  }
}
```

`relay` and `OPERATOR_PRIVATE_KEY` are forbidden in `read-only` and optional in `simulate`. Relay configuration is valid only with HTTPS, `targetBlockOffset >= 1`, `maxInclusionBlocks >= 1`, and a manifest whose code hash and capability selector match chain state. There is no generic "private relay" claim: the first supported protocol is an explicitly tested signed-raw-transaction RPC method. Other relay methods require a separate typed adapter and an integration test before configuration can enable them.

The scheduler normalizes both sources to this internal contract. It is not a JSON API; its JSON representation converts every `bigint` to a decimal string.

```ts
type CandidateSource = 'liquidation' | 'dex-pair-arbitrage';
interface ScheduledPlan {
  source: CandidateSource;
  plan: AllocationPlan;
  head: { number: bigint; hash: Hex };
  quoteBlocks: bigint[];
  quotedNetProfitUsdE8: bigint;
  minProfitWei: bigint;
  correlationId: string;
}
interface SchedulerDecision {
  correlationId: string;
  planId?: string;
  source: CandidateSource;
  status: 'rejected' | 'simulated' | 'selected' | 'submitted' | 'included' | 'halted';
  reasonCodes: string[];
  expectedNetProfitUsdE8?: string;
  gasEstimateWei?: string;
  sourceBlock: string;
  quoteBlock: string;
}
```

The global winner ordering is stable: highest simulated `expectedNetProfitUsd`, then lower gas estimate, then lexicographic plan ID. Before comparison it rejects a plan when its chain, source block, quote block, head hash, expiry, native minimum-profit floor, capability selector, executor manifest, or maximum price impact is invalid. The final relay preflight fetches a new head, rejects any proposal outside `maxProposalBlockAge`, repeats the exact call and gas estimate, and re-applies the same risk gate. A preflight result is never reused across cycles.

### Components and exact changes

1. Add a `DexBridgeOpportunityProvider` beside the existing provider adapters. It calls `runDexBridge` only for head-pinned discovery, converts only `ready` bridge results into `AllocationPlan` values, and retains the candidate head hash, oracle block, quote blocks, fixed-point profit fields, and reason codes. It must use `targetTokenDecimals` for first-leg value and reject a DEX candidate whose oracle, quote, or block hash is absent or mismatched.
2. Extract candidate collection from `FlashloanOrchestrator.run` into a small scheduler boundary that accepts `OpportunityProvider[]`. Reuse `mapBounded` for simulation. Keep the present single winner and `DailyLossLedger` behavior; do not create a parallel DEX sending loop.
3. Add a `RelayClient` interface and make `ArbitrumExecutorAdapter.broadcast` delegate to it after final preflight. The adapter signs locally, submits only through the configured relay adapter, polls the relay/inclusion result for the configured block window, and returns typed `RELAY_REJECTED`, `RELAY_TIMEOUT`, or `RELAY_INCLUDED` outcomes. It must never call the public RPC sender as fallback.
4. Add `ExecutorManifest` validation before both simulation and relay submission: chain ID, deployed bytecode, runtime code hash, ABI version, `owner()`, configured selector, and fork verification are checked. `ArbitrumReadOnlySimulator` remains the walletless path and gains the same manifest validation.
5. Add executor-v2 as a new deployment, not an in-place upgrade of v1. V2 must expose version/manifest-compatible capability selectors, enforce `minProfit` after repayment and fees, restrict venues/tokens/fee tiers to an allowlist, clear approvals or use exact approvals, emit a versioned execution event with `netProfit`, and preserve owner-only entry points. Deployment records the address, code hash, constructor configuration, artifact hash, and fork proof in a checked-in non-secret manifest. Existing v1 remains selectable until v2 has passed fork proof; no proxy upgrade is permitted.
6. Add `scheduler --config <runtime.json> --once` for one complete cycle. It emits `SchedulerDecision[]`, never a signed transaction. Add `execute-scheduled --config <runtime.json> --once` only for relay mode. Both commands reject contradictory flags, such as `--execute` with bridge-only/read-only configuration.

### Execution state machine and failure policy

```
DISCOVER → BUILD → SIMULATE → RISK_APPROVED → SELECTED → FINAL_PREFLIGHT
  │           │          │              │              │             │
  └───────────┴──────────┴──────────────┴──────────────┴──→ REJECTED
                                                               │
FINAL_PREFLIGHT → RELAY_SUBMITTED → INCLUDED → RECEIPT_VALUED
                    │                │              │
                    └→ RELAY_TIMEOUT ┴→ HALTED      └→ PNL_UNKNOWN → HALTED
```

RPC timeouts in discovery or simulation are classified retryable only within the current cycle deadline. Reorg, stale block, selector/code-hash mismatch, failed exact call, relay rejection, expired proposal, and unknown realized P&L are non-retryable for that proposal. An inclusion timeout creates a `RELAY_TIMEOUT` decision and does not resubmit until a new discovery cycle produces a fresh plan. The daily loss limit and unknown-P&L halt apply equally to liquidation and DEX sources.

### Delivery sequence

1. Correct target-token valuation and add fixed-point unit coverage before enabling bridge plans in the scheduler.
2. Introduce the normalized provider and scheduler in `simulate` mode. Demonstrate mixed liquidation and DEX fixtures, bounded parallel simulation, deterministic tie-breaking, and exactly one winner.
3. Implement relay abstraction plus a local fake relay integration test. Enable only `rpc-send-raw-transaction`; reject every unregistered protocol and prove no public-RPC fallback occurs.
4. Implement/deploy executor-v2 to a local Arbitrum fork, generate the immutable manifest, and mark `forkVerified` only from that proof.
5. Enable opt-in fork E2E, then manually approve one dedicated-wallet private-relay acceptance. Production activation remains a configuration change after all evidence is recorded.

### E2E evidence matrix

The E2E suite is opt-in and must make no mainnet state change. `E2E_ARBITRUM_RPC_URL` supplies a read-only archive-capable endpoint; `E2E_EXECUTOR_MANIFEST` supplies the reviewed manifest; `E2E_BRIDGE_CONFIG` supplies a secret-free bounded pair list. Tests skip with an explicit reason when any input is absent, never silently pass.

- A live-head bridge test asserts a single block number/hash is used by exact quotes and Chainlink reads, accepts zero profitable candidates, and proves that no wallet client is constructed.
- A local Anvil fork test pins the same block, impersonates only the executor owner, funds only the fork account, verifies v1/v2 manifest code hash and selector, and runs exact `eth_call` plus gas estimation for an allowed liquidation and DEX plan. It never forwards a transaction to the upstream RPC.
- A mixed-provider scheduler test holds two valid plans at the same head and proves globally highest simulated net profit wins, independent of provider completion order. It also proves stale/reorged/over-impact plans cannot win.
- A fake HTTPS relay test records the exact configured relay method and signed payload shape, returns accepted/rejected/timeout responses, and proves the public RPC transport receives no send request in all three cases.
- A receipt valuation test decodes v2’s event, subtracts actual receipt gas, records known P&L, and persists a halt when event data or USD valuation is absent.

Completion requires `npm test`, `npm run typecheck`, `cargo test --workspace --locked`, `nim-skill search compile --title "Flashloan scheduler delivery spec" --spec docs/features/flashloan-agent-skill.spec.json --root .`, `nim-skill deliver verify --map docs/features/flashloan-agent-skill-map.md`, and the opt-in fork suite with all five structured edge markers. A real relay submission is a manual, separately authorized acceptance step, not an automated test.

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
