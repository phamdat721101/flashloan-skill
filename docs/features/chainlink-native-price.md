# Chainlink native price for legacy orchestrator gas accounting

Status: Approved (eng review 2026-10-28, D1–D2)

## Problem

`NATIVE_TOKEN_USD` is a fixed operator number (`src/cli.ts:64`). `ArbitrumExecutorAdapter` and `ArbitrumReadOnlySimulator` (`src/arbitrum.ts:78,98,136`) multiply gas wei by it to get:

1. `SimulationResult.gasCostUsd`. The `risk.ts:18` gate rejects a plan when it exceeds `maxGasUsd`.
2. `ExecutionReceipt.realizedProfitUsd = netProfit × profitTokenUsd − gasCostUsd`. This feeds the daily loss ledger and the `maxDailyLossUsd` stop (`risk.ts:20`).

A stale value is safe only while ETH stays below it. Above it, gas is understated, P&L is overstated, and the loss stop trips late. Every other path in this skill (Rust scanner, `evm acceptance`, Aero live, `universe-probe`) already prices native gas from Chainlink via `priceUsdE8` (`src/evm-fees.ts:9`).

## Solution

Price native gas from a pinned Chainlink feed **at the block being valued**, with an L2 sequencer-uptime gate, using exact integer math. The source fails closed: there is no fallback to a static number.

```
simulate(plan):  block B ← latest; gasWei = estimate × gasPrice
                 quote = nativeUsd.quote(B)            ── fail → SimulationResult{ok:false, reason:'NATIVE_PRICE_UNAVAILABLE:<code>'}
                 gasCostUsdE8 = ceil(gasWei × priceUsdE8 / 1e18)
broadcast(plan): receipt at block R
                 quote = nativeUsd.quote(R)            ── fail → receipt.realizedPnlStatus='unknown' (existing halt path)
                 realizedProfitUsd = netProfit×profitTokenUsd − ceil(gasUsed×effGasPrice×priceUsdE8/1e18)/1e8
```

### Components (existing homes only)

| File | Change |
| --- | --- |
| `src/evm-fees.ts` | `quoteNativeUsd(client, policy, blockNumber)` → `NativePriceEvidence`. Reuses `priceUsdE8` for feed decimals, positivity, round completeness and age. It adds the sequencer gate (answer 0 = up, `block.timestamp − startedAt ≥ graceSeconds`) and `nativeCostUsdE8(wei, priceUsdE8)` with ceiling division. |
| `src/evm-chains.ts` | Arbitrum profile gains `nativeUsdFeed` and `sequencerUptimeFeed`. |
| `src/config.ts` | `SkillConfig.nativePrice` policy from env, with chain defaults. |
| `src/arbitrum.ts` | Both adapters take a `NativeUsdSource` (injected) instead of `nativeTokenUsd: number`. |
| `src/types.ts` | Optional `nativePrice` evidence on `SimulationResult` and `ExecutionReceipt`. |
| `src/cli.ts` | Stop requiring `NATIVE_TOKEN_USD`; `validate-config` reports the feed policy and flags the deprecated key. |
| `schemas/execution-receipt.schema.json` | Optional `nativePrice` object; existing receipts stay valid. |

### Input contract (config/env)

| Env | Default (Arbitrum 42161) | Validation |
| --- | --- | --- |
| `NATIVE_USD_FEED` | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` (ETH/USD, 8 dp) | address |
| `NATIVE_USD_MAX_AGE_SECONDS` | `90000` (86400 s heartbeat plus buffer; same as `arb.rs` `MAX_ORACLE_AGE_S`) | integer 60–90000 |
| `SEQUENCER_UPTIME_FEED` | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` | address, or `none` to disable explicitly |
| `SEQUENCER_GRACE_SECONDS` | `3600` | integer 0–86400 |
| `NATIVE_TOKEN_USD` | **deprecated, ignored** | `validate-config` warns if set |

Both feed addresses were verified live on 2026-10-28: ETH/USD answer $2,350.88 updated 44 s earlier; uptime answer 0, last status change about 160 days earlier.

### Output contract and data schema

```ts
interface NativePricePolicy { feed: Address; maxAgeSeconds: number; sequencerUptimeFeed: Address | null; sequencerGraceSeconds: number }
interface NativePriceEvidence {          // attached to SimulationResult.nativePrice and ExecutionReceipt.nativePrice
  feed: Address; priceUsdE8: string;     // decimal string, bigint-safe
  updatedAt: number; blockNumber: string; blockTimestamp: number;
  sequencer: { feed: Address; up: true; sinceSeconds: number } | null;
}
interface NativeUsdSource { quote(blockNumber: bigint): Promise<NativePriceEvidence> }
```

- `gasCostUsd` stays a `number` for `risk.ts`, derived as `Number(gasCostUsdE8) / 1e8`. The only float step comes after exact integer cost math.
- Failure codes are stable strings: `NATIVE_PRICE_STALE`, `NATIVE_PRICE_INVALID`, `SEQUENCER_DOWN`, `SEQUENCER_GRACE_PERIOD`, `NATIVE_FEED_UNREADABLE`.

### Failure behaviour

| Condition | Simulation | Receipt |
| --- | --- | --- |
| feed stale, non-positive or incomplete round | `ok:false`, plan rejected | `realizedPnlStatus:'unknown'`, the orchestrator halts the ledger |
| sequencer down, or up for less than the grace period | `ok:false` | `unknown`, halt |
| feed RPC error | `ok:false` | `unknown`, halt |

## Tests (behaviour-named)

- `quotes native USD at the valued block with exact ceiling gas math`
- `rejects stale, non-positive and incomplete rounds`
- `blocks while the sequencer is down or inside its grace period`
- `disables the sequencer gate only with explicit none`
- `config defaults to the Arbitrum feeds and rejects invalid overrides`
- `simulation fails closed when the native price is unavailable`
- `receipt P&L uses the receipt-block price and becomes unknown when it cannot be priced`
- `validate-config flags deprecated NATIVE_TOKEN_USD`

## E2E

1. Live read-only: `quoteNativeUsd` on Arbitrum at the latest block. Expect `priceUsdE8` within 1% of the Rust scanner's `ethUsd` and the sequencer up.
2. CLI: `node dist/cli.js simulate <opportunity>` with `NATIVE_TOKEN_USD` unset and the env sourced. The output must carry `nativePrice` evidence and no `NATIVE_TOKEN_USD` error.
3. Fail-closed path: unit tests with an injected source cover a stale feed, sequencer down and the grace period. No fork is needed because the gate logic is pure over the `latestRoundData` values.

## Eng review amendments (approved D1–D2)

- **D1, profit floor uses live gas:** `SimulationResult.expectedNetProfitUsd = quotedNetProfitUsd − gasCostUsd`, using the Chainlink-priced simulation. If a caller already netted gas, it is subtracted twice; on Arbitrum that costs cents, so the error is conservative. Test: `profit floor subtracts the live gas cost`.
- **D2, receipt valuation retries:** the receipt-block price read is retried up to 3 times about 1 s apart. Only a persistent failure marks P&L `unknown`, which halts as before. Tests: `transient receipt price failure recovers` and `persistent receipt price failure halts`.
- **Factual correction:** E2E item 3 was rewritten; injected-source unit tests cover the fail-closed paths.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex (skipped by user preference) | Independent 2nd opinion | 0 | skipped | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open → resolved | 3 issues (2 approved remedies, 1 factual correction), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | n/a (no UI) | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** Codex outside voice skipped per saved user preference.
- **VERDICT:** ENG CLEARED with approved amendments. Ready to implement.

NO UNRESOLVED DECISIONS
