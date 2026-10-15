# Level 2 market-context implementation

Status: approved design and local implementation; production execution is not admitted.

## Client outcome

Ingest Arbitrum/Sui market evidence without social or news feeds; publish exact,
replayable market context to agents, evaluate forward outcomes without temporal
leakage, and optionally prioritize existing simulated atomic routes under fresh
state and risk admission. Market predictability remains an empirical result.

## Audience

Quantitative developers and operators of the existing liquidity runtime.

## Approved design

Extend the existing TypeScript liquidity engine for Arbitrum and Sui. Separate
observed facts, forward predictions and exact executable routes. No social/news
data, directional positions, new treasury policy or required runtime dependency.
The original `docs/level-2.md` is inspiration, not a protocol specification.

Fast Feed is provisional ordered/executed activity, not a mempool. Approvals are
permission, not sell intent. CLMM executable depth is not a resting order book.
Empty initialized-tick intervals do not imply zero active liquidity. Dux-inspired
thresholds are experimental; predictive scores require holdout and shadow-value
evidence before influencing execution. Full profit retains existing treasury
custody. Unknown state, debt, submission or P&L cannot acquire execution admission.

## Implementation plan

- [x] T1: strict versioned contracts and schema; tests reject malformed identities,
  unsafe timestamps, missing provenance and mixed units.
- [x] T2: separate evidence journal and reducers; replay, duplicate, divergent
  identity, torn-write, restart and consumer-offset tests.
- [x] T3: exact V2/V3/Cetus depth through existing quote math, DeepBook order depth,
  flow windows and bounded allowance capacity; independent numeric vectors.
- [x] T4: CLI and stdio MCP resource/tool access; real subprocess protocol tests.
- [x] T5: offline chronological prediction evaluation, leakage prevention,
  calibrated model artifacts and conservative admission; synthetic outcome tests.
- [x] T6: canonical-frame execution binding, persistent risk reflection, preserved
  runtime gates; assert zero sends for invalid or experimental evidence.
- [x] T7: five seam proofs, benchmarks, build/package checks, symbol compilation,
  scoped nim-deliver evidence and final handoff.

## System boundaries

Sources -> durable evidence -> coherent state -> features -> agent frame
                                                    -> validated prediction
                                                    -> existing route runtime

Canonical chain journals retain their existing contiguous-height contract.
Provisional and market observations have their own hash-linked journal. Derived
outputs are deterministic and replayable. Native amounts and nanosecond times are
decimal strings; exact ratios carry numerator/denominator. Missing values include
an explicit reason. USD conversions never establish execution economics.

## Research references

- https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/fast-feed
- https://docs.sui.io/develop/accessing-data/grpc
- https://docs.sui.io/onchain-finance/deepbook/deepbookv3/deepbook
- https://eips.ethereum.org/EIPS/eip-20
- https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/SqrtPriceMath.sol
- https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
- https://modelcontextprotocol.io/specification/2025-11-25/server/resources
- https://www.stevenduxi.com/blog/8-steven-dux-strategies-for-achieving-consistent-profits

## Gstack review decisions

Extend existing adapters/math/runtime; validate before live ranking; require
predictive lift and incremental net execution value; measure p95 local processing
against a 100 ms target; preserve full-profit treasury custody. Independent nested
Codex review was skipped by the Codex-host rule. Existing local/fork evidence is
not current feature production admission.

## Scope

The implementation lives beside the existing liquidity modules, exposed through
`npm run l2 -- <command> <config.json>`. Existing v3 source and v4 analytics inputs
retain their contracts. Level 2 has a separate 1.0 JSON Schema. Runtime changes
are an optional admission callback and propagation of digit-bearing error codes;
without that callback the signing/submission sequence retains its existing flow.

Supported canonical inputs are block-pinned V2/V3 EVM state and successful Swap
logs, checkpoint-pinned Cetus state and `pool::SwapEvent` BCS, or supplied complete
DeepBook input-fee book states and normalized trades. DeepBook has a pure book
adapter; this release does not include a new general-purpose on-chain book crawler.
V4 and Algebra retain existing capability restrictions. Standard-feed decoding
exposes sequencing hints, not a Nitro state replica. Fast Feed is a separate
provisional journal input; a disconnect requires canonical reconciliation.

## Non-goals

Directional inventory, social/news ingestion, autonomous production admission and a new signing service are outside this upgrade.

## Selected approach and why

Extend the existing TypeScript liquidity engine with canonical evidence and shadow-first context so exact simulation and custody gates remain authoritative.

## Contracts and exact units

`schemas/level-2.schema.json` covers observations, frames, predictions, outcomes,
models and evaluation reports. Runtime parsers additionally verify hashes, units,
identity/finality compatibility, parent links and consistency invariants.

| Contract | Binding and semantics |
| --- | --- |
| MarketObservation | source ID, generation, local cursor, logical event ID, chain identity/parent or external identity, event/receive nanoseconds, evidence reference, typed payload |
| MicrostructureFrame | immutable frame/state hashes, canonical identity, assets/decimals, source watermarks, complete/incomplete reasons, rolling windows and exact features |
| PredictionRecord | frame/model hashes, cutoff, chain/horizon, probabilities and expected gross markout; defaults to research-only |
| ForwardOutcome | exact future price/state, observation time, recomputed markout and independently supplied paired shadow values |
| EvaluationReport | dataset/model hashes, fold/sample/day/class counts, Brier baselines, day-bootstrap intervals and admission reasons |
| ExecutionContextBinding | exact candidate/frame, optional prediction/report plus explicit operator report pin, expiry and risk-sizing proof |

Native amounts, heights, cursors and nanoseconds are decimal strings. Ratios carry
integer numerator/denominator. Market prices use 1e9 fixed-point displayed price;
market quantity uses the explicitly bound base asset's decimals. Missing values
are `{ "value": null, "reason": "..." }`. No USD conversion authorizes execution.

## Metrics and labels

- Depth uses the smallest gross input reaching ±1%, ±2% or ±5% displayed
  token1/token0 price, including fees and directional integer rounding. Bounded
  inverse searches reuse existing V2/V3/Cetus projection. Missing tick coverage is
  unavailable, never zero. DeepBook depth sums live orders in each price band,
  includes input-fee economics and respects the existing 100-order scan ceiling.
- Skew is `(bidQuote - askQuote)/(bidQuote + askQuote)` at 2%. Zero total depth is
  unavailable. Bid depth is quote proceeds and ask depth is gross quote input.
- Signed successful pool trades produce rolling one-hour quote volume/VWAP and
  five-minute CVD. Pool-local multi-hop prints are not global unique volume.
- Buy-print decay compares the latest three-minute median against the preceding
  ten-minute median, requires three prints per window and publishes both counts.
- Turnover uses one-hour quote volume divided by the snapshot's actual V2 quote
  reserve or CLMM virtual quote reserve. DeepBook has no AMM denominator.
- Allowance capacity uses pinned current balances/allowances for the declared
  owner/router set, capped once per owner across routers. It is weak permission
  evidence, not pending order flow, and does not assume Permit2 coverage.
- Bid-depth reduction compares consecutive coherent relative-price bands. This
  describes changed executable depth, not proof that an LP intentionally pulled.
- Fresh external books can supply asset-matched market basis. Book and trade
  observations stay external, never canonical. Stale or mismatched assets disable
  the feature. Market basis participates in the versioned model feature vector.

Descriptive experimental thresholds: ASK_HEAVY at skew ≤−0.5; BUY_PRINT_DECAY
below 0.30; BID_DEPTH_WITHDRAWAL at ≥40% reduction; ALLOWANCE_CAPACITY_HIGH at
capacity/depth ≥1.2; HIGH_TURNOVER at ≥15. BUY_FLOW_LOW_IMPACT requires positive
CVD with non-increasing consecutive price. WEAK_REBOUND combines a positive
three-minute return, negative fifteen-minute return, below-VWAP price and recent
volume ≤35% of the preceding three minutes. These are observations, not causal
claims or fixed trading rules. Original ICEBERG/PRE_DUMP/SQUEEZE/VACUUM names are
superseded by these descriptive labels. A profitable route is established by the
existing exact simulation, never by a microstructure label.

## Journaling, recovery and retention

Raw and derived JSONL records are fsynced. Output and consumed input digest share
one durable record. Incremental readers validate only newly appended bytes;
startup replay validates complete segments. The local filesystem and cooperating
append-only writers are trusted: hashes detect corruption, not a malicious owner
rewriting an entire chain and its hashes. One writer lock protects each segment.

A source/generation cursor is contiguous inside its segment. Retransmitted logical
events preserve first arrival and do not generate new flow. A divergent parent or
height invalidates the active generation and records a typed rejection. A complete
replacement generation restarts warmup. Malformed or torn journals remain errors.

Defaults: 20 pools total, 10,000 retained observations per active pool, 100,000 rows
per raw segment, 4 MiB per record, 1,024 queued WebSocket messages, 100 MCP
subscriptions and 20 expiring evaluation requests. One-hour windows retain one
pre-window observation for warmup. All limit failures are explicit.

Close and rotate bounded segments explicitly. Supply ordered `closedJournalPaths`
to replay/serve/follow/inspect alongside the active `journalPath`; closed segments
seed rolling state before new records. Retention defaults to seven days for raw
segments and ninety for derived segments. `l2-retain` verifies declared closed
segment names/hashes and honors pinned hashes; dry-run is the default. Pin active
segments and every segment required by an evaluation dataset. Never prune a
segment still needed for replay. Data is stored under caller-owned paths; no new
top-level data directory is required.

## CLI and agent use

```sh
npm run l2 -- l2-sources
npm run l2 -- l2-follow follow.json
npm run l2 -- l2-replay replay.json
npm run l2 -- l2-inspect inspect.json
npm run l2 -- l2-serve serve.json
npm run l2 -- l2-evaluate evaluate.json
npm run l2 -- l2-benchmark benchmark.json
npm run l2 -- l2-retain retention.json
```

An exact replay configuration, after the observation journal exists:

```json
{
  "schemaVersion": "1.0",
  "journalPath": ".nim/l2/raw-0001.jsonl",
  "outputPath": ".nim/l2/frames-0001.jsonl"
}
```

For JSONL ingestion add `source: { "kind": "jsonl", "path": "incoming.jsonl" }`.
For Arbitrum use `source: { "kind": "arbitrum", "capture": ... }`, where capture
requires `rpcUrl`, `sourceId`, `generation`, `cursor`, `blockNumber`, the existing
V2/V3 `AnalyticsPoolConfig[]`, `allowanceOwners` and `routers`. A call captures one
explicit block; scheduling successive captures remains with the existing source
orchestration/agent. Pool code hashes and V2 fee revisions must be operator-pinned.

For Sui use kind `sui` with `rpcUrl`, `sourceId`, `generation`, `cursor`, the existing
checkpoint-proven object set and Cetus decode configs. The adapter reads checkpoint
time and committed event/effects bindings itself. Existing historical object
availability/proof restrictions still apply; no latest-state fallback is added.

Native streaming uses `fast-feed`, `binance` or `hyperliquid`, with `endpointEnv`,
`binding` and `maxMessages`. Bind source ID, generation, cursor and pool ID;
external feeds also bind `baseAsset`, `quoteAsset`, `baseDecimals`, and the exact
Binance `symbol` or Hyperliquid `coin`. Binance additionally requires
`snapshotEndpointEnv`; configure a combined depth/trade stream and its matching
REST snapshot. Fast Feed binds network 42161 and an address-to-pool-ID map. Endpoint
credentials remain in environment variables. Node 22+ native WebSocket is required
for streaming; other workflows support the existing Node 20 baseline.

Serve config contains schemaVersion/journalPath and optional closedJournalPaths
and riskJournalPath. The local stdio server implements MCP 2025-11-25 initialization,
resource reads/templates/subscriptions and tools. Notifications request a reread.
Tools inspect facts, request at most 30 seconds of shadow evaluation, or read risk
reflection. They cannot create a signer, authorize a send, change budgets or clear
a halt. An execution worker consumes `L2AgentServer.requests()` under operator
policy. Ranked resources are compact descriptive summaries, not live trade advice.

## Prediction validation and execution

`l2-evaluate` takes schemaVersion/datasetPath/chain/horizon. The dataset is bounded
JSONL of TrainingExample records (100,000 rows / 128 MiB total). Horizons are next
canonical block/checkpoint and 1/5/15 minutes. A next label requires the immediately
following height; timed labels tolerate at most 30 seconds of missing target state.
Missing future state stays unresolved. Mid-price markout never supplies shadow P&L.

Training uses regularized multinomial logistic regression, train-only normalization,
temperature calibration and a configurable flat band (10 bps default). Expanding
14/21/28-day training folds each have seven-day calibration and test windows.
Outcome availability purges boundary overlap. The model watermark includes every
calibration outcome; inference rejects cutoffs at or before it.

Compare Brier score with class frequency, depth skew and a CVD-sign momentum proxy.
Day-block bootstrap uses 1,000 deterministic resamples. Admission requires ≥42 days,
≥500 held-out observations, ≥14 distinct test days, nonempty folds, ≥10 examples per
class, positive lower 95% predictive improvement and positive lower 95% paired net
benefit in one profit asset. Net evidence must reference shadow-runtime candidates.
Reports remain untrusted until their exact hash is explicitly operator-pinned.
No real-market model is admitted by this implementation or its synthetic tests.

`runL2Candidates` preserves default ordering for experimental predictions. An
operator-pinned admitted report can prioritize evaluation; the existing runtime
still selects simulated native-unit net value. Canonical identity, frame/candidate
binding, expiry and freshness are checked. Auto mode additionally requires matching
durable risk state and pre-sized borrow limits. The optional runtime admission gate
rechecks risk and expiry immediately before signing and submission.

Reflection deduplicates receipts by lane and receipt digest. Revert/defect or >25 bps
unexpected slippage halves the sizing ceiling. Five distinct clean profitable
receipts restore it within operator limits. Unknown P&L persists a halt. Reflection
ingestion is an operator/runtime API; MCP only reads it. Existing loss budgets,
resource leases, exact payload/custody proofs, fee estimation and full-profit
treasury transfer remain authoritative.

## Alternatives considered

A separate Rust scanner, new storage services, direct label-driven sends and the
80/20 treasury split were rejected in the approved review. Existing bigint math,
file-backed evidence and execution gates provide a smaller auditable integration.

## Risks

Provider-supplied data and local content hashes do not authenticate a blockchain
against a dishonest provider. Protocol/package revisions, object coverage,
checkpoint retention and operator inputs require independent admission. Paid feed
access and subscriptions are not purchased. No runtime dependency was added. Ajv
is development-only. TLS validation is retained; insecure remote endpoints reject.
Optional endpoint environment names are documented in .env.example, without secrets.

## Environment contract

The local profile uses existing Node/TypeScript dependencies and optional endpoint bindings from .env.example. Native WebSocket streams require Node 22. No paid subscriptions or production credentials are required by local verification.

## Acceptance criteria

Run `npm run typecheck`, `npm test`, `npm run l2:test`, `npm run l2:proof`, strict
AS-SCP symbol compilation and the five System Map commands. The proof artifact
hashes current source/compiled files and a fresh test transcript; it fails if files
change during execution. All five local seams must pass. Benchmark reports p95
local feature processing against 100 ms separately from replay/startup and source
delay; a fixture result does not establish a production SLO.

## Post-delivery evidence

Verification: the full repository command passed with 165 Node tests passed and four existing optional skips. The fresh Level 2 proof covers 20 tests with no skips. A synthetic single-pool 120-frame replay measured 23.7 ms p95 local processing, 2.30 seconds total replay and 47.9 MB heap; this does not establish sustained watchlist throughput. Strict compilation verified 33 symbol dependencies without hallucinated symbols. Package dry-run and whitespace checks passed.

Local verification records are generated under .nim/e2e by npm run l2:proof and by the five approved System Map seam commands. These prove local contracts and failure handling; production source acceptance and market alpha remain unproven.

## Rollout and rollback

Start with read-only context and shadow routes. Public source acceptance, sustained
watchlist/load measurement, real historical prediction evaluation, explicit budgets
and per-adapter live receipts are required before production admission. Revoke a
report pin to remove predictive prioritization. Stop Level 2 processing to return
to the existing liquidity commands. Unknown effects never reset themselves.
