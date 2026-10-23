# Aerodrome split ratios and flashloan execution on Base

Status: implemented and verified on 2026-10-22. Scope: Base mainnet (8453), classic volatile/stable pools and three pinned Slipstream generations. The implementation and deployment evidence below supersede the earlier research-only scope following the owner's instruction to continue through implementation and deployment. Fork opportunities use a constructed counter-venue.

The [feature brief](features/aero-split-routing.md), [machine-readable SpecEnvelope](features/aero-split-routing.spec.json), and [delivery map](features/aero-split-routing-map.md) define implementation and acceptance. Existing analytics 4.0 and deployed executor capabilities remain unchanged.

## 1. Evidence and corrections

These are immutable official source revisions. Source inspection establishes code behavior, not that a deployed address runs that revision. Deployment admission additionally needs RPC code, implementation, configuration and factory evidence at a pinned block.

| ID | Primary source | Establishes |
| --- | --- | --- |
| C1 | [Classic Pool.sol](https://github.com/aerodrome-finance/contracts/blob/1ba30815bba620f7e9faa34769ffd00c214c9b82/contracts/Pool.sol#L352-L491) | Fee extraction, integer quotes, stable iteration |
| C2 | [Classic PoolFactory.sol](https://github.com/aerodrome-finance/contracts/blob/1ba30815bba620f7e9faa34769ffd00c214c9b82/contracts/factories/PoolFactory.sol#L50-L118) | Pool lookup overloads and custom/default fees |
| C3 | [Classic deployments](https://github.com/aerodrome-finance/contracts/blob/1ba30815bba620f7e9faa34769ffd00c214c9b82/README.md#L88-L108) | Published Base deployment references |
| S1 | [Slipstream CLPool.sol](https://github.com/aerodrome-finance/slipstream/blob/f8717faaae6e6717db3c8e3850149c01a79c0603/contracts/core/CLPool.sol#L675-L899) | Cached swap fee, signed tick crossing, swap/flash callbacks |
| S2 | [Slipstream CLFactory.sol](https://github.com/aerodrome-finance/slipstream/blob/f8717faaae6e6717db3c8e3850149c01a79c0603/contracts/core/CLFactory.sol#L158-L194) | Fee modules, validation and fallback behavior |
| S3 | [Slipstream SwapMath.sol](https://github.com/aerodrome-finance/slipstream/blob/f8717faaae6e6717db3c8e3850149c01a79c0603/contracts/core/libraries/SwapMath.sol) | Per-step exact-input fee and rounding |
| S4 | [Slipstream deployments](https://github.com/aerodrome-finance/slipstream/blob/f8717faaae6e6717db3c8e3850149c01a79c0603/README.md#L41-L118) | Initial, gauge-caps and gauges-v3 Base generations |
| B1 | [Base network fees](https://docs.base.org/base-chain/network-information/network-fees) | Execution/publication context; actual values require current RPC evidence |
| M1 | [Morpho flashLoan implementation](https://github.com/morpho-org/morpho-blue/blob/9cf6d5b844625ba108e36d1cf911f5d2faf7c136/src/Morpho.sol) | Transfers principal, calls onMorphoFlashLoan, then pulls the same principal; source-level zero premium |

The equations below are derivations with explicit assumptions. Corrections to the earlier draft:

- A fee-inclusive quote already includes gamma; multiplying its derivative by gamma again double-counts fees.
- Classic fees leave reserves. Integer rounding means the post-swap invariant is at least its previous value, not necessarily exactly equal.
- Leftward CL crossings subtract liquidityNet; rightward crossings add it. After crossing left, tick becomes nextTick-1 (S1).
- Oracle and CEX mid-prices are not executable repayment venues.
- Quoter gas is not the complete flashloan transaction's gas bill. Lender fees and network tips are not constants.
- Slipstream fee modules are not Uniswap v4 hooks. The inspected swap caches fee() once; that does not imply equal fees across separate swaps or deployment generations (S1, S2).

## 2. What a split ratio solves

For independent routes X→Y, let a_i be gross native input, A>0 total gross input, and q_i(a_i) fee-inclusive native output:

\[
\max_{a_i\geq0}\sum_i q_i(a_i),\qquad \sum_i a_i=A,\qquad \alpha_i=a_i/A.
\]

For differentiable concave quotes, KKT gives q_i'(a_i)=lambda on interior active routes, q_i'(0)<=lambda on unused routes, and q_i'(capacity)>=lambda on capacity-bound routes. This continuous reference is not an integer optimality certificate. Tick boundaries, flooring, activation costs, changing fees and shared pools invalidate naive smooth optimization.

For volatile reserves x,y and retained fraction gamma:

\[
q(a)=\frac{y\gamma a}{x+\gamma a},\quad q'(a)=\frac{\gamma xy}{(x+\gamma a)^2},\quad
 a_i(\lambda)=\max(0,(\sqrt{\gamma_i x_i y_i/\lambda}-x_i)/\gamma_i).
\]

Clamp at capacity and binary-search lambda until allocations sum to A. Example: two identical fee-free pools (x,y)=(1000,1000), A=200 allocate 100 each, returning continuous 2000/11 versus unsplit 500/3. This illustrates output improvement, not a profitable executable cycle.

With native integer floors, that 100/100 allocation returns 180, while exhaustive integer allocation finds 181. Continuous symmetry is not an integer optimality certificate.

Exact amounts drive execution. Display basis points use largest remainders: floor 10000*a_i/A, then distribute the remaining basis points by descending fractional remainder, ties by branch ID. They sum to 10000 but must never reconstruct amounts. Reject A=0.

### Complete cycles and costs

A branch starts and ends in the borrowed asset X. With disjoint intermediate pools its return h_i is the composition of its leg quotes. Optimize complete branches, including the executable counter-swap:

\[
\Pi=R_X(A,\mathbf a,\text{order},S)-A-F_X(A)-C_X(\text{exact calldata}).
\]

R_X is total terminal X from sequential exact simulation; F_X is integer lender premium; C_X is conservatively valued execution, publication and other applicable network costs counted once. On-chain minProfit measures profit after debt but before externally paid gas: require minProfit >= gas budget in X + configured net-profit floor.

Fixed activation costs require subset comparisons. Compare fully reallocated alternatives with complete transaction costs. Removing a branch without reallocating and requoting is invalid. Marginal USD gain alone misses changed gas, ticks and calldata.

Shared pools make returns state-dependent. Execute branches in canonical branch-ID order and project every leg against the state left by preceding legs. Reset to the original snapshot for every candidate. Never sum independent quotes reusing the initial counter-pool. Version 1 optimizes this fixed order and does not claim the best permutation.

### Bounded production search

Use integer arithmetic and exact quotes. Limits: eight candidate branches, six legs each, 4096 CL steps per quote, 256 bitmap words and 10000 initialized ticks per pool. Existing executor limits remain hard bounds.

1. Validate coherent pinned state, positive borrow quantum, lender capacity and risk bounds. Sort IDs lexically; use no randomized ordering.
2. If the complete feasible domain of lender, quantum-aligned principal and quantum allocations fits the evaluation budget, enumerate it in that order. Certify only after exhausting that domain with exact costs. The certificate is restricted to request bounds and fixed branch order.
3. Otherwise evaluate single-branch baselines first: each lender, up to 32 evenly spaced quantum-aligned sizes including endpoints, deduplicated. Analytical and CL boundary seeds follow within the same budget and domain.
4. For each size and active subset (in increasing cardinality then lexical order), allocate greedily in at most 64 chunks. Start with max(quantum, ceil(A/(64*quantum))*quantum), capped at A, and use a smaller quantum-aligned final remainder. Evaluate each eligible addition by replaying the entire partial branch schedule. Score terminal return; ties choose lexical branch ID. Partial scores are heuristics, not admission decisions.
5. Only complete allocations summing exactly to A can win. Price full debt and exact transaction costs for each completed candidate. Re-run subsets rather than applying an unchecked pruning post-pass. Ties: lower principal, fewer active branches, lender ID, allocation vector.
6. Default total budget is 4096 schedule evaluations, including partial candidates and failures across all lenders/sizes/subsets. Exhaustion returns best-found with budgetExhausted=true. Without a completed profitable candidate return no-profitable-plan. Unknown ticks or fees reject a candidate, never become zero impact.

Separate exact projection work from expensive full-transaction gas estimation: use conservative request cost evidence during search; reprice the best eight complete candidates using full simulation, charging those evaluations to the same budget. If fewer than eight remain feasible, evaluate all. An exact-search certificate additionally requires exact costs for every feasible allocation; otherwise downgrade to best-found. Before a future send resnapshot, refresh costs and repeat exact complete simulation.

## 3. Contract-equivalent quotes

### Classic volatile

Read fee b from factory.getFee(pool,stable), D=10000. In native units (C1):

```text
fee = floor(a*b/D)
u = a-fee
out = floor(y*u/(x+u))
nextReserveIn = x+u
nextReserveOut = y-out
```

Existing projectV2 retains gross input in reserves. Add a distinct Aero projection; reuse helpers, not generic V2 state updates. Independent rounding vector: (x,y,a,b)=(1000,1000000,1,30) gives fee=0, out=999. A combined continuous fraction floors to 996. The difference matters at native-unit boundaries.

### Classic stable

E=10^18. Normalize X=floor(reserve0*E/10^d0), Y=floor(reserve1*E/10^d1). Continuous reference:

\[
K=X^3Y+XY^3,\quad F(Y)=X_{new}^3Y+X_{new}Y^3-K,\quad F'(Y)=X_{new}^3+3X_{new}Y^2.
\]

Deduct the fee in native input units before separately normalizing net input. Solve Ynew, then floor (Y-Ynew)*10^dOut/E. Continuous gross-input marginal rate in normalized units is:

\[
q'(a)=\gamma\frac{Y(3X^2+Y^2)}{X(X^2+3Y^2)}.
\]

Convert units before comparing native marginal rates. This derivative is not an executable quote.

C1's _k, _f, _d use staged integer division. _get_y has 255 iterations, directional updates, one-unit corrections and specific stopping conditions. Port their operations in original order, including the unusual _k(x0,y+1) call in the pinned revision. Floating Newton iteration or regrouping floors changes results. Emulate Solidity overflow/underflow and zero-division rejection despite unbounded bigint. Reject nonconvergence. Require exact parity with the selected deployment's getAmountOut before admission.

### Slipstream

Raw token1/token0 price is sqrtPriceX96^2/2^192; human price multiplies by 10^(d0-d1). Ticks describe raw prices. Convert human oracle price, orientation and decimals before comparisons.

For continuous reasoning, s=sqrt(raw price), liquidity L, net input u and boundary t:

| Direction | Next price inside interval | Output | Net capacity to boundary |
| --- | --- | --- | --- |
| token0→token1 | L*s/(L+u*s) | L*(s-s') | L*(1/t-1/s) |
| token1→token0 | s+u/L | L*(1/s-1/s') | L*(t-s) |

Execution quotes use Q64.96 integers and selected-revision TickMath/SqrtPriceMath/SwapMath semantics (S1, S3). Round required input up, output down. Exact-input steps first floor remaining*(1000000-feePips)/1000000. At a reached boundary charge ceil(netInput*feePips/(1000000-feePips)); otherwise charge residual input as specified in SwapMath. Do not round a fee only once for a multi-tick swap.

Cross left with L-=liquidityNet, right with L+=liquidityNet. Traverse bitmap word boundaries, including empty words. A zero-liquidity gap can be crossed only with complete covered state. Missing coverage, arithmetic failure, step exhaustion or unspent input rejects a complete exact-input quote. Enforce a strict sqrt-price limit and full consumption.

The inspected swap reads fee() once per swap (S1). unstakedFee() redistributes charged fees; do not add it again to trader input fees. For pool reuse, dynamic fee modules may depend on changed pool/oracle state. Fixed-fee profiles require constancy evidence; dynamic profiles require block-pinned EVM evaluation of the ordered schedule and module dependencies. A starting scalar fee cannot certify a projected dynamic-fee schedule. Unknown modules stay analysis-only.

## 4. Borrow sizing and filters

For one volatile sale and an ideal infinitely liquid executable buyback at p Y/X, proportional lender premium phi and size-independent costs, continuous profit is q(a)/p-a*(1+phi), with stationary seed:

\[
a^*=\max(0,(\sqrt{\gamma xy/[p(1+\phi)]}-x)/\gamma).
\]

Hurdle: gamma*y/x > p*(1+phi). This is not exact when the counter-venue has impact, rounding, capacity or size-dependent gas. Evaluate neighboring feasible quantum values using actual cyclic quotes. Stable and CL routes use bounded outer search with tick-boundary hints.

For an ideal two-swap cycle with retained fractions gamma1,gamma2, the directional zero-size hurdle is P_sell/P_buy > (1+phi)/(gamma1*gamma2). The corresponding tick threshold is ln((1+phi)/(gamma1*gamma2))/ln(1.0001) after matching orientation/decimals. The approximation 20000*f+10000*phi assumes small equal swap fees and omits gas/impact/rounding. Version 1 reports it only as a diagnostic; it must not hard-reject executable candidates using an oracle tick alone.

## 5. Integration architecture

```mermaid
flowchart LR
  A[Versioned roots and source pins] --> B[Block-pinned pool and fee capture]
  B --> C[Integer projection and cyclic allocation]
  C --> D[Capability-bound exact calldata]
  D --> E[Full flashloan simulation and cost valuation]
  E --> F[Freshness and policy admission]
  F --> G[Executor: callbacks and repayment]
  G --> H[Receipt, custody and net profit]
```

Reuse existing projectPool, sizeRoute, quoteV3ExactInput, estimateEvmFees, EvmLiquidityExecutionAdapter and journal/budget components as integration seams. They do not currently accept Aero. sizeRoute handles one cycle: add split allocation around the projector without hiding parallel branches in its linear route array. The Rust scanner remains analysis-only for Aero until separate protocol/capability support is proved.

### Deployment registry

C3/S4 publish these candidates, not automatically approved roots:

| Generation | Factory | Router | Quoter |
| --- | --- | --- | --- |
| Classic | 0x420DD381b31aEf6683db6B902084cB0FFECe40Da | 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 | pool getAmountOut |
| CL initial | 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A | 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5 | 0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0 |
| CL gauge caps | 0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a | 0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D | 0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C |
| CL gauges v3 | 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef | 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F | 0x514c8B5f54112481E28028F1166Bd78501089259 |

Registry records bind chain, generation, factory, resolved pool implementation, fee modules, quoter ABI, source revision and observed code hashes. Resolve proxy/clone implementations as well as shell bytecode. Read pool tokens, stable flag or signed tick spacing; compare factory.getPool and pool.factory() at the same block. Classic uses the bool overload; CL uses int24 spacing, not a Uniswap fee tier. Reject duplicate identities. Capture balances as well as reserves; unexplained donations, rebasing and taxed transfers are unsupported. Do not apply newest source behavior to older deployments without parity evidence. Each of the three CL generations requires its own admitted profile; an unproved generation is explicitly rejected rather than silently covered.

### Executor and lenders

Extend the shared typed leg engine and portable split executor in a new artifact revision. Add Aero classic and Slipstream venue discriminants after existing IDs; never reinterpret current V2/V3 IDs. Classic identity includes stable/factory; CL includes spacing/generation/price limit. Bind new capability selector and artifact hashes; old deployed selectors and pins cannot admit it.

Use venue IDs 6 for Aero classic and 7 for Slipstream; retain external V2=2 and V3=3. The exact proposed ABI is in the feature brief. The current generic V2 executor requests minAmountOut itself from the pair, rather than treating it only as a lower bound. Its return is therefore not the maximal pool quote. The new Aero-capable entrypoint must use a separate quotedAmountOut for external V2 execution, with minAmountOut remaining a guard; full simulation must reflect the exact requested output. Never optimize a maximal V2 quote and execute a different minimum-output amount without repricing the cycle.

Classic direct execution authenticates the pool, computes output, transfers gross input and calls swap with empty callback data; enforce actual output balance delta. CL direct execution uses the V3-named callback selector with a separate CL factory lookup and context. Bind expected pool, input token, maximum owed, route digest, active leg and phase. Reject nested/double callbacks, unexpected positive token deltas, arbitrary targets and payment above the budget. Enforce leg minOut and full consumption.

Keep complete-cycle Branch{amountIn,legs[]} semantics and sum allocations exactly to principal. Preserve owner-only entry, opening balances and idle-only withdrawals; opening funds cannot subsidize debt or reported profit.

Version 1 uses portable lender kinds Morpho (1) and Balancer V2 (2), separately admitted for the requested asset and pinned Base state. M1 confirms source-level Morpho repayment of exact principal without premium; independently match the deployed implementation before using those terms. Read the lender's asset balance as a capacity upper bound and enforce provider-specific availability, paused state and full flashloan simulation. Balancer callback fees must match bounded quoted terms read from its admitted implementation/configuration; unavailable terms reject it. Choose feasible net profit after all costs, not advertised fee alone. The existing Aave single-cycle ABI is not a split fallback. Aave split borrowing, Aero-native flash sourcing and other providers are deferred with UNSUPPORTED_LENDER_CAPABILITY.

### Fees and admission

Audit the existing Base adapter against the fork's active fee rules. Estimate the complete sender-bound transaction, including execution, L1 publication and any additional applicable fee components. Use current RPC values; do not double-count receipt components. A wei tip budget must be divided by gas units to produce wei/gas. Version 1 uses bounded RPC fee estimates without profit-share bidding or ordering guarantees. Quoter gas is only a search hint (B1).

Before future signing revalidate chain, canonical head hash, code/config pins, fees, lender liquidity, owner/capability, fresh valuation, cancellation and exact simulation. Changed heads rebuild plans. Unknown submissions reconcile via the journal without blind retries. Status Network is outside this feature; any future Status adapter must use sender-inclusive linea_estimateGas and returned fee values.

## 6. Data contracts

The SpecEnvelope embeds draft-07 JSON Schemas for a self-contained request and selected/rejected results, plus examples. These interfaces are implemented in src/aero; current analytics parsers retain their existing versions. Version: aero-split/1.0. Translate analytics 4.0 through an explicit adapter; never relabel it. Serialized addresses are lowercase; amounts/block numbers are canonical decimal strings; signed liquidity is a signed decimal string. Prices and conversion evidence use explicit rational/fixed-point units; USD uses E8. Use bigint for money.

Inputs include pinned block identity, factory/implementation/module pins, protocol snapshots, candidate complete cycles, lender terms, cost evidence, borrow bounds and search limits. Classic state includes native reserves/balances, decimals and bps fee. CL includes Q96 price, liquidity/tick, fee pips, bitmap window, initialized ticks and fee profile. Unknown dynamic dependencies cannot be execution-ready.

Selected outputs contain exact allocations, reporting ratios, per-leg consumed input/output/fee/limits, principal/debt, terminal return, on-chain minProfit, cost/net profit, search evidence and executable=false until independent admission. Rejected/no-profitable results have reasons and no calldata. Full simulation evidence binds exact payload, snapshot/request digests, artifact/capability, sender and block.

Shape validation is not semantic validation: additionally check references, same-head provenance, arithmetic conservation, fee units, cycle continuity, tick coverage, cost conversion and authorization. Use canonical digest from the repository, not arbitrary JSON serialization.

Define snapshotDigest=digest({identity,pins,pools}), requestDigest=digest(entireRequest), and each leg's before/after digest over its protocol-specific state. The schema examples are synthetic offline fixtures: illustrative block/address/code pins cannot authorize RPC execution. Their request, snapshot and state digests are computed from the example data.

## 7. Implementation and proof sequence

| Stage | Behavior | Completion evidence |
| --- | --- | --- |
| Capture | Generation-specific discovery and coherent pinned reads | Rejection vectors; fork identity and implementation readback |
| Math | Integer classic/stable and CL profile projections | Independent vectors; exact deployed quote parity both directions |
| Solver | Complete-cycle allocation, subsets, bounds and budgets | Exhaustive small-domain oracle; honest certificates |
| Execution | Typed Aero legs, callbacks, both supported lenders | Solidity success/revert cases; compiled ABI parity |
| Integration | Snapshot through full simulation and receipt accounting | Local E2E and pinned-fork proof; no broadcast |

Extend existing Node tests under src/test, Foundry tests under test and EVM proof tooling. Add schema/ABI/capability support before CLI executable output. No new runtime service.

Fork proofs require explicit BASE_RPC_URL, AERO_FORK_BLOCK and matching block hash, public pool/registry fixtures and source/artifact hashes. Verify archive reads, TLS hostname validation and chain 8453. Use Foundry/Anvil test accounts only. A controlled counter-venue may construct a profitable scenario; label it constructed, never a naturally observed opportunity. If none exists naturally, prove rejection honestly.

Future acceptance runs npm run typecheck, npm run evm:test, forge test --match-contract AeroSplitExecutorTest, npm run evm:local-e2e and the opt-in Aero fork command defined in the feature brief. Current suites alone cannot establish Aero support.

Documentation validation: node scripts/verify-aero-spec.mjs and AS-SCP dependency compilation. The specification delivery map verifies this package. Its separate implementation map is Done after local and pinned-fork receipt verification. Document approval does not activate remembered procedures or modify production risk policy.


## 8. Implemented interfaces and operating limits

The standalone `src/aero` pipeline preserves analytics 4.0 and existing executor tuple layouts. `captureAeroSnapshot(client, registry, blockNumber?)` returns `{identity,pools,pins}`; the caller supplies branches, lender terms, bounds, limits and cost evidence to form the versioned request. `captureAeroLender` captures Morpho or Balancer terms at that block. `quoteAeroExactInput(pool,leg,amount,maxSteps)` returns `{quote,projectedState}`. `optimizeAeroSplit(request,host?)` returns the published selected/rejected union. `createAeroEvmHost` evaluates ordered dynamic-fee dependencies on an explicitly selected localhost fork. It traces actual swap fees and clone delegate-call events and compares output, final price, tick and liquidity with integer projection.

The solver exhausts small quantized domains. Larger domains use deterministic size samples, single-branch baselines and bounded subset allocation. Continuous formulas remain explanatory references; this version makes no optimality claim from a continuous seed. Any unresolved quote, including transient host errors, prevents certification. The dynamic EVM host considers only schedules that pass the executor’s positive gross-profit check; losing partial chunks can prune greedy paths. The default host reports `best-found`; exact-cost host certification additionally requires successful exhaustive evaluation of the entire declared domain.

`buildAeroSplitCalldata` binds the request, snapshot and new artifact, replays static schedules and keeps V2 quoted output separate from its minimum. `simulateAeroExecution` verifies chain/head, code pins, owner, whole-loan execution and refreshed RPC-derived execution/publication cost. WETH cost conversion is exactly 1:1. Other settlement assets require explicit pinned USD feeds, a stable settlement price, a canonical valuation digest and the stricter request/configuration age. Synthetic valuations are confined to an explicit localhost adapter and labelled in proof output.

`AeroSplitFlashExecutor` authenticates each configured factory, runtime and clone implementation; preserves opening funds; enforces complete input consumption; rejects forged, duplicate, wrong-token and partial callbacks; and settles principal plus actual lender fee. Morpho and Balancer are unit-tested. The Base deployment activates Morpho and five pinned pools. External V2 capture remains explicitly rejected until a reviewed fee profile is supplied through a separately constructed request; its encoding and execution are tested. Rust discovery continues to treat Aero as analysis-only. The CLI captures, plans and simulates; automated live trade submission remains a separate admission path.

Repeatable proof commands and public deployment evidence are in the feature brief. No natural live profit follows from the constructed fork results.
