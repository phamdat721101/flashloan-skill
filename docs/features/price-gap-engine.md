# Multi-pool price-gap engine: implementation specification

Status: Implemented and verified for constructed local execution. Full five-pattern implementation scope authorized by the owner with “do implement”. Public adapter admission, pinned public forks and live trading remain separate verification gates.

## Outcome and interpretation

Upgrade the existing evidence engine to find, size and execute economically positive closed cycles across multiple pools, quote assets and lenders. “Slow profit” is interpreted as small positive net profit; watcher latency is also addressed. No profitable trade is guaranteed. Remove arbitrary strategy floors, preserve exact repayment, cost, freshness, capability and authorization requirements. Initial executable adapters target existing EVM chains; Ethereum requires explicit chain capability admission. XRPL and Sui are separate execution domains, never legs of an atomic EVM flashloan. XRPL support remains a separately admitted adapter work item, not implied by an EVM solver.

Source: `docs/price-gap.md`, sections 1–8, all five patterns, sample implementations, tool contracts and SQL proposal reviewed. Treat its numerical speed/market claims as unverified targets. The proposed `packages/flashloan-mcp-server` and `native-gap-engine` layout is not this repository's current layout. Extend existing modules before adding native services or dependencies.

## Verified current state and barriers

| Evidence | Current behavior | Required change |
|---|---|---|
| `src/evidence/economics.ts:25–30` | Positive USD threshold and `larger({numerator:'10',denominator:'1'},...)` force $10 | Allow zero nonnegative owner profit floor, remove hidden $10; retain strict net > floor |
| `src/evm/pool-universe.ts:150–173` | Same-pair groups require two pools; returned pools are filtered by those groups | Preserve trusted singleton edges for cycles; keep pair view for compatibility |
| `src/evidence/solver.ts:18–57` | Bounded routes, uniform principal samples, only single/two branch schedules | Add pattern seeds, bounded general branch allocation and fair asset/lender scheduling |
| `src/evidence/runtime.ts:12–19,39–58` | Capture returns one asset/lender; maximum 16 coherent canonical pools | Add multi-funding orchestration outside existing single-attempt path; deterministic graph partitions |
| `src/liquidity/sizing.ts:124–150` | V2 stationary seed already exists; sampled search is explicit | Reuse seed and exact projector, avoid parallel float-only pricing engine |
| `src/liquidity/clmm.ts:39–126` | Q96 exact-input and tick walking already exist | Reuse with explicit tick coverage and adapter identity |
| `src/aero/types.ts:23–33,98` | Borrow asset is already parameterized, lender and cost bound | Connect dynamic discovery to it; do not claim dynamic borrowing is wholly absent |

Memory evidence recalled and hydrated: `src-260c0dc0270d1bed26f3b22dd094bbf4:chunk:12` requires exact cost attribution, coherent state and no sampled negative certificate; `src-36d546486cf18c32c81bc4f04ff9ff2b:chunk:0` records conservative double gas subtraction in an existing integration. Reconfirm these against current code before fixing that particular integration. Memory is evidence, never execution authority.

## Pattern corrections and implementation

### P1 — constant-product serial curves

Use atomic token units and rational fee/tax factors. For a supported hop model write `F(q)=a*q/(b+c*q)`. For standard input-fee, output-tax CPMM: `a=gamma*(1-taxOut)*Rout`, `b=Rin`, `c=gamma`; include verified input tax in both numerator and denominator where applicable. Never collapse different tax locations into an ambiguous single factor.

Composition of current `(A,B,C)` and next `(a,b,c)` is `(a*A,b*B,b*C+c*A)`, since `F_next(F_current(q))=a*A*q/[b*B+(b*C+c*A)*q]`. Normalize rational coefficients to control growth. Continuous stationary seed for fixed loan slope `m=1+fee` is `(sqrt(A*B/m)-B)/C`. A nonpositive derivative surplus at zero yields no continuous opportunity for this model. Degenerate/zero reserves reject explicitly.

Use integer square root with rational scaling; seed is a proposal, never an executable quote. Evaluate neighboring legal quanta, bounds, fee discontinuities and exact integer hop outputs. Small-domain exhaustive evaluation is the independent oracle. Do not force Q upward to $2,500/$100,000, or impose fixed 12%/25% reserve caps. Maximum is the intersection of owner exposure, evidenced lender capacity, adapter limits and actual executable depth. If the optimal size falls below a binding owner minimum, evaluate the legal domain or report infeasibility; do not pretend the clamped seed is still optimal. Document sample 6.1 is not adopted: it taxes the first output and also folds tax into `eqeta`, and its recurrence does not preserve the stated serial function.

### P2 — concentrated liquidity

Build directional Q96 tick segments from pinned slot0, active liquidity, initialized ticks, fee and token order. Use existing exact swap-step rounding and signed liquidityNet crossing. Traverse the smaller remaining segment until marginal surplus changes sign, then bracket the interior solution using exact projection; evaluate adjacent raw inputs. Do not implement the document's placeholder “Combined Liquidity Denominator” or use `liquidityUsd` as pool liquidity. Handle simultaneous tick exhaustion by advancing both sides. Zero liquidity, missing bitmap words, limit reach and unknown hooks yield coverage/capability reasons, never fabricated depth. Dynamic-fee Algebra, Slipstream and V4 use distinct verified adapters; generic V3 storage assumptions are insufficient.

### P3 — mixed quotes and cycles

Retain every trusted graph edge even when only one pool exists for its pair. Enumerate simple closed cycles under the existing six-hop ceiling, anchored at every eligible funding asset. Include same-DEX fee tiers, mixed V2/CLMM and dual-quote routes. Deduplicate by canonical directed pool path; rotations remain alternative funding anchors where costs differ.

Negative-log marginal rates may prioritize search; they do not prove finite-size profit. A fixed $2,500 probe may erase a smaller opportunity. Logs use consistently normalized token units and cannot authorize execution. Size each candidate with exact state-ordered projection; only standard disjoint CPMM serial routes qualify for the rational composition. Shared pools mutate once per ordered swap. Budget exhaustion is INCONCLUSIVE. Never label bounded DFS as Bellman–Ford or claim that a negative log cycle covers gas, hook effects or nonlinear taxes.

### P4 — parallel allocation

Choose nonnegative raw allocations with `sum(branch amounts)+unused=principal`. Every active leg has at least one executable quantum; allow zero weight for excluded routes. No mandatory 18%, $100 leg or 95–100% deployment recipe. Owner limits may remain explicit and provenance-bound. Prefer borrowing only deployed capital unless lender/settlement constraints justify unused principal.

For disjoint, fixed-fee concave routes, solve marginal equalization with bounded bisection on lambda and evaluate active subsets under executable branch limits. Quantize allocations, distribute residual atoms deterministically, and re-quote complete schedules. Route activation gas and principal-dependent fees are included when comparing schedules; ranking by zero-volume rate alone must not discard lower-rate, deeper alternatives. Shared pools, dynamic tax or hooks invalidate independent-route concavity: evaluate state-ordered schedules with bounded search and mark best-found. Extend beyond the current two-branch loop to the admitted executor limit (maximum eight only where contract capability proves eight). No global-optimality claim without proof.

### P5 — source-triggered local state and simulation

P5 supplies state and validation for P1–P4; it is not an independent profit formula. Use existing observation/watcher lineage and explicit stream adapters. Verify actual source wire format against captured fixtures and official protocol documentation before enabling each adapter. The document's storage-diff endpoint, universal slot numbers and Nitro raw-diff assumptions are unverified here and are not implementation facts.

Base/Nitro adapters declare whether they provide transactions, receipts, account diffs or complete executable state. Transaction feeds require ordered execution against a pinned parent; do not cast transactions to storage diffs. Key pool identity by chain plus contract plus poolId for singleton managers. Layout evidence binds bytecode hash, adapter revision and exact verified slots. Reverse engineering proposes layouts; comparison with canonical reads establishes capability. Never enable arbitrary decoded bytecode automatically.

Generation/cursor/parent tracking rejects duplicates, holes, out-of-order delivery and reorg ancestry. A gap invalidates descendants and triggers bounded canonical resync. New heads cancel obsolete solves. Bounded queue prioritizes affected subgraphs and shares evaluation budgets fairly. Local EVM simulation must possess all needed code/storage/account state and correct fork configuration; cache misses hydrate through explicit host adapters or fail coverage. Never claim zero RPC or <50 microseconds without measurement. Stream state remains provisional until the execution adapter explicitly admits its state class and binds a fresh complete native simulation.

## Dynamic funding and small-profit policy

1. Build eligible funding options from graph assets intersected with owner-approved lender capabilities, token behavior, executor support and fresh valuation/cost-conversion evidence. Symbols are labels; identity is network plus canonical asset ID plus decimals.
2. For each `(asset,lender)` capture capacity, fee calculation/rounding, callback mode and repayment asset at the same coherent state. Zero fee is evidenced per lender, never inferred from the protocol name. Unsupported flash-accounting unlock modes are not generic loans.
3. Compile one immutable policy per funding attempt. USD floor is `max(ownerFloor, requestedFloor)` with nonnegative numerator; price numerator remains strictly positive. Raw floor is floor(USD floor / token USD price * 10^decimals); admission is strictly greater. Default research proposal is zero floor, one-atom principal/branch minima and zero mandatory weight/deployment floors. Actual execution uses the approved owner profile; changing code does not approve a profile.
4. Exact net = swap proceeds + unused principal − principal − actual flash fee − external network cost − other external costs. DEX fees/taxes already embedded in swap output are not subtracted again. Native gas, L1 data fee, relay cost and evidenced conversion rounding are each attributed once. On-chain minimum surplus covers external cost plus raw net floor plus one atom. It preserves opening executor balances and rejects prefund subsidy.
5. Rank funding alternatives only in a common evidenced reporting currency with fresh conservative conversion. Absent comparable valuation yields separate unranked candidates or VALUATION_UNKNOWN, never $1 stablecoin assumptions. Tie break by lower exposure then stable asset/lender/path ID. Global attempts/deadline and per-option counts are reported; a failed option does not starve all others.
6. Re-estimate the exact final payload near signing and rerun admission if fees/state/payload change. For Status Network, always call `linea_estimateGas` with `from`; use returned gas and fee fields for both gasless and premium states. Other chains use their explicit fee adapters. No hardcoded fee defaults.
7. Preserve repayment, min-output, callback authentication, runtime-code trust, allowance scope, daily loss budget, nonce locking, owner trading authorization and receipt reconciliation. Unknown submission is reconciled before retry; unknown P&L halts the lane. Removing these checks would not improve executable profitability.

## Interfaces, data schema and storage

Keep existing 5.0/5.1 decoders and immutable evidence receipts readable. Add version 5.2 records in a separate additive schema/decoder branch; old explicit requests retain old semantics. New behavior is opt-in via a 5.2 request and approved profile. No global production-default change in the spec delivery.

| Record | Required fields and semantics |
|---|---|
| GapRunRequest 5.2 | Existing request identity, caller, network, executor and risk profile refs; fundingSelection `explicit|discover`; explicit selection requires asset+lender ID; discovery requires bounded allowed asset/lender IDs, maxFundingOptions and maxAttemptsTotal; requested floor/cap only tighten approved policy |
| FundingOption | optionId, Asset, lender ID/address/kind, capacityRaw, feeNumerator/Denominator, feeRounding, repaymentAsset, callbackMode, executorCapabilityRef, identity, expiry, evidence refs; non-linear fees require quote adapter and disable linear seed certification |
| GapPoolGraph | graphHash, identity/generation/cursor, asset metadata, directed pool edges, per-edge state/layout/fee/coverage evidence, pair compatibility view, explicit excluded edges and reasons |
| GapSolveRequest | run/policy/graph hashes, option ID, enabled patterns, quantumRaw, min/max principalRaw, branch/hop/swaps limits, attempts and monotonic deadline; no caller-selected code modules or commands |
| GapCandidate | existing Plan plus pattern IDs, fundingOptionRef, graphHash, exact quote refs, branch mutation order, coverage/optimality metadata; executable false until native admission |
| GapSearchReport | per-option attempts/elapsed/termination, route/size/allocation coverage, rejected counts by stage, best candidate refs, omissions; distinguish funding unsupported, no opportunity in fully evaluated domain, and inconclusive search |
| StreamUpdate | source/chain, adapterRevision, generation, cursor, parent cursor/hash, block/subblock identity, finality, observedAtNs, payloadKind and raw evidence hash; payload is bounded and typed |
| GapRoundReport | selected funding/candidate/simulation/payload/policy/state hashes, simulated and receipt-derived ledgers, outcome, changedState refs, pending verification; realized net remains null before receipt reconciliation |

All money/reserves/liquidity/fees/principal and timestamps use bounded canonical decimal integer strings; signed net fields permit a minus sign. Rational denominators >0; positive prices; asset decimals come from verified metadata. Q96 values remain integers. Chain-specific address validation, duplicate IDs, cross-chain substitution, unknown fields, oversize arrays, bounds and overflow reject at the boundary. Hashes bind canonical record bytes and source versions. Weights are display-only derived values; allocations are authoritative. Null values carry explicit reasons. A schema-valid record still requires semantic conservation/economic verification.

Use existing content-addressed ArtifactStore and append-only execution journals. Hot state is bounded in-memory and generation-keyed. Telemetry is file-backed records first; do not introduce DuckDB/SQLite into nim-memory. Optional analytical exports are derived and disposable. Nim knowledge holds cited observations, episodes and provisional interpretations, never hot price truth or trade authorization. Procedures/rules require explicit owner approval and successful proof evidence.

Host boundaries: extend the trusted registry with graph capture, funding capture, stream subscribe/resync and optional native simulator methods. Orchestrate funding enumeration around the existing single-option `runEvidence` path, preserving exact lineage. Validate all raw records before passing them to the solver. Do not load host modules, RPC credentials or executable commands from request JSON. Keep credentials in existing excluded environment files; report names and placeholders only.

## Implementation sequence and dependency gates

- M1: additive 5.2 schema, floor semantics and isolated funding attempts; migrations prove old version behavior and new zero-floor policy. Extend evidence economics/contracts/runtime and existing policy tests.
- M2: graph inventory retaining singleton edges, funding enumeration and fair budgets; preserve current pair consumers. Add explicit executable capability matrix by chain/adapter/lender/executor.
- M3: P1 corrected rational composition and P2 exact tick candidates integrated into existing sizing/projectors; differential tests before any native optimization.
- M4: P3 cycles and P4 general allocation; exact schedule replay and per-domain uncertainty. No mandatory prescribed weights.
- M5: P5 recorded stream replay and local state hydration; canonical fallback, cancellation, reorg and restart behavior. Live adapter admission requires verified protocol fixtures/documentation and complete state.
- M6: payload compilation, full native simulation, final cost refresh, authorized local execution and reconciliation. Verify TypeScript/Rust/Solidity ABI parity where interfaces change. Existing executor may be reused only for demonstrated capability; contract changes require deployment/codehash and trust updates.
- M7: shadow replay on fixed historical state, opt-in pinned forks and separately authorized limited canary. Report realized results including failure costs. No public deployment or trade is authorized by this document.

Do not create a new native package solely to meet the source document's directory diagram. Profile existing path first; move proven hot functions into the existing Rust workspace only after byte-for-byte fixture parity and measured bottlenecks. No new required runtime dependency is specified.

## Verification and acceptance

Specification checks and implementation proofs are different deliverables. This spec's verifier checks source hashes, requirement/test coverage and corrected algebra examples; it cannot establish profitable execution.

| Test | Required behavior / independent proof |
|---|---|
| T01 | 45bps spot spread across 30bps pools rejects after exact fees; zero/negative net never admitted |
| T02 | Small profitable optimum below $2,500 and net below $10 survives a zero-floor approved profile; owner higher floor still binds; exact threshold atom boundary |
| T03 | P1 rational composition equals direct rational hop evaluation for 2–6 hops; fee/tax positions, unequal decimals, large integers; exhaustive integer sizing oracle |
| T04 | P2 both orientations, four ticks, interior optimum, simultaneous boundaries, negative ticks, empty liquidity and missing bitmap coverage; compare fork quoter |
| T05 | Three single-pool pairs form a dual-quote cycle; reversed route and each eligible borrow anchor considered; 2–6 hops and mixed adapters |
| T06 | Three to eight admitted branches; zero/excluded and <18% allocations, exact atom conservation, rounding, shallow-high-rate vs deep-low-rate route; brute-force tiny allocation oracle |
| T07 | Shared pools mutate in actual branch order; nonlinear fee/tax disables concavity claim; best-found never becomes global certificate |
| T08 | Dynamic borrow asset/lender rotation, zero/positive/rounded loan fee, unavailable lender, unsupported callback, insufficient capacity and fair-budget exhaustion |
| T09 | Gas deducted exactly once; native fee and data/relay fees; non-WETH conversion, stale feed, sequencer-down and stablecoin depeg; Status free-to-premium near-send transition |
| T10 | Plain/compressed source frames per actual adapter fixture, duplicates, cursor gaps, reorder, reorg, reconnect, queue pressure, cancellation and restart; no provisional/canonical state mixing |
| T11 | Native replay binds exact caller/state/payload/codehash/policy/funding context; missing storage/code, expiry, hook/tax change, callback spoofing and prefund subsidy reject |
| T12 | Local E2E discovery -> graph -> dynamic funding -> solve -> compile -> real local native simulation -> signed local transaction -> receipt -> ledger; positive, nonprofitable and reverting scenarios |
| T13 | Double dispatch/nonce race, unknown submission, receipt reorg and restart reconcile without duplicate send or loss-budget credit; unknown P&L stops lane |
| T14 | 5.0/5.1 compatibility, 5.2 malformed/mutated records, schema/semantic mismatch, fixed-seed replay determinism, source hash mutation and ABI parity |
| T15 | Opt-in pinned native forks per admitted pool/lender/executor tuple; historical stream replay; shadow vs canonical differences; authorized canary has reconciled actual costs |
| T16 | Benchmarks report hardware/build/dataset, graph/tick/branch sizes, cold/warm cache, hydration calls and p50/p95/p99 per stage; <10ms compute is a target, never a fixture assertion |

E2E System Map: inventory -> graph/funding -> exact solver -> native admission -> dispatch/reconciliation. EDGE-01 binds graph/funding identity (T05,T08,T14); EDGE-02 proves math/economics (T01–T07,T09); EDGE-03 proves source/state lineage (T10); EDGE-04 proves native capability binding (T11,T14); EDGE-05 proves execution/accounting/restart (T12,T13,T15). Each implementation edge requires an executable command plus structured marker with run/state/policy hashes and retained raw output. Do not substitute this specification checker for any runtime edge.

Existing baseline commands: `npm run typecheck`, `npm run evidence:test`, `npm run liquidity:test`, `npm run evm:test`, `forge test`, `cargo test --workspace --locked`, `npm run evidence:local-e2e`. Add the new behavioral cases to these existing suites; local E2E uses Anvil and synthetic liquidity, no public funds. Fork suites require explicit RPC access and pinned blocks. Record command, exit status, commit/diff hash, fixture/state hash, timestamps and raw artifact paths. Only passing runtime/native/fork evidence can close its corresponding milestone.

## Implementation and review evidence

The implementation extends existing TypeScript math, evidence and execution paths. No new runtime dependency, Rust package, SQL store or executor deployment was introduced. The public opt-in is evidence version 5.2; 5.0/5.1 behavior remains covered by existing tests.

Actual interfaces are `GapRunRequest {schemaVersion, recordType, runId, request, allowedAssets, allowedLenderIds, principalCapsRaw, maxFundingOptions, maxAttemptsTotal, deadlineMs}`, `FundingOption`, and `GapStreamUpdate`, all in the 5.2 schema. `request` is an existing 5.2 RunRequest, including its owner profile and global raw principal ceiling. Each option cap only tightens that ceiling; capture cannot substitute its approved profile. Funding options are passed explicitly to `compileFunding`/`simulateFunding`, stored as raw immutable evidence, and included in the execution-context hash. `GapRound` returns selectedOptionId, per-option attempts/status/normalized net/error, child evidence manifests, omissions and aggregate uncertainty. Candidate selection does not authorize a transaction.

P1 uses generalized exact rational composition as a seed. P2 brackets executable CLMM depth by input bit width before quote search; this handles both unit-scale and 18-decimal regression fixtures. P3 uses the existing bounded simple-cycle graph, including singleton edges with `universe --cycles`. P4 uses scaled integer lambda bisection, deterministic residual atoms and improving quantum exchanges, followed by exact state-ordered projection. Its output remains best-found where global optimality is unproved. P5 is an explicit adapter bridge to the existing canonical watcher with cursor/generation/parent validation and required resync. It uses native simulation through existing hosts. It does not pretend that transaction hints are complete raw EVM state or enable unverified provider stream formats.

Existing `Plan`, `Search`, `StateBundle` and ledger artifacts carry graph/candidate/search results; the design names GapPoolGraph/GapSolveRequest/GapCandidate/GapSearchReport describe those roles rather than introducing duplicate wire records. Coherent captures remain bounded at 16 pools per attempt. Larger inventories require host partitioning; no completeness certificate covers omitted partitions. Existing native adapters retain explicit hook/tax/capability limits. XRPL, unsupported protocols and public streams need separately verified host implementations; there is no fabricated live capability.

Gstack review applied testing, security, API-contract, maintainability and performance specialist passes, plus primary review. Reproduced findings were fixed: large-atom allocation collapse, discrete reallocation, CLMM coverage outside the borrow cap, scaled CLMM depth, blocked-negative aggregation, host and synchronous solver deadlines, prototype method preservation, funding payload identity, direct-runtime funding validation, owner profile/cap preservation, and root/audit schema version propagation. Cross-model Claude execution was not available through this host; independent reviewers used the available agent runtime.

Verification: full `npm test` passed (261 Node tests passed, four skipped, Rust workspace suite passed). Focused evidence/universe tests and a signed dynamic-funding Anvil transaction passed. The local receipt proves loan repayment, opening balance preservation, two nonzero swap legs and reconciled realized net. New commands are `npm run gap:test` and `npm run gap:local-e2e`. The System Map binds five executable edge checks. These are local verification facts, not public-network profitability or admission claims.

Remaining external acceptance: protocol-specific raw stream fixtures/documentation, per-venue pinned public forks, full native capability matrix and operator-authorized live canary. Latency remains measured best effort, with no claim of the source document's nanosecond or sub-10ms targets. Owner procedures/rules and live execution profiles require their own approval; implementation authorization does not promote memory into operating rules.
