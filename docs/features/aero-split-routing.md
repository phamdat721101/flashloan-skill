# Base Aerodrome split routing: implementation brief

Status: implementation, local E2E and five pinned Base fork cases verified. The owner subsequently authorized continuation through deployment. See the operating commands and deployment evidence below.

## Client outcome and rationale

Given coherent Base pool snapshots, lender terms and cost evidence, calculate exact native-unit allocations across complete arbitrage cycles involving classic volatile/stable and admitted Slipstream pools. Return a reproducible best-found plan or a typed rejection; never infer profitability from an oracle alone. [ratio.md](../ratio.md) supplies derivations, source citations and algorithm details. [The SpecEnvelope](aero-split-routing.spec.json) is the versioned input/output contract.

Reuse the existing projector, integer helpers, bounded sizing, journal, fee adapter and typed executor. A new executor revision is necessary: classic Aero fee extraction differs from generic V2, while CL factory identity uses tick spacing and deployment generation. New protocol discriminants and capability pins preserve existing ABI meanings. Initial external counter-venues are the already supported Uniswap V2 and V3 profiles; broader external venues require separate admission.

## Environment contract

Documentation checks need Node >=20 and existing development dependencies (`typescript`, `ajv`); AS-SCP compilation additionally needs the installed nim-skill CLI. There is no new required runtime dependency. Production implementation requires the repository's Rust and Foundry toolchains.

Fork verification uses explicit `BASE_RPC_URL`, `AERO_FORK_BLOCK`, `AERO_FORK_BLOCK_HASH`, and a public per-generation pool/implementation fixture. `AERO_RUN_FORK=1` is mandatory. The fork runner rejects missing opt-in, chain mismatch, non-archive RPCs, block/hash mismatch and disabled TLS hostname verification before executing tests. HTTP is permitted only for localhost Anvil. No owner secret, private relay, funded live wallet or deployment is needed. Credentials stay in local ignored configuration and never enter reports.

Network access is a host adapter capability: the research adapter uses gstack's browser; capture uses viem against explicitly supplied endpoints. Fee-module behavior is evaluated by a selected-revision adapter or a pinned EVM simulation. No implicit remote services, embeddings or Redis are introduced.

## Implementation tasks

1. **Capture and admission:** add Aero protocol/generation variants, factory/implementation/module pins and same-block capture to the existing analytics pipeline. Translate legacy 4.0 explicitly into `aero-split/1.0`; retain old parsers. Validate on-chain factory ownership and actual deployed source/profile, not only a README address.
2. **Quote math:** implement classic fee-floor/external-reserve accounting and exact stable iteration; reuse CL integer machinery only after selected-revision parity tests. Validate raw price orientation, liquidityNet signs, fee modules, bounds and complete tick coverage. Dynamic fees require ordered EVM evidence; unknown profiles cannot execute.
3. **Solver:** implement deterministic size/subset/allocation search from ratio.md, including the 4096-evaluation default, exact residuals and shared-pool sequential projection. Track candidate rejections and evaluations. Provide certified results only for exhausted bounded domains including exact costs.
4. **Execution:** extend the shared leg engine with new Aero discriminants, typed identity fields and CL callback context; generate a distinct artifact/selector and update compiled ABI parity checks. Keep portable lender kinds 1/2 and complete cyclic branches. Require exact consumption, callback bounds, minOut, opening-fund preservation and owner/capability binding. Do not introduce Aave split fallback through its single-cycle ABI.
5. **Integration:** connect capture → solver → typed calldata → complete flashloan simulation → refreshed cost/head admission → existing receipt/custody accounting. CLI outputs stay analysis-only until independent proofs bind the new capability. Rust discovery cannot silently advertise Aero execution.

Each implementation task includes its tests below. The `src/aero` interfaces are implemented and their source dependencies are verified by the compiler. `projectPool`, `sizeRoute` and other dependencies in the envelope are verified existing integration seams.

### Implemented interfaces and ABI

- `captureAeroSnapshot(registry, blockIdentity, poolIds)` returns validated pool/pin records or a typed capture rejection. It never creates a signer.
- `quoteAeroExactInput(poolState, tokenIn, amountIn, limits)` returns consumedInput, amountOut, feeAmount, crossedTicks, projectedState and before/after digests, or a typed incomplete/failed quote.
- `optimizeAeroSplit(request)` returns the embedded result union. `selected` is analysis-only until admission; it is not a broadcast instruction.
- `buildAeroSplitCalldata(request, selected, admittedArtifact)` returns `{to, data, value:"0x0", selector, artifactHash, requestDigest, snapshotDigest}`. It rejects missing/newer artifacts or unproved profiles. Hash bindings and full simulation are independently checked before any future signature.

Use this new Solidity entrypoint in the portable executor revision; preserve existing entrypoints and their tuple layouts:

```solidity
struct AeroLeg {
    uint8 venueVersion; address root; address pool;
    address tokenIn; address tokenOut;
    uint256 minAmountOut; uint256 quotedAmountOut;
    uint24 fee; uint160 sqrtPriceLimitX96; int24 tickSpacing;
    bool stable; uint8 generation;
}
struct AeroBranch { uint256 amountIn; AeroLeg[] legs; }
struct AeroSplitRoute {
    uint8 kind; address lender; address flashAsset; uint256 flashAmount;
    AeroBranch[] branches; uint256 minProfit; uint256 deadline;
}
function executeAeroSplitArbitrage(AeroSplitRoute calldata route) external;
```

The selector is derived from the compiled tuple ABI, never copied from an old split entrypoint. Venue values: V2=2, V3=3, AeroClassic=6, Slipstream=7; reject other values in this new entrypoint. Generation values: external=0, classic=1, CL initial=2, CL gauge-caps=3, CL gauges-v3=4. Bind generation to the authenticated registry root; it cannot override factory identity.

For V2 set generation=0, stable=false, fee=0, tickSpacing=0, sqrtPriceLimitX96=0 and quotedAmountOut to the exact planned output. Request that output from the pair and check minAmountOut separately. This corrects the current shared engine's behavior of requesting minAmountOut itself; do not reuse its V2 branch unchanged. For V3 use generation=0, stable=false, fee as the authenticated fee-tier lookup, tickSpacing=0 and quotedAmountOut=0. For classic set generation=1, stable from the admitted pool, fee=0, spacing/price limit=0 and quotedAmountOut=0; recompute exact output through the authenticated pool's quote at execution. For CL set generation=2..4, stable=false, fee=0, authenticated signed tickSpacing, directional price limit and quotedAmountOut=0; read the effective fee from the actual pool. Zero fields are canonical unused fields, not fee assumptions.

For every venue require minAmountOut>0. Before encoding, floor quote*minOutBps/10000 and reject zero. Propagate actual balance-delta output into the next leg. The existing generic V2 helper's minimum-output execution must have a regression test against the new entrypoint's exact quoted output, including a shared counter-pool cycle.

## Acceptance and test plan

| Edge | Required proof | Failure and boundary cases |
| --- | --- | --- |
| EDGE-01 | Schema, identity and generation admission | Extra fields; unsafe integer encodings; cross-chain/block state; bad fee units; duplicate IDs; wrong bool/int24 factory overload; proxy/clone implementation change; missing fee dependencies |
| EDGE-02 | Exact quote parity | Classic one-unit fee-floor vector; mixed 6/18 decimals; stable 255-iteration/nonconvergence and arithmetic reverts; token orientations; Q96=79228162514264337593543950336; left/right tick crossings; empty bitmap words; zero-liquidity gaps; insufficient coverage; partial fills; dynamic module changes |
| EDGE-03 | Allocation and profit | Exhaustive small-domain oracle; residual/basis-point conservation; KKT reference; borrow/lender caps; full cost counted once; branch removal with redistribution; shared counter-pool projected sequentially; deterministic ties; exhausted budgets; analytical seed cannot certify |
| EDGE-04 | Solidity repayment and callbacks | Both lenders; forged/wrong/double/nested callbacks; incorrect token/delta; maximum owed; changed root/implementation; deadline; per-leg minOut; partial input; exact repayment; preexisting balances cannot subsidize loss; reentrancy; typed ABI/selector parity |
| EDGE-05 | Local pipeline and pinned Base fork | Snapshot→allocation→calldata→flashloan→swaps→repayment→custody evidence; head/fee change; final-await cancellation; no-profit rejection; sender/artifact mismatch; missing valuation; exact source-generation quote parity; constructed opportunity labeling; zero broadcasts |

Implementation proof commands:

```sh
npm run typecheck
npm run evm:test
forge test --match-contract AeroSplitExecutorTest
npm run aero:local-e2e
AERO_RUN_FORK=1 AERO_FORK_BLOCK=52943887 AERO_FORK_BLOCK_HASH=0x64465bb17ed3e12eb245843fd6a79f925f08cfa01540bd0679a9df18a879a3e3 node scripts/aero-fork-e2e.mjs
```

The fork runner must write a JSON proof containing suite revision, command, pass/fail per edge, chain, block number/hash, pool generations/addresses, factory/module/implementation hashes, executor artifact hash/selector, full simulated payload digest, lender debt, before/after custody, fee components, gas valuation and whether liquidity was constructed. Public reports contain sanitized inputs and hashes, never signatures or credentials. An unavailable RPC or absent natural profit is a typed limitation, not a passing proof.

Local fixtures must include profitable cycles and unprofitable cycles and cover all three pool types plus both swap directions. Each CL generation needs separate fork parity and execution evidence; a failed/unproved generation remains rejected. Controlled counter-venue state is permitted on the local fork, labeled `constructed`; no claim of naturally profitable live trading follows.

## Specification verification and delivery

```sh
node scripts/verify-aero-spec.mjs
nim-skill search compile --title "Base Aerodrome split routing" --spec docs/features/aero-split-routing.spec.json
nim-skill deliver verify --map docs/features/aero-split-routing-map.md
```

The first map's `Done` status applies only to this specification package and its five documentation proofs. The implementation map in the same file is `Done` from separate execution proofs. Neither documentation tests nor the dependency compiler establish Aero E2E support. Production changes require the implementation proofs, reviewed new capability and existing policy admission.

Nim memory observations need immutable citations. Inferences remain provisional; procedures/rules require successful evidence and separate explicit owner approval. Record actual tool interventions and reusable failures locally, preserve stable prefixes, and do not claim unmeasured provider-cache savings. Handoff includes only changed state and remaining operating limits.

## Engineering review evidence

Reviewed with the installed gstack `/plan-eng-review` workflow on 2026-10-22. Scope was the specification package and proposed implementation, not a claim of deployed Aero support. Scope challenge: seven reviewable paths including the handoff; no new runtime service or class in this delivery. Existing projector/sizing/fee/journal/executor components are reused. Generic V2 reserve updates and V3 factory authentication are explicitly not reused for Aero without adaptation. No design reduction is needed.

Prior learnings applied: `v3-q96-shared-bad-fixture` requires independent decimal Q96 vectors and deployed parity; `abort-after-final-rpc-before-send` requires a cancellation test during the final awaited check. Both are captured in EDGE-02/05. Confidence: source-level observations are verified; equations are conditional derivations; deployed code, gas and profitability remain future proof obligations.

| Review section | Evaluation | Result |
| --- | --- | --- |
| Architecture | Protocol generations, same-head capture, fee/module dependency behavior, complete cycles, callback trust, artifact capability and memory boundaries | No new issues after draft corrections; implementation still requires per-generation proofs |
| Code quality | Existing module reuse, exact-unit schemas, distinct version migration, typed rejection and essential files only | No new issues; validator is offline development tooling using existing dependencies |
| Tests | Node/Foundry framework fit, independent arithmetic, schema negatives, reference hashes, future local/fork coverage and cancellation | Five specification proofs pass; future Aero execution proofs remain unexecuted |
| Performance | Bounded states/ticks, global evaluation budget, expensive simulation shortlist, deterministic exit and honest optimality | No new issues; 4096-evaluation default is a policy limit, not a latency benchmark |

The original draft's fee double-counting, leftward tick sign, oracle-as-execution assumption, static deployment registry and integer-optimum claim were corrected during drafting. The final compatibility pass also made external V2 quoted output explicit in the new ABI; the regression requirement above covers the existing helper's different semantics. No unresolved scope changes remain. No independent outside-model review ran: gstack's `under_codex` rule skips nested Codex execution. Its update probe failed; update status is unknown and was not treated as evidence of currency.

### NOT in scope

- Production code, deployment or broadcast: this delivery establishes the implementation contract.
- OP Mainnet/Velodrome and unrelated networks: owner selected Base first.
- Aave split/native Aero flash borrowing and new counter-venue families: preserve the current portable lender boundary and existing V2/V3 counter-venues.
- Redis, profit-share bidding and global order/permutation optimization: not required for bounded deterministic version 1.
- Natural live-profit certification: local/fork simulations cannot establish it.

### What already exists

Projection and CL integer helpers supply state math seams; bounded sizing supplies single-cycle search; the portable executor supplies cyclic branches and Morpho/Balancer callback phases; EVM fees, journal and receipt adapters supply cost/custody seams. The machine-readable envelope verifies six current exported dependencies by symbol and file hash. The new Aero interfaces and artifact are explicitly future work.

### Failure visibility and test flow

```text
capture/schema --EDGE-01--> integer quotes --EDGE-02--> split search
split search   --EDGE-03--> typed callback execution --EDGE-04-->
full local/fork flow --EDGE-05--> repayment/custody evidence
```

Each row in the acceptance table names a realistic failure, its required proof and typed rejection or atomic revert. None is permitted to silently become an executable plan. During implementation, place a short phase diagram beside the shared executor callback context and a sequential-state diagram beside the allocator; update both whenever those transitions change.

### Implementation Tasks and workstream order

No new tasks from architecture, code quality, tests or performance review; the five numbered implementation tasks above already contain the required build work and verification. No separate TODO is added or silently accepted.

| Workstream | Modules | Dependency |
| --- | --- | --- |
| Capture, math and allocation | `src/liquidity`, `src/test`, schemas | Frozen request/result and generation contract |
| Typed executor and callbacks | contracts, Foundry tests | Frozen leg/ABI contract; independent from off-chain math implementation |
| Integrated admission and E2E | `src/evm`, execution adapters, scripts | Merge both preceding streams and verify ABI parity |

The first two streams can use separate worktrees after interface freeze. Integration waits for both. Do not split schema or ABI ownership between those worktrees. This is a future implementation strategy; no subagents or parallel implementation ran for this documentation task.

## GSTACK REVIEW REPORT — original specification review

| Review | Trigger | Status | Findings |
| --- | --- | --- | --- |
| Engineering | `/plan-eng-review` | CLEAR for specification | Architecture, quality, tests and performance evaluated; no new unresolved findings |
| Outside voice | gstack automatic preflight | SKIPPED: under Codex | No independent-model claim |

Original specification review verdict: ready for implementation. The implementation verification below supersedes its pending status.

NO UNRESOLVED DECISIONS


## Implementation evidence and operation

Implemented modules: `types.ts` validates the public request; `capture.ts` captures one block; `math.ts` handles native integer projection; `solver.ts` allocates complete cycles; `evm-host.ts` verifies ordered dynamic-fee traces; `execution.ts` encodes and admits whole-loan simulation; `cli.ts` exposes the host adapter. The distinct Solidity artifact is `AeroSplitFlashExecutor`, selector `0x3b2be3e6`.

```sh
npm run aero -- capture --registry config/aero-base-pools.json --output .nim/aero-snapshot.json
npm run aero -- plan --request .nim/aero-request.json --output .nim/aero-plan.json
npm run aero -- simulate --request .nim/aero-request.json --artifact config/aero-base-executor.json --output .nim/aero-simulation.json
# For dynamic profiles, select a pinned localhost fork:
npm run aero -- simulate --request .nim/aero-request.json --artifact config/aero-base-executor.json --evm-rpc http://127.0.0.1:8545 --output .nim/aero-simulation.json
npm run aero:local-e2e
node scripts/verify-aero-implementation.mjs
```

Capture returns pool evidence rather than a trading strategy. Assemble the request according to `schemas/aero-split-request.schema.json` and the embedded example; supply lender evidence, complete cyclic branches, principal bounds and cost conversion. The artifact JSON requires address, runtimeCodeHash, artifactHash, selector and chainId=8453. For a non-WETH stable settlement asset, supply `--valuation` with `{asset,decimals,nativeUsdFeed,assetUsdFeed,maxAgeSeconds}` and matching `price-feed` pins. Its valuationEvidenceDigest hashes `{identity,nativeUsdFeed,assetUsdFeed,nativePriceUsdE8,assetPriceUsdE8,decimals}` through the repository canonical digest. Re-capture when admission reports STATE_CHANGED.

Evidence is stored locally at `.nim/e2e/aero-local.json` and `.nim/e2e/aero-fork.json`. The latter includes all five pools, three CL generations, classic getAmountOut parity in both orientations, reverse CL swap/state parity, full flashloan simulation, actual receipts and principal/custody checks. The fork uses real pools, tokens and Morpho, with a constructed counter-venue. The offline verifier checks these receipts against the current compiled executor artifact. Regenerate proofs after changing executor behavior.

Gstack `/review` used fresh security, math/testing and API specialists. It found and resolved incomplete-domain optimality certification, caller-controlled gas conversion, request freshness override, and an out-of-schema rejection reason. Regression tests cover these failures. Security re-review reported no remaining findings. Fork verification additionally caught an inclusive tick-window boundary and clone delegate-call log placement; both were corrected. The strict nim harness and all 21 implementation System Map checks passed.

The chosen integration uses an isolated Aero adapter and executor to preserve existing parser and ABI contracts. Analytical ratios inform the design; large-domain search returns best-found. See ratio.md section 8 for exact function signatures and supported limits.


## Base deployment

Deployed and configured at [0xdfafd892dca6a2f9dadc43a38b81c7d53473ff10](https://basescan.org/address/0xdfafd892dca6a2f9dadc43a38b81c7d53473ff10). [Public evidence](../deployments/base-aero-20261022.json) records runtime/owner verification, factory and clone implementation readbacks, all 11 canonical receipts, enabled Morpho funding and five pool pins. Total deployment/configuration cost: 25,960,710,350,786 wei (0.000025960710350786 ETH). All transactions are confirmed; L1 finalization was still pending at the evidence snapshot.

The portable prior deployments retain their existing artifact bindings and ledger. This deployment has a separate Aero authority state while sharing the canonical signer lock and total gas budget. `config/aero-base-executor.json` supplies the artifact capability for the CLI. Owner-only live trading is not automatically admitted by deployment.

```sh
npm run evm -- deployment-status --manifest config/aero-base-mainnet.json --state .nim/deployments/base-aero.json
```


The final fresh-context adversarial pass found no additional actionable issue. It reviewed fixtures/tests in summary mode, so it does not replace executed regression tests. All reviewers ran in the Codex model family; nested Codex CLI passes were skipped by gstack's host guard. Dynamic-host search evaluates only schedules executable with positive gross profit, which can prune loss-making partial allocations; results remain best-found.
