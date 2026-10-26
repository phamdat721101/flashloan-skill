# Aero v2 routing: Aerodrome + Uniswap V2/V3/V4, quoter-verified live sends

`AeroSplitFlashExecutorV2` is a new artifact. `AeroSplitFlashExecutor` (V1), its selectors and its proofs are unchanged.

## Gaps closed

| # | Gap in V1 | V2 behavior | Where |
|---|---|---|---|
| G1 | No send path | `aero run` captures, plans, simulates and sends through `LiquidityRuntime` + `EvmLiquidityExecutionAdapter` (Aero `RouteCodec`) | `src/aero/live.ts`, `src/liquidity/arbitrum-execution.ts` |
| G2 | Exact-head freshness, serial reads | Multicall3 batching (viem), concurrent pool capture, `bounds.maxBlockLag` (0..5, default 0 = V1 behavior) | `src/aero/capture.ts`, `src/aero/execution.ts` |
| G3 | Trace per dynamic-fee candidate | Model search with the block fee (`dynamic-snapshot`); top-K (`limits.quoteTopK`, default 3) re-quoted exactly by `quoteAeroSplit`, which borrows, swaps and always reverts `AeroQuote(outputs,fees)`. Only quoter-verified plans are sendable (`quoteSource:'evm-quoter'`) | contract, `src/aero/evm-host.ts`, `src/aero/solver.ts` |
| G4 | V2 leg encoded a quoted output; external V2 uncapturable | Output computed on-chain from reserves and actual input with a factory-pinned fee (`configureV2Fee`); capture takes `v2FeePips` | contract, `src/aero/capture.ts` |
| G5 | Aerodrome only | Discovery adds Uniswap V2, V3 (100/500/3000/10000), and hookless V4 standard keys | `src/aero/capture.ts` |
| G6 | Each leg validated twice | Validated once before the loan (`idle` forbids config changes mid-route) | contract |
| G7 | Morpho only | Morpho, Balancer V2 (fee-capped), Uniswap V4 PoolManager (`unlock`/`take`/`settle`, fee 0) | contract |
| G8 | Coarse sampling | `limits.refine`: golden-section search on principal keeping the best branch proportions | `src/aero/solver.ts` |
| G9 | No bidding | Tip = min(cap, net profit × `bidShareBps` / gas); `estimateEvmFees(..., priorityFeePerGas)` | `src/aero/execution.ts`, `src/evm-fees.ts` |
| G10 | Fixed tick window | Live loop recaptures once at double radius on `INCOMPLETE_TICK_COVERAGE` | `src/aero/live.ts` |

## Contracts and data

- Leg: `(venueVersion, root, pool, tokenIn, tokenOut, minAmountOut, fee, sqrtPriceLimitX96, tickSpacing, stable, generation, hooks)`. The venue versions are:
  - 2: Uniswap V2
  - 3: Uniswap V3
  - 6: Aero classic
  - 7: Slipstream
  - 8: Uniswap V4. `pool` is zero and `root` is the PoolManager. Only `trustedV4Pool[poolId]` keys are accepted; hooks, the dynamic-fee flag and native currency are rejected.
- Route: `(kind 1 Morpho | 2 Balancer | 3 V4, lender, flashAsset, flashAmount, branches[≤8]{amountIn, legs[2..6]}, minProfit, deadline)`.
- Factory generations: 1 Aero classic, 2..4 Slipstream, 5 Uniswap V2, 6 Uniswap V3, 7 V4 PoolManager.
- Request `aero-split/1.1` is additive over 1.0, and both versions parse. It adds:
  - `uniswap-v4` state with `poolKeyId` and zero `hooks`
  - the `external-v4` generation
  - the `dynamic-snapshot` fee profile
  - the `uniswap-v4` lender
  - `bounds.maxBlockLag`
  - `limits.quoteTopK` and `limits.refine`
- Result: optional `quoteSource`.
- Live config `aero-live-config/1.0`: `config/aero-v2-live.json`.
- Live results `aero-live/1.0`: `.nim/aero-live/8453-<signer>.json`, holding status, tx hash, tip and budget.

## Live policy (review decisions)

- 1A: `BASE_SUBMISSION_URL` is required, and there is no fallback to the read RPC. Set it to `https://mainnet.base.org` to send through the public sequencer RPC.
- 2A: the model only ranks candidates. The on-chain quoter admits them, and the final simulation runs against the current head.
- 3A: the first reverted receipt halts the lane (`LIVE_REVERT`). `aero run --resume` clears it after review.
- Existing caps still apply: `EvmBudget` allows 3 trades and 0.002 ETH of gas per signer. The signing lock and attempt journal are shared.

## Commands

```sh
npm run aero:test                       # Node + Foundry (V1 and V2)
npm run aero:v2-local-e2e               # EDGE-05: Anvil, quoter, shared-runtime send, front-run revert accounted
npm run build && node scripts/aero-v2-manifest.mjs   # read-only Base discovery -> manifest, registry, live config
AERO_RUN_FORK=1 AERO_FORK_BLOCK=<n> node scripts/aero-v2-fork-e2e.mjs   # EDGE-06: real EvmDeployment + real-pool parity
node scripts/verify-aero-implementation.mjs --feature v2 [--deployment docs/deployments/base-aero-v2-<date>.json]
npm run evm -- deploy --manifest config/aero-v2-base-mainnet.json --env-file <owner env>
BASE_SUBMISSION_URL=https://mainnet.base.org npm run aero -- run --config config/aero-v2-live.json --env-file <owner env> --output .nim/aero-live/run.json
```

## Evidence (2026-10-24)

- Foundry: 9 V2 tests. They cover:
  - all three lenders
  - on-chain V2 output
  - CL legs and V4 legs under Morpho and inline under the V4 lender, with a strict delta-netting mock
  - forged, duplicate and partial callbacks
  - the quoter always reverting without moving funds
  - single validation costing less gas than V1
- Node: 7 V2 tests, including a CRITICAL regression test showing the multi-venue codec reproduces the adapter's original guards.
- Local e2e: a quoter-verified plan was sent through the shared runtime, with repayment and custody proven. A front-running rival produced an on-chain revert, which was accounted as `REVERT_GAS_ACCOUNTED`. Anvil has no OP `l1Fee`, so a labeled localhost adapter injects `l1Fee=0`.
- Fork e2e (Base block 53028443):
  - The real `EvmDeployment` configured and read back all 28 roots.
  - 16 real pools were quoted on-chain, and 15 match the model to the wei.
  - The one mismatch is a dynamic-fee Slipstream pool, where the model is 0.0175% conservative. This is why admission requires the quoter.
- Uniswap V4: Base has no liquid hookless WETH/USDC V4 pool (both standard-key pools are empty), and the manifest excludes empty pools. V4 execution is proven by the strict Foundry mock only.

## Not in scope

- Pool-as-lender flash swaps.
- V4 pools with hooks, a dynamic fee, or native ETH.
- Modeling the Aerodrome dynamic-fee formula. Snapshot fee plus quoter admission stands in for it.
- Persisting model/quoter mismatches across runs. Each plan is re-quoted.
