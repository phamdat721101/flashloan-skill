# Liquidity forward-state and flash-loan sizing specification

Version: 5.0.0. Updated: 2026-10-14.
Status: local implementation verified; production admission disabled pending deployment and live proofs.
This document supersedes v4's Rust-only architecture, unconditional latency claims,
pre-order Fast Feed assumption, and signed-buffer patching instructions.

## Client outcome and audience

A developer/operator can capture coherent pool state, inspect reserves and covered
price ranges, project a supported exact-input swap, and calculate an exactly quoted
flash-loan size. Every result preserves source identity, mathematical coverage,
native units and operation identity. The result is a conditional calculation, not
a prediction of unknown transactions or a guarantee of future ordering/profit.

The audience is quantitative developers and operators integrating the existing
Arbitrum/Sui liquidity runtime. The approved implementation decisions are TypeScript
production math, both chains, bounded best-found sizing, measured performance, and
per-adapter live proof before production admission.

## Scope and non-goals

Implemented: V2 integer projection/inverse search; existing V3 multi-tick and static
ERC20/no-hook V4 math wrapped in v4 artifacts; separate Cetus X64 math; common-head
Arbitrum capture; strict parsing/schema fixtures; wallet-free worker/CLI; checked
handoff to the existing simulation/signing runtime; both-direction comparison;
unsigned Morpho/Balancer multi-venue Arbitrum compilation; benchmark tooling.

Additional implemented profiles: Algebra Integral linked-tick capture/math and authenticated
executor callbacks; rollback-only V4 hook/dynamic-fee VM quotation; complete Cetus
BCS/object digest and tick-table decoding; checkpoint/version proof and cancellable
native stream reconciliation; unsigned Cetus Sui lender PTBs; DeepBook input-token
fee order-book quotation; conditional cross-profile sizing.

Admission boundaries: Algebra plugin quotes require input-bound fee evidence;
V4 quotes use the quoter sender and require fresh executor-context simulation.
DeepBook DEEP-funded fees and arbitrary venue compilation are unsupported.
Unsigned Sui PTB construction is locally verified, not a live Move execution proof.
Updated Solidity contracts require reviewed deployment/code pins. Production admission
remains disabled until per-combination execution, custody and receipt proofs exist.
There is no cross-chain atomic flash loan, guaranteed optimum for sampled searches,
automatic subscription purchase, Stylus rewrite or io_uring requirement.

## Alternatives considered; selected approach and why

The original Rust-native proposal conflicts with the owner's selected TypeScript
implementation and already-installed bigint V3 math. Reuse those production modules
and keep Rust as an independent replay/reference implementation. Keep X64 and Q96
tick conversion/rounding separate. Worker threads prevent bounded CPU searches from
blocking source ingestion without adding a runtime dependency.

A continuous optimum or finite-difference Brent root is useful as a seed, but cannot
prove the maximum of rounded quotes across arbitrary liquidity regimes. Search exact
native amounts under explicit work limits; report best-found unless every admissible
quantum in the declared domain was tested.

## Source state and causality

Arbitrum capture pins every read, code revision and decimal lookup to one L2 block,
then rechecks the hash. Pool IDs and fee dependencies enter the snapshot digest.
V2 fee ratios are operator-supplied revision profiles, not RPC-discovered generic
fees: a matching code hash alone does not admit the supplied fee profile.

Fast Feed publishes tentative activity after ordering/execution, supplies neither
complete state nor replay, and is not a pending mempool. Do not apply an already
executed transaction again. A projection carries its pre-state digest, logical
operation ID and operation class. Classification changes do not change replay identity.

Sui capture checks checkpoint-coherent versions, canonical full-object BCS/digests,
package origins and linked table completeness. Latest-object references are accepted
only when their previous transaction committed at or before the target checkpoint;
changed historical versions require archive proof and fail closed otherwise. Native
stream reconciliation journals first, bounds backfill and cancels stalled reads.

## Exact V2 mathematics

Let x,y be raw native reserves, a the gross input, and F/D the retained fee multiplier:

    out = floor(a F y / (x D + a F))
    x' = x + a
    y' = y - out

Use actual integer reserves as authoritative. Reverse token ordering explicitly
for token1 input. Reject unknown assets, zero reserves, invalid ratios and uint112
balance overflow. Zero charged fees (F=D) are valid if the protocol revision permits them.

The continuous expression, before output rounding, is:

    P' = x y / ((x + a)(x + (F/D)a))

The v4 document's added output-reserve fee numerator was incorrect. The exact
integer price is y'/x', not the continuous expression. Display token1 per token0
with 10^(decimals0-decimals1); preserve a rational fraction without floating point.

For a lower target raw price P*, solve the continuous quadratic:

    gamma a^2 + (1 + gamma) x a + x^2 - x y / P* = 0
    a_seed = (sqrt((1-gamma)^2 x^2 + 4 gamma x y / P*) - (1+gamma)x)/(2 gamma)

The implemented inverse uses bounded integer binary search directly, returning
the smallest input reaching the threshold. Clamp its ceiling to reserve capacity.
Inverse targets are raw token1/token0 fractions; display scaling is separate.

Worked example: x=10000,y=20000,a=1000,F=997,D=1000 gives out=1813,
reserves=(11000,18187), and exact price=18187/11000.

V2 feeAmount is a ceiling of the retained input fee fraction, identified by
feeSemantics=input-retained-ceiling. It is not a separately transferred token amount.

## CLMM tick maps, ranges and prices

Uniswap V3 uses sqrtPriceX96/2^96; Cetus uses sqrtPriceX64/2^64. Convert spot prices
from the square of that fraction and apply decimals only at the display boundary.
Canonical protocol TickMath determines exact ticks; logarithms/linear tick displacement
are not authoritative.

Every traversal needs complete bitmap words or a complete protocol-specific tick-table
window. Preserve per-step rounding, empty V3 word-boundary steps, fees and signed
liquidity changes. Downward crossings subtract liquidityNet; upward crossings add it.
Reaching a boundary outside the output's supported tick window rejects the projection,
including exact-input exhaustion at that boundary. Do not emit an unparseable next state.

Within one active interval, virtual native reserves are L Q/s and L s/Q.
They are not actual pool custody balances. Inspection returns actualReserves only
for V2, virtualReserves for CLMMs, covered lower/upper prices, initialized tick count,
and fee-exclusive active-interval capacities. Those capacities exclude fees and
changes to L at a boundary; they are not an entire-horizon trade limit.

A position's inventory additionally requires its own L and bounds A,B:

    effective = clamp(s, A, B)
    token0 = floor(L Q (B-effective)/(effective B))
    token1 = floor(L (effective-A)/Q)

Accrued position fees are excluded. Do not reconstruct all positions from active L.

Static no-hook ERC20 V4 uses directionally packed protocol fees composed with the
LP fee. Native-currency state may be captured/inspected, but the existing quote path
does not admit native V4 swaps. Hooks, dynamic fees and Algebra revisions need exact,
revision-specific state and math; generic V3 fallback is rejected.

DeepBook is an order book: use its matching rules, lots, tick size, DEEP fees and
exact swap endpoints. Its flash-loan fee/receipt rules are separate from trading fees.

## Public interfaces and effective schema

The v3 contracts remain unchanged. schemas/liquidity-analytics.schema.json describes
v4 project, size, target-price and inspect requests/results. Runtime parsers are
authoritative for semantic widths, identity, coverage and protocol restrictions;
passing JSON Schema is not execution admission.

PoolStateEnvelope contains:
- chain identity and pool ID/address;
- adapterRevision and runtime code hash or Sui package digest;
- ordered assets and decimals;
- canonical/projected classification and applied logical-operation digests;
- protocol-tagged reserves, fees, price, liquidity and coverage.

ProjectionRequest binds snapshotDigest, operationId/class, tokenIn, amountIn and
optional maxSteps. ProjectionResult includes consumed/unspent input, output, fee
semantics, rational prices, crossings, complete projected state and its digest.
Current projections consume all input or reject; partial successful fills are not emitted.
Projection never overwrites canonical storage.

SizingRequest binds an ordered same-identity pool set and circular route, borrow
asset, minimum/maximum/quantum, lender availability, exact fee ratio, conservative
cost in the borrow asset, cost evidence digest and minimum profit. Cross-asset costs
require an independently admitted valuation upstream; no USD/DEEP conversion is invented.

SizingResult includes feasible bounds, chosen amount, debt, costs/net profit,
exact quoted legs, rejected-quote counts, evaluation count and optimality. No profitable
size returns zero selected amounts and no route legs.

Unsigned payload handoff re-quotes the selected amount, checks every result field and
leg, and rejects projected/mismatched snapshots. The existing runtime still requires
admission, current exact-payload simulation, final preflight, risk budgets, an exclusive
nonce/gas lease and authoritative effects. Neither fee/coverage claims nor a digest
self-authenticate the caller's source evidence.

## Deterministic sizing

Default cap: 512 quote evaluations; maximum route length: six distinct pools.
Quantize bounds, clamp lender availability, first-pool V2 reserve capacity and Sui
u64 inputs. A caller must derive maximum from risk and coverage, not a 30% reserve rule.

For a two-V2 route, retain integer fee denominators in the closed-form stationary
seed. Evaluate nearby quanta, domain endpoints, up to 64 supplied boundary inputs
and their neighbors, and 64 evenly spaced amounts. Repeatedly bisect the eight best
sampled intervals with deterministic lower-amount tie-breaking until the budget ends.
Deduplicate evaluations and bound each CLMM walk to 4096 steps.

If the domain fits the budget, evaluate every quantum and report certified.
Otherwise report best-found. Certificate scope is the declared, quantized domain
under supplied adapter/cost assumptions, not all possible routes or chain outcomes.

    debt(q) = q + ceil(q * lenderFeeNumerator / lenderFeeDenominator)
    net(q) = exactRouteOutput(q) - debt(q) - conservativeCost(q)

The current request supports a conservative constant aggregate cost; amount-dependent
external fees require a separate admitted adapter model rather than silently treating
them as constant. Return no selection below the minimum profit. Never hardcode live fees.

## CLI, distribution and examples

Run from the repository root:

    npm run build
    npm run liquidity -- project schemas/examples/liquidity-project-v4.json
    npm run liquidity -- size schemas/examples/liquidity-sizing-v4.json
    npm run liquidity -- compare schemas/examples/liquidity-sizing-v4.json
    npm run liquidity -- prepare-arbitrum schemas/examples/liquidity-prepare-v4.json
    npm run liquidity:benchmark

Use inspect with {schemaVersion:"4.0",pool:...}, or target-price with pool, tokenIn,
target:{numerator,denominator}, and maximum. Examples are synthetic and unadmitted.

compare evaluates the supplied circular traversal and its reverse separately,
with at most 512 evaluations each. It clears direction-specific boundary hints
for reverse, keeps Sui type equality case-sensitive, and reports an infeasible
direction without discarding the other. A forward tie wins deterministically.

prepare-arbitrum additionally requires the coherent v3 source snapshot and a
secret-free binding: lender kind/address, deadline, per-pool root/revision/code
pins, adapter identity/revision, expiry and gas budget. It validates inputs even
when no trade is selected. Morpho requires a zero lender fee. Selected quotes
become exact per-leg minimum outputs; the gross executor profit floor includes
conservative costs. V3/V4 price limits stay inside the captured coverage;
static no-hook V4 uses the executor's zero pool sentinel and pinned manager.
Projected state, unknown revisions, native V4 currencies and dynamic hooks are
rejected. Output contains unsigned calldata and a re-quoted candidate, or null
for both when there is no selection. Preparation performs no RPC, signing or
submission; feed candidates and exact payloads into the existing independently
admitted execution adapter and LiquidityRuntime. Supplied root/fee assertions
alone do not establish protocol or deployment admission.

snapshot-analytics-arbitrum accepts schemaVersion=4.0, rpcUrl, sourceId, cursor,
pools and optional blockNumber. Each pool declares address, expectedCodeHash,
adapterRevision and protocol; V2 adds feeNumerator/feeDenominator, V3 adds bitmap
positions/range, and V4 additionally supplies the exact PoolKey.

The published dist and schemas include worker code and examples. Source workers use
the existing development tsx loader explicitly; compiled workers do not need it.
Analytics input files are bounded to 4 MiB. Workers have a 128 MiB old-generation
heap limit and a configurable 1–60000 ms deadline (default 10000 ms).
Successful JSON goes to stdout; bounded error codes go to stderr with nonzero exit.

## Risks, acceptance criteria and evidence

Local tests must prove native integer rounding, both directions, unequal decimals,
inverse thresholds/oversized ceilings, fee dust, signed crossing, coverage exhaustion,
wrong digests/assets/fields/chains, operation reclassification/replay, deterministic
sizing, small-domain exhaustive equivalence, schema-valid results and source/built CLI.
Preparation tests also decode the actual executor ABI for V2/V3/static V4,
cover asymmetric domain exhaustion and Sui coin case, and run the chosen
candidate through a shadow simulation with forbidden signing/submission methods.

The V2 suite has 10,000 deterministic adjusted-balance invariant vectors. The independent
pinned Cetus SDK run verified 10,000 cases: 9,908 complete quotes, 92 coverage rejections,
and 2,406 cases with crossings. Seventy-nine representative SDK-generated fixtures are
checked into schemas/examples for default offline tests. Reproduce the full run by
installing @cetusprotocol/cetus-sui-clmm-sdk@5.1.8, tslib@2.8.1 and @mysten/sui@1.21.2
in a separate temporary directory, then run npm run liquidity:cetus-reference -- <dir>.
That SDK is not a runtime or project dependency. Pinned-chain V3 comparison is separate
evidence; do not call SDK/local mathematical tests chain execution proof.

E2E admission remains five seams:
1. source → coherent state or explicit recovery;
2. independently verified math → finite-size route;
3. actual compiled payload → fresh simulation and repayment/custody proof;
4. exclusive lease → signed submission through timeout/restart/cancellation;
5. authoritative effects → debt, treasury profit, fees and gas reconciliation.

Every enabled adapter combination requires fork/localnet proofs and an actual
authorized low-notional profitable live trade. Marker strings alone do not establish
these outcomes. Record artifacts, source/build digests, state pins, transaction IDs
and independent receipts. Synthetic funded venues, skips and read-only simulations
remain labelled separately. Missing opportunities/configuration leave admission pending.

## Environment contract; rollout and rollback

Read-only math needs no secrets or network. Capture needs a reviewed HTTPS RPC or
local test endpoint; production requires independent source/package/fee admission.
Use the existing secret-loading boundaries and public operator/treasury/budget
configuration. Keep private keys/passwords out of JSON, logs and memory.

Release local analysis first, run shadow integration, then independently admit each
chain/adapter combination. Preserve existing execution gates. Removing the new
analytics commands leaves existing v3 workflows intact. Revoke admission on source
gaps, changed code/packages/fees, unknown debt/custody, exhausted budgets or ambiguous sends.

## Performance and post-delivery evidence

Benchmarks report p50/p95/p99, observed heap delta, quote work, worker roundtrip and
event-loop delay with Node/OS/CPU provenance. Heap delta includes GC and is not an
allocation count. Network, signing and feed latency are excluded from the synthetic
math benchmark. Publish source-to-decision measurements separately before setting SLAs.
The old 35 ns/2.5 microsecond numbers and zero-allocation claim are not release criteria.

Whole-product delivery remains incomplete until outstanding protocol decoders/math,
route compilers, deployment bindings, operator budgets and live canary receipts are supplied.
The System Map must remain non-Done until those independent proofs pass.

## Primary references

- [Uniswap V2 pair](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)
- [Uniswap V3 SwapMath](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/SwapMath.sol)
- [V4 ProtocolFeeLibrary](https://github.com/Uniswap/v4-core/blob/main/src/libraries/ProtocolFeeLibrary.sol)
- [Cetus math source revision](https://github.com/CetusProtocol/cetus-clmm-sui-sdk/blob/980669159f2c23499e5a08586841e1daf7f5fc60/src/math/clmm.ts)
- [Cetus tick conversion](https://github.com/CetusProtocol/cetus-clmm-sui-sdk/blob/main/src/math/tick.ts)
- [Arbitrum Fast Feed](https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/fast-feed)
- [Sui gRPC](https://docs.sui.io/develop/accessing-data/grpc)
- [DeepBook swaps](https://docs.sui.io/onchain-finance/deepbook/deepbookv3/contract-information/swaps)
- [DeepBook flash loans](https://docs.sui.io/onchain-finance/deepbook/deepbookv3/contract-information/flash-loans)
- [EIP-1559 signing payload](https://eips.ethereum.org/EIPS/eip-1559)
