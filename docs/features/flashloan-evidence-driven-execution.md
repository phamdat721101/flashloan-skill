# Flashloan evidence-driven execution: implementation companion

Status: specification package. Runtime changes, T01–T42, native parity and live admission remain pending. The owner selected full staged coverage, a corrected v5 contract, an atomic exact-unit caller migration, split verification caching and local plus per-lane execution gates.

Baseline: `671e5d3610a687b36af4bbc0d9602cecda42e07d`. The 23 file hashes in the [original PRD](../PRD-flashloan-evidence-driven-execution-upgrade-2026-10-26.md#appendix-a--verified-sourcedependency-inventory) matched at verification. Reverify hashes on every implementation branch. This companion supersedes the PRD's embedded **proposed** schema where the correction table below differs; the original PRD remains the requirements source. Neither document authorizes signing or trading.

## Client outcome

Given an explicit network, asset identities, approved profile and bounded search, the operator receives a reproducible executable candidate or a precise blocked/inconclusive/scoped-negative result. A future authorized trade must repay the lender, exceed the effective post-cost hurdle and reconcile all relevant assets. Missing evidence cannot become zero cost, profit, a successful simulation or a market-wide negative conclusion.

The core problem is evidence composition, not a missing arbitrage formula. Existing integer quote engines, state stores, simulation adapters and custody gates already solve much of the work. Agent reports and legacy sizing can lose the distinction between sampled and exhaustive search, modeled and native simulation, borrowed and deployed principal, or token surplus and operator P&L. This design makes those distinctions machine-checkable.

## Audience

TypeScript/Rust/Solidity/Move maintainers implement the stages below. Operators review policy, capabilities and admission evidence. Host agents use the supported entrypoint and retain artifact references; their narrative is never an execution proof.

## Scope

Specify all R01–R16 and T01–T42, with P0 correctness first, P1 integration second, and separate P2 capability increments. Deliver this brief, a strict standalone v5 JSON Schema, a hashed SpecEnvelope, an offline verifier and distinct specification/runtime System Maps. Existing production code and public wire contracts are unchanged by this specification delivery.

## Non-goals

Guaranteed profit, forced daily trades, subsidies hiding losing cycles, automatic rule activation, a new signing service, a replacement quote engine, unknown public-server edits or blanket cross-chain admission. No `bd-team` runtime import, new required dependency, deployment, public broadcast or credential access belongs to this package.

## Alternatives considered

- Narrative-only reporting cannot enforce lineage, conservation or termination.
- A replacement engine duplicates tested integer math and custody logic.
- A permanent floating-USD compatibility optimizer leaves two admission semantics. The owner selected migration of all its callers together.
- Extending existing engines through explicit v5 boundaries preserves working modules while fixing demonstrated seams. Selected.

## Selected approach and why

```text
request -> policy -> inventory -> canonical state -> exact quotes -> bounded search
   |          |           |               |                            |
   +----------+-----------+---------------+----------------------------+
                             typed failure/report
search -> plan -> exact payload -> native proof -> research report
                                      |
                         separate owner authorization
                                      v
                     existing admission/preflight/lock
                                      v
                       private submission -> receipt
                                      v
                          ledger -> report -> knowledge
```

Market acquisition, protected evidence storage, admitted signing and cited memory are separate trust boundaries. Reuse `SnapshotStore`, `projectPool`, CLMM/native quote math, `sizeRoute`, conditional sizing, `LiquidityRuntime`, `AttemptJournal`, existing EVM/Sui adapters and prediction admission. Do not infer additional support from a shared ABI or address.

### Public interfaces and compatibility

The [v5 schema](../../schemas/flashloan-evidence-v5.schema.json) is the authoritative proposed domain boundary. The [SpecEnvelope](flashloan-evidence-driven-execution.spec.json) pins existing exported symbols and contains shape fixtures; proposed symbols are explicitly listed as future interfaces, never supplied as already-resolved dependencies.

| Surface | Implementation decision |
| --- | --- |
| Legacy optimizer TypeScript API | Replace floating economics with exact amounts, expected state, attempt/deadline limits and cancellation; migrate `buildAdaptiveArbitragePlan` and both existing optimizer/arbitrage suites in the same PR |
| Existing 3.0/4.0/Level-2 1.0 | Preserve parsers and wire semantics; introduce named v5 translators, never relabel legacy objects |
| Public research MCP v2 | Preserve exact proof-envelope bytes and existing HMAC/registry/TTL checks; externally owned adapter must verify current service schemas |
| Local context MCP | Context/shadow only; it is not the external solver or a broadcaster |
| Execution | Route v5 through existing admitted adapters with separate authorization; no alternate signer or public-transport fallback |
| V5 disabled | No v5 hooks, artifact writes, report changes or additional admission capability; golden-test unchanged wire outputs. The approved optimizer TypeScript migration remains an explicit breaking interface change |

### Corrections to the PRD draft schema

| Correction | Exact contract |
| --- | --- |
| Missing native context | `RunRequest.caller` and `executor` are nullable public identifiers, required and validated for native simulation; `executorMode` is `existing` or research-only `fixture` |
| Prompt controls | Add nullable requested deployment/branch floors, principal/branch USD minima and inventory liquidity filter; `rotationMode=report-only`. Zero/absent economic floors remain optional profile choices |
| Early report | `Report.policyHash=null` is legal before compilation; a post-policy result must carry the computed hash. `SolverResult` is emitted only after policy and state exist |
| Discovery metadata | Preserve asset locators while `asset0/asset1`, adapter identity/revision and canonical identity may be null. Only verified metadata can feed quote-ready state |
| Attempt conservation | Add `Search.inflight`; require `accepted+rejected+inflight=attempted`, `attempted<=maxAttempts` and `uniqueAmounts<=attempted` |
| Search coverage proof | Add `domainEvidenceRef`, nullable `gridPointCount` and `certificateRef`; retain the actual declared grid/domain/evaluations and any independently verified skipped-region certificate |
| Effective policy identity | Bind `borrowAsset`, valuation/cost evidence refs, `minimumBranchRaw` and `maxTotalSwaps`; compile absolute branch minima explicitly instead of losing them during request translation |
| Execution lineage | Plan and NativeProof carry `executionContextHash`; Plan carries nullable `unsignedPayloadRef`, required before native simulation/admission |
| Ratio validity | Structural ratio denominators must be positive; economic valuation numerators must also be positive in semantic validation |

JSON Schema verifies shape, not truth. Cross-record joins, quantities, lineage, native fidelity and authority require the semantic validation below. Fixtures are documentation examples with configuration provenance; they are not native evidence.

### Stable prompt mapping

Map snake-case prompt fields explicitly: `asset_addresses -> assetLocators`, `borrow_asset -> borrowAsset`, `risk_profile_ref -> riskProfileRef`, `principal_cap_raw -> principalCapRaw`, `requested_min_profit_usd -> requestedMinProfitUsd`, `requested_price_impact_bps -> requestedPriceImpactBps`, `network_cost_evidence_ref -> networkCostEvidenceRef`, `valuation_evidence_ref -> valuationEvidenceRef`, `watch_duration_ms -> watchDurationMs`, `executor_mode -> executorMode`, `rotation_mode -> rotationMode`, `min_deployment_bps -> requestedMinDeploymentBps`, `parallel_branch_min_weight_bps -> requestedMinBranchWeightBps`, `min_principal_usd -> requestedMinPrincipalUsd`, `min_branch_usd -> requestedMinBranchUsd`. Map `unsigned_simulation` to `unsigned-simulation`, and `report_only` to `report-only`.

USD controls are exact ratios; raw controls are decimal strings. Do not silently accept JSON floating-point money. Addresses/types become locators first, then verified Asset metadata. `network` becomes the verified network ID, not an inferred default. Inventory filter `min_liquidity_usd` becomes `inventoryMinLiquidityUsd`. Unsupported controls return `POLICY_UNSUPPORTED`.

The standalone entrypoint to implement is `npm run liquidity -- evidence-run <request.json>`. It reads at most 4 MiB using the existing bounded reader, rejects extra arguments/unknown versions, and uses an explicitly configured host adapter. It never evaluates module paths or commands supplied by the request. Research is the default mode; native simulation needs public caller/executor context. No new execute flag is introduced. Internal execution consumes a separately authorized, validated runtime context.

### Stage inputs, outputs and failures

| Stage | Input | Output | Failure and recovery |
| --- | --- | --- | --- |
| Policy | RunRequest, immutable approved profile, adapter manifest | Policy, policyHash, inclusive native solver hurdle | INPUT_BLOCKED/POLICY_UNSUPPORTED; inventory may proceed |
| Discovery | Verified network/locators, explicit filter, bounded cursors | Inventory entries and provider scope/watermark | Retain rejected entries and unfinished pagination; never claim chain exhaustiveness |
| State | Verified descriptors, lender pin, canonical source cursor | StateBundle plus original proof-envelope artifact | STATE_DESYNC/STALE/COVERAGE_BLOCKED; bounded reacquisition |
| Quote/search | State, domain/quantum, complete costs, Policy, AbortSignal | SolverResult, optional Plan and attempt artifacts | INCONCLUSIVE or scoped negative; failures remain counted |
| Native | Exact Plan/payload, sender, executor identity | NativeProof, raw result ref, balance-basis evidence | Native revert/FIDELITY_INSUFFICIENT; no signing |
| Admission | Fresh proof, approved adapter, separate authorization | Existing locked attempt journal | Mismatch/expiry/revocation yields zero sign/submit calls |
| Reconcile | Receipt/effects, opening/prefund, gas and all asset deltas | Complete Ledger or unavailable ledger with reasons | PNL_UNKNOWN halts lane and retains recovery locks |
| Report | Deduplicated typed events and validated artifact joins | Report plus deterministic Markdown/CSV | No unchecked user-supplied success or manually entered metrics |
| Knowledge | Secret-free refs and verified episode | Cited observations and provisional learning proposals | SECRET_REJECTED/APPROVAL_REQUIRED/HANDOFF_REQUIRED |

### M0 — source and dependency freeze

Before modifying runtime, recapture the PRD inventory and every SpecEnvelope dependency as `(file, exported symbol, whole-file SHA-256)`. TypeScript dependencies must resolve in their declared file using the actual AST. Rust/Solidity/Move references require their native compiler/build checks; a regex or globally matching name is insufficient. The nim compiler's symbol membership check is supplemented with file-specific AST/hash validation.

Reproduce R01 using the current source transpiled in memory: bounds 1..100, six evaluations, peak at 50, undefined quote at 62. A host guard terminates after call 13; amount 62 repeats eight times. This is evidence of the defect, not a passing future regression. Freeze current wire outputs separately from that defect.

When M1 fixes that source, replace this baseline reproduction with verification of its archived artifact and a passing current regression. Review and refresh source pins during the migration; never preserve a defect merely to satisfy this frozen specification check.

### M1 — correctness: R01–R06 and R16

**R01: finite exact sizing.** Use one bounded sampling core. A quote contains requested amount, signed raw net after conservative external costs, price impact and exact expected state identity/digest. Validate all before ranking. Amounts are bigint internally; serialized money is a decimal string. A quote for another block/digest is rejected even if profitable.

Before each async call: validate amount/domain/quantum, check monotonic remaining time and AbortSignal, reject a previously attempted semantic amount, reserve an attempt and record its identity. Only explicit transient transport retries may revisit an amount, each consuming another attempt. Seed endpoints, protocol-supported analytic seeds and coverage boundaries; refinement must add an unseen executable amount or stop. Retry/backoff never resets the global budget. Undefined, malformed, thrown, timed-out and cancelled results have deterministic rejection codes. Rank by signed raw net with deterministic lower-principal tie-breaking.

Use timer cleanup in `finally`. Bound adapter work with AbortSignal and remaining-time timeout; ignore late completion. A timeout is a terminal rejected logical attempt, not a second accepted result. In-flight counts refer to attempts without a terminal disposition, not abandoned transport promises. Reuse the analytics worker isolation for CPU-bound quote paths; the supervising deadline terminates workers. No new worker framework is needed.

Migrate `SizingBounds`, `SizeQuote`, `SizeQuoter`, optimizer results and `ArbitrageQuote` together. Remove floating valuation from candidate ranking. Legacy `AllocationPlan` display fields may be derived only after exact admission and cannot feed a new v5 decision. Migrate the risk bridge to the compiled raw bound in the same release; do not pass rounded display USD back into authority checks.

**R02: search uncertainty.** `CANDIDATE_FOUND` means feasible, not globally optimal. A losing sample is `INCONCLUSIVE`. `NO_OPPORTUNITY_IN_GRID` requires all points of a named grid economically evaluated; `CERTIFIED_NO_OPPORTUNITY` requires every feasible quantum or a sound certificate covering skipped regions. Record domain bounds, quantum, grid/certificate artifact, evaluated-domain hash, coverage, attempts, rejections and termination. Tick/step/cost failures prevent a negative certificate. A noncandidate has `planRef=null`; absent selected outputs remain unavailable, not measured zero.

The domain evidence artifact contains the exact ordered grid/quantum domain and per-attempt raw amount, terminal disposition, economic result and evidence refs. Hash those canonical bytes as `evaluatedDomainHash`. A completed grid requires positive `gridPointCount` and that many accepted economic evaluations. Exhaustive certification requires accepted count equal to the feasible quantum count; a smaller count needs `certificateRef` whose skipped-region proof is independently checked by a supported certificate verifier. Unsupported proof types block certification.

**R03: policy.** Upper resource/risk limits take the minimum of request, profile and capability. Required lower safety/profit bounds take the maximum. Economic utilization/branch floors are zero/absent unless approved; an infeasible profile is reported, not overridden. Preserve the installed $10 floor. Protocol constants and deployment pins remain versioned facts, including DeepBook revision math. Prices, mutable fees and capacity come from same-state evidence.

For hurdle `Hn/Hd` USD and conservative lower USD/token `Ln/Ld`, with token decimals `d`:

```text
exclusive minProfitRaw = floor(Hn * Ld * 10^d / (Hd * Ln))
inclusive solver minimum = minProfitRaw + 1
admission = rawNet > minProfitRaw AND rawNet > 0
```

Validate nonzero denominators and positive `Ln`. Add one exactly once. Cost conversions round upward using a conservative upper bound. Never assume a stablecoin price of $1. Recheck state/fees/costs near preflight; changed economic inputs require a new plan/proof, not an invisible payload edit.

**R04: evidence.** Reuse SHA-256 of recursively sorted object keys with array order preserved. A record self-hash excludes only its named self-hash property. Policy hashing includes effective limits, profile/authorization refs and mode, excluding `policyHash` and observational `runId`; Plan hashing excludes only `planHash`. State hashing covers the declared canonical identity, ordered descriptors and evidence bindings, not public envelope reconstruction. Context hashing covers namespace/network, caller, executor, native value, executor mode and code/package revision. Payload hashing covers exact adapter-defined unsigned bytes. Declare the algorithm/version in the artifact manifest; reject alternate serialization.

Store raw bytes with exclusive create, protected permissions, fsync and atomic publication to content-addressed custody. Verify existing bytes on collision and reject mismatch; references never authorize arbitrary path reads. Persist original public envelopes byte-for-byte. NativeProof needs matching candidate/state/policy/context/payload/executor/revision and unexpired native-simulation evidence, successful execution/repayment and supported balance basis. Model/fixture/checklist text cannot populate an actionable native success. Preserve raw revert evidence; no guessed named error.

**R05: ledger.** For one borrow asset, require:

```text
principal = deployed + unused
terminalBeforeDebt = swapProceeds + unused  # swapProceeds excludes unused
surplusAfterDebt = terminalBeforeDebt - principal - loanFee
simulatedNet = surplusAfterDebt - networkCost - otherExternalCosts
```

An after-debt report is normalized only with explicit balance-basis evidence. Embedded fees/impact are already in swap proceeds. Opening executor funds and operator prefund are preserved/excluded, never strategy revenue. Keep native gas deltas alongside evidenced conversion. Multi-asset execution must close every debt and reconcile all residual inventory. A complete Ledger requires complete terms; otherwise Report has no fabricated ledger, and events retain the unresolved inputs. Realized net needs the matching reconciled receipt and cost evidence; unknown P&L halts further lane sends.

**R06/R16: supported workflow and prompt.** Route through the existing CLI/runtime and explicit host adapter registry. Remove installed mandatory large-borrow/fixed-weight recipes while preserving historical deployment facts. Keep the PRD's stable prompt prefix byte-identical within a round; append dynamic packets. Enforce force-trade, ignored-profit and fresh-token adversarial cases with tool-call transcripts. Public discovery maps `asset_addresses` to its actual `tokens` field. Unknown tool/provider/argument/schema is rejected, not guessed.

### M2 — market integration: R07–R10

**R07: observed flow.** Extend SourceJournal/EvidenceJournal/L2ContextEngine with canonical parent, source generation/cursor, event identity, transaction/log or object ordering, event/receive timestamps and invalidation. Replay coherent before/after frames, deduplicate events and invalidate gaps/reorgs/finality downgrade. Static concentration is descriptive, not observed flow or intent. Existing same-pair dislocations may be evaluated without waiting for an external trigger. Entry bands bind route/state/cost/size hashes; no timeless 40-tick or $100k trigger.

**R08: depth and identity.** Verify namespace, network, address/type, decimals and behavior. Native/wrapped and bridged/native assets remain distinct. Normalize B-per-A prices using exact reserve or sqrt-price ratios, inverting explicitly; never compare raw cross-quote ticks. Reuse integer crossing/fee-dust logic and independent math vectors. Expand tick/bitmap/order coverage only within approved RPC/byte/step budgets; report unresolved frontier instead of extrapolating. Preserve revision-specific Aero/Algebra/DeepBook fee behavior.

**R09: graph and splits.** Build directed edges only from verified metadata, adapter revision and canonical state. Enumerate bounded simple closed cycles in both directions under profile hops/branches/swaps limits. Necessary price/fee screens prioritize only. Evaluate endpoints, V2 analytic seeds and executable boundaries, then finite refinement. Equal marginal output is a seed only for independent concave branches; discrete/nonconcave cases require bounded subset/allocation search. Allow zero/one branch, no fixed 52/44 split or forced utilization. Initial raw allocations plus unused equal principal exactly; later hops consume actual outputs. Shared pools replay one ordered mutated state and then full native simulation, otherwise reject. Compare direct/hub/split controls at matched state, asset and principal after all incremental costs.

**R10: funding and costs.** Verify lender deployment/code, asset, callback support, live fee and usable capacity at the candidate state. Preserve immutable registry pins. Never map local Morpho to an unsupported public enum. Include simulation gas, dynamic fees, applicable L1 publication/data charges and known transfer/external costs. Missing/stale values block actionable net. Zero-cost controls are labeled research-only. Status remains unsupported until separately verified; its adapter must use `linea_estimateGas` with `from`, returned fees and fresh gasless/premium handling.

### M3 — operations: R11–R14

**R11: forecasting.** Allowance is permission capacity, not pending order flow. Join real swaps/orders to pre-state with complete horizons, event ordering, owner/spender/Permit2 attribution limits and censoring reasons. Preserve existing chronological split/purge/bootstrap and approved model/report binding. Zero positive labels means recall unavailable. Require held-out incremental net utility versus an unpredicted matched control before influencing evaluation order. Forecasts never override exact simulation or custody.

**R12: reporting.** Append StageEvent records, then derive Report/Markdown/CSV from validated joins. Maintain run ID, candidate ID, chain-local transaction identity and separate global audit identity. Persist report/receipt deduplication across restart. Include all discovered/rejected candidates in denominators and explicit unavailable reasons. A no-send research completion is not a successful trade. `SIMULATED_OPPORTUNITY` requires an existing-native proof, complete ledger and qualifying net; `RECONCILED` requires matching receipt reconciliation. Native revert, coverage block and inconclusive outcomes preserve their actual source classes.

**R13: recovery.** Preserve AttemptJournal nonce/object locks and prepare/sign/submit/unknown/reconcile transitions. Persist signed transaction identity before submission. On timeout/restart, query the same transaction/nonce/object state; never rebuild a second economic send merely because the response was lost. Keep unresolved attempts reserved and lanes halted until reconciled. Reorg/checkpoint object-version changes invalidate proof bindings. Private transport failure or revoked admission stops sends; no fallback or custody weakening.

**R14: knowledge.** Use an explicit host adapter, not subprocess commands assembled from evidence. Record safe source IDs/hashes before redaction; payloads stay protected. Legacy `confidence:8` events are episodes/claims, not proven rules. Ingest -> propose exact immutable citations -> validate -> commit observations. Inferences stay provisional. Procedures need committed successful verification and owner approval. Missing host capability returns HANDOFF_REQUIRED. Unsupported sources or secrets fail closed; safe bounded excerpts may retain exact citations without weakening filters.

Cache only immutable validations under source/state/policy/adapter/schema/code/verifier hashes plus TTL where relevant. The generic nim output/strategy cache is insufficient evidence of live freshness. Always rerun mutable head, fee, authorization, expiry and receipt checks near admission. Stable prefix equality does not prove provider cache savings. Preserve bounded query -> hydrate and AS-SCP overview -> graph -> hydrate; failed graph hydration uses verified partial source reads and an intervention record.

### M4 and R15 — proof, capability admission and rollout

Use no new runtime service or dependency. P2 adapters are independent increments, each with schema/math/native/canary evidence and explicit lane admission. Existing public research gates for Sui/Robinhood remain until the actual affected surface passes. Local implementations do not establish public service support. External public MCP ownership is a dependency: return HANDOFF_REQUIRED until its owner supplies the current schema/envelope contract; core work does not guess a server repository.

## Acceptance criteria

The SpecEnvelope contains all 42 PRD assertions, each linked to R01–R16, an implementation stage, responsible subsystem, test destination, executable verification command and expected evidence. Every implementation acceptance starts `pending`; the specification verifier never promotes it.

Specification proofs run with `npm run evidence:spec`. They check:

| Edge | Executable specification proof | Structured marker |
| --- | --- | --- |
| EDGE-01 | Corrected v5 fixtures, strict unknown-field/money rejection, complete record examples | FLASHLOAN_SPEC_EDGE_01_SCHEMA |
| EDGE-02 | Actual legacy defect reproduction, finite host guard and honest search/certificate semantics | FLASHLOAN_SPEC_EDGE_02_SEARCH |
| EDGE-03 | Independent ledger/threshold/conservation arithmetic and evidence binding mutations | FLASHLOAN_SPEC_EDGE_03_ECONOMICS |
| EDGE-04 | File-specific AST/hash dependencies and complete R/T traceability | FLASHLOAN_SPEC_EDGE_04_DEPENDENCIES |
| EDGE-05 | Executable spec map, Draft runtime map, release gates and prompt mappings | FLASHLOAN_SPEC_EDGE_05_HANDOFF |

Future runtime E2E must use the supported entrypoint, actual existing executor and a deterministic local lender/pool deployment to perform borrow -> swaps -> repay -> custody -> receipt -> report. Constructed liquidity is labeled. Include losing cycles and zero-send failures, plus restart and response-loss injection. Deployment-only E2E is insufficient. Pinned forks need exact chain/block/hash, selected-revision quote parity, nonzero swaps and authenticated debt/custody assertions. Authorized live canaries additionally require final receipts and conservative realized costs; no natural-profit claim follows from a constructed fork.

```text
Local E2E entrypoint
  request -> policy -> acquisition -> exact search -> native full transaction
     | missing/forged/stale/cancelled                   | revert/under-hurdle
     +-------------------- zero sends -----------------+
                          |
                 separately authorized local lane
                          v
                 lock -> sign -> submit -> receipt -> ledger -> report
                                  | lost response / crash
                                  v
                 restart -> same attempt identity -> reconcile or halt
```

Runtime EDGE-01 drops acquisition mid-response; EDGE-02 hangs/rejects a repeated quote; EDGE-03 changes state/policy/shared-pool order at preflight; EDGE-04 injects oversized/malformed/float/forged input; EDGE-05 loses a successful submit response and crashes the reporter. Require the PRD's `FLASHLOAN_EDGE_01_NETWORK_DROP` through `FLASHLOAN_EDGE_05_RECOVERY` markers with exact assertions, artifact hashes and command exit status. No sign/submit call is allowed on missing evidence/authority.

Run focused Node suites for each change, then `npm run typecheck`, `npm run build`, `npm run liquidity:test`, `npm run l2:test`, `npm run evm:test`, `forge test` and `npm test` as affected. Fork/canary gates remain explicit per-lane opt-ins. Preserve existing ABI parity checks and Rust workspace checks. Capability manifests and schema adapters are required release artifacts.

## Risks

Market scarcity can produce valid no-trade results. Partial depth and incomplete costs limit economic conclusions. Cache reuse, evidence class promotion and ambiguous principal basis can invalidate a positive claim. Concurrent state changes and unknown sends require durable locks. External service ownership can delay that adapter without blocking local work. Mitigate with bounded search, exact lineage, per-asset conservation, immutable artifacts, strict admission and per-lane release evidence; no probability or profit forecast is implied.

## Rollout and rollback

M0 pins source/fixtures; M1 implements P0; M2 adds coherent flow/depth/routes/costs; M3 adds reports/recovery/knowledge; M4 proves local/native/fork/canary behavior. Additional capabilities require separate admission. Each PR owns its mapped tests. Atomic optimizer caller migration occurs in M1, never via a permanent float facade.

Version-select v5 through an approved profile. Before rollback stop new admission, reconcile pending attempts, then select the previous lane/version. Keep receipts, unknown attempts, artifact bytes and ownership approvals. Never erase recovery state. Specification completion and runtime completion use separate maps; runtime status stays Draft until actual implementation, required approval and evidence exist.

## Environment contract

Specification verification requires Node 20+, existing TypeScript and Ajv development dependencies; it performs no RPC, signing, deployment or environment-file sourcing. Nim verification uses the explicit installed CLI/library adapter and a local secret-free delivery profile. No new package is installed. Generated compilation, traces, episodes and delivery evidence stay under ignored `.nim/` or `.nim-memory/`.

Implementation retains Rust, Foundry and Sui toolchains. Native WebSocket features retain their documented Node 22 requirement. Endpoint/relay/valuation bindings use secret-free placeholders with verified TLS hostname/SAN and bounded payloads. HTTP is restricted to local rehearsal. The public service adapter must not acquire credentials, disable TLS or silently change transport. No network scan or fork is authorized by a spec check.

## Post-delivery evidence

The offline verifier emits five specification-only markers and checks the recorded baseline hashes, corrected schema, arithmetic, dependency pairs, complete R/T traceability and delivery separation. Nim-harness wraps these commands with strict result enforcement, classified errors, errors-only compaction, verification cache and cited knowledge. A failed verifier cannot be accepted because its output is nonempty.

Nim-deliver's specification profile validates this brief, local environment contract, actual workrule entry, executable spec edges and post-delivery evidence. Runtime readiness remains independently rejected while its map is Draft and edge proofs are absent. Record actual interventions and verification episodes, propose reusable learning with immutable citations, and leave procedures unapproved. Handoff includes changed files, source hashes, verified commands/artifacts and pending runtime gates only.

## GSTACK REVIEW REPORT

| Review | Runs | Status | Findings and decisions |
| --- | ---: | --- | --- |
| Architecture | 1 | Reviewed | Corrected request/report/context/inventory contracts; preserve original public envelopes |
| Code quality | 1 | Reviewed | Owner selected atomic exact-unit optimizer/caller migration; reuse existing engines |
| Tests | 1 | Reviewed | Owner selected full local trading E2E plus per-lane native/fork/canary gates |
| Performance | 1 | Reviewed | Owner selected immutable verification cache with fresh mutable admission checks |
| Independent model | 0 | Skipped | Running under Codex; no independent confirmation claimed |

VERDICT: specification package only; implementation and live admission require their mapped executable evidence. No durable procedure or safety-rule change is approved by this review.

NO UNRESOLVED DECISIONS
