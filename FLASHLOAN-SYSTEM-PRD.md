# Flashloan System v8: PRD and Implementation Specification

Version: 8.0.0. Date: 2026-11-03. Status: **Approved for implementation** (gstack eng review 2026-11-03, decisions D1–D4).
Live sending (R7) still needs a positive shadow verdict and explicit owner approval.
Repositories: `rollover-skill` (engine, execution) and `hypermove/hypermove-app` (MCP discovery and search).
The same file lives in both repository roots. Change both copies together.

## Contents
- Product brief (delivery gate): client outcome → post-delivery evidence
- Implementation specification §1–§16 (below)

## Client outcome
The owner learns, per chain and per day, whether capturable atomic flashloan profit exists, and captures it when it does.
The agent runs discover → watch → plan → (gated) execute from one prompt, with honest coverage.
Today realized profit is $0, and polling arbitrage is measured as saturated (§3).
v8 turns the system into a search-engine-fed, per-block trigger engine with optimal allocation and a shadow ledger that proves or disproves edge before money moves.

## Audience
- Owner/operator of `rollover-skill` (quantitative developer).
- The flashloan agent skill.
- Public MCP clients of hypermove (stateless research only). See §2.

## Scope
- hypermove H1–H5: inventory v3, V4 resolution and hook policy, movers v2, watchlist, registry.
- rollover-skill R0–R9: accuracy fixes, V4 quotes, trigger lane, incremental search, allocation API, ingestion, shadow ledger, live path, executor coverage, allocator consolidation.
- Networks: base, robinhood and arbitrum (full lane); ethereum (research).
- Decision D1: full scope, with live owner-gated.

## Non-goals
- Sandwiching or user front-running.
- Directional or meme speculation.
- A liquidation bot (owner direction).
- The Sui PTB lane.
- Asynchronous agent services inside a loan.
- A second backrun implementation in Rust.

See §15.

## Alternatives considered
1. **Keep polling, add more protocol adapters.** Rejected: 7 integration families tested negative, and polling best is +$0.00007 (§3).
2. **Liquidation bot.** Rejected by the owner: a professional-team market.
3. **Social or meme-signal directional trading.** Rejected: flash capital cannot hold inventory, and social data has no sentiment field (§5.2 is rank-only).
4. **Rust daemon backrun (`flashloan-daemon` SpeculateV2).** Deferred: it is V2-only; TypeScript reuses the existing V4/CL quoters.
5. **Mid-price gap screening as the decision.** Rejected: it produced phantom gaps (zero liquidity, hidden hook fees).

## Selected approach and why
- A search engine (hypermove watchlist) plus a per-block trigger engine plus closed-form allocation plus a registry admission ladder (§1, §4).
- Why: the only observed ≥ $100 DEX profits were same-block backruns.
- Exact quotes at a pinned block are the only trustworthy price.
- The fold seed removes the 353 s sizing bottleneck.
- Shadow mode measures capture against competitors before any live risk.

## Risks
- Private RPC latency still loses to incumbents (measured by the shadow ledger).
- Adversarial hooks (execute-to-quote plus allowlist).
- Watchlist misses the profitable pool (anchors, coverage, seeds).
- Fold invalid across ticks or non-CPMM hops (mandatory refine, `probe_bracket`).
- Schema drift across repos (EDGE-08).
- Consolidation regressions (EDGE-09).

Full table in §12.

## Acceptance criteria
- EDGE-01…EDGE-10 pass with their log markers (§11, §14).
- Existing suites stay green: `npm test`, `npm run evm:test`, hypermove `npm run flashloan:test`.
- v1/v2 MCP outputs are byte-identical with flags off.
- p50 trigger→plan < 800 ms on fixtures.
- Live enablement additionally needs ≥ 7 days of shadow per chain with Σ `WE_WOULD_WIN` net > projected gas + 2× margin, plus explicit owner approval.

## Rollout and rollback
- **Rollout:** 5 PRs in two lanes (§13). Every capability sits behind default-off flags (`features.v8.*`, `FLASHLOAN_*_V*`). Shadow runs first.
- **Rollback:** turn the flag off. Outputs return byte-identical to v7 (EDGE-01, EDGE-09).
- **Live:** the first revert halts the lane; `--resume` needs owner action. No migration of stored data is required.

## Environment contract
Secret-free keys and runtime requirements are in §10. Rollover needs private RPC/WS per chain and Node ≥ 22 for the trigger lane. hypermove needs per-network RPC and the v8 flags. No secret values are stored in either repo.

## Post-delivery evidence
- Per chain: the `.nim/v8/<chain>-<date>.jsonl` shadow ledger (opportunity/1, shadow-ledger/1) with daily totals by outcome.
- EDGE-05 fork receipt and reconciliation.
- `nim-skill deliver verify --map FLASHLOAN-SYSTEM-PRD.md` handover.
- For live: execution receipts (`evm-execution-receipt.schema.json`) and loss-ledger entries.
- Record with `nim-skill deliver record`.

---

# Implementation specification

1. Executive summary
2. Users and outcomes
3. Evidence baseline
4. Architecture and boundary rules
5. Data schemas
6. Allocation formulas
7. hypermove MCP implementation
8. rollover-skill implementation
9. Scaling to all DeFi protocols
10. Environment contract
11. Verification plan and E2E
12. Failure modes
13. Delivery plan: PRs, lanes, tasks
14. System map (nim-deliver)
15. What already exists / not in scope
16. Eng review record (decision ledger, report)

---

## 1. Executive summary

**Problem.** The flashloan stack is mechanically mature: 297 Node tests, deployed executors, exact quoters and atomic receipts.
Realized profit is still **$0**. Live measurement shows top-of-block polling arbitrage between liquid pools is saturated:
- Base: best +$0.00007 on 2026-11-03, and its sizing took 353 s.
- Robinhood: at most +$0.31, unverified.
- Arbitrum: never positive.

Every tested protocol integration closed negative. The only historical ≥ $100 DEX arbitrages on Base were **same-block backruns** of a large swap.

**Solution.** Four parts:
1. **Search engine** (hypermove). Turns market data into a typed, liquidity-verified **watchlist**: tokens, every pool including Uniswap V4 with full keys, and real in-range depth. Social and market signals rank only.
2. **Trigger engine** (rollover-skill). Mirrors watched pools and reacts per block to swaps. It re-quotes only touched pools and sizes in closed form within one block.
3. **Allocation solver.** n-hop virtual-reserve folding gives an optimal seed, then marginal-equalizing splits, lender choice and exact refinement. All repo allocators are consolidated onto it.
4. **Registry-driven integration.** Each protocol is a registry entry plus an adapter implementing one of five interfaces. Admission requires a positive native proof.

Everything ships behind default-off flags. Shadow mode must show capture before any live send.

**Non-goals.**
- Sandwiching or other front-running of users.
- Directional or meme speculation: flash capital cannot hold inventory across blocks.
- A professional liquidation bot (owner direction, 2026-11-01). Liquidation targets stay registry-only and research-only.
- Asynchronous agent-service settlement inside a loan.

---

## 2. Users and outcomes

| User | Outcome | Measured by |
|---|---|---|
| Owner/operator | Knows, per chain and day, whether capturable atomic profit exists, and why or why not | Shadow ledger: would-be profit, competitor capture, miss reasons |
| Agent (flashloan skill) | One prompt runs discover → watch → plan → (gated) execute with honest coverage | Typed outputs at every hop; `coverage` and `excluded_counts` never omitted |
| MCP public client | Stateless discovery: inventory with V4 keys and depth, multi-source movers, watchlist, registry | Schema-valid responses, bounded latency, no execution |

---

## 3. Evidence baseline (do not re-litigate)

| Lane | Evidence | Result |
|---|---|---|
| Base polling cycle arb | `.nim/base-live-20261103/` (blocks 53464760–53464943, 165 pools, 23 scans) | best +$0.00007 at $100, edge 0.545 bps; sizing 353 s [measured] |
| Base polling, 2026-10-30 | `.nim/cycle-watch/base-20261030*` | best +$0.0022 [measured] |
| Base trending tokens | same dir, run B (81 pools, 20 scans) | no positive edge; aggregator gaps were stale or fee-blind [measured] |
| Robinhood polling | `.nim/robinhood-live-20261103/` | +$0.31 at $231 (V2 0x59f9 ↔ V3 0x146a), persisted ~1,260 blocks; tax and executor unchecked; 84/157 pools V4 and unpriced [measured] |
| Robinhood mid-price gaps | same dir | largest were phantom (zero active liquidity) or overstated (V4 lpFee=0 with hook fee) [measured] |
| Base historical ≥ $100 DEX arbs | `docs/state/active_session.md` (2026-10-30) | 30 in 17 h, all same-block backruns 1–2 tx after the trigger; max $2,339 [measured, re-measure before gate] |
| Bankr / Reserve / Spectra / Pendle / yield exits / TokenJar | `.nim/base-*` reports | all negative or downgraded |
| Morpho liquidations (Base) | 30-day study | ~$1.41M gross, professional teams; owner: not the niche |

**Binding lessons** (`.nim/lessons.jsonl` and gstack learnings; provisional unless noted):
- Aggregator price gaps rank only. Exact same-block quotes decide.
- A concentrated-liquidity pool with zero active liquidity has a phantom price.
- V4 `lpFee=0` can hide a hook fee.
- A generic V4 adapter must not quote nonzero hooks without execution and a code-hash pin (gstack `v4-hook-quote-gate`, 10/10).
- Recheck cancellation immediately before signing (gstack `abort-after-final-rpc-before-send`, 10/10).
- The portable V2 executor requests `leg.minAmountOut` itself (gstack `portable-v2-requested-output`, 10/10).
- The Robinhood RPC ignores `getLogs` topic filters.
- Permit2 fixed-infinite allowance: check the existing allowance first.
- Never value deferred claims as repayment cash.
- REA `inspect_evm_interface` is unavailable on macOS: use the code-override quoter.
- Extend the engine instead of chaining one-off scripts.

---

## 4. Architecture and boundary rules

```
                    hypermove-app (MCP, stateless, minutes cadence)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ H3 movers v2 ── DexScreener, GeckoTerminal, on-chain pool creation       │
 │      │            signals → score (rank only)                            │
 │      ▼                                                                   │
 │ H1 discovery → inventory v3 ── H2 V4 resolution (key, hooks, state)      │
 │      │                          + active liquidity, virtual depth        │
 │ H4 watchlist v1      H5 registry v1 (venues, lenders, converters)        │
 └──────┬───────────────────────────────────────────────────────────────────┘
        │ JSON over MCP or files: watchlist.v1 / inventory.v3 / registry.v1
        ▼
                    rollover-skill (engine, per-block cadence)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ R1 universe verify (pinned block, factory/code hash, token-behavior/1)   │
 │ R2 state mirror ◄── WS logs (address-filtered), coalesced per block      │
 │ R3 trigger worker: requote touched edges → findCycles(through dirty)     │
 │ R4 allocation: fold seed → λ split → lender → exact refine → net         │
 │ R5 gate: executor eth_call sim + measured gas + budget + flags           │
 │      ├── shadow: opportunity ledger + competitor join (default)          │
 │      └── live: recheck → private relay → receipt reconcile (approved)    │
 └──────────────────────────────────────────────────────────────────────────┘
```

**Boundary rules (binding):**
- **B1.** hypermove owns public facts; rollover-skill owns validation, policy and receipts (decision log 2026-10-29).
  hypermove never sizes, signs or sends. rollover-skill never ranks tokens from the web.
- **B2.** hypermove `state` and `depth` are for filtering and ranking only. rollover-skill **re-reads all state at its own pinned block** before any quote. A hypermove price never enters a quote or an acceptance (finding 8).
- **B3.** The registry is discovery-only. Execution roots, lenders and executor addresses come from rollover-skill's reviewed `config/*.json`, which remains the source of truth (finding 12).
  A registry entry missing from config is ignored for execution and reported as `NOT_ROOTED`.
- **B4.** The only coupling is versioned JSON. rollover-skill accepts the same documents from files, for offline runs and replay.

---

## 5. Data schemas (normative)

Conventions:
- Token amounts are decimal strings (`^(0|[1-9][0-9]{0,77})$`) in raw units.
- Addresses are lowercase hex.
- Asset IDs use CAIP-19 (`eip155:8453/erc20:0x…`; native `eip155:8453/slip44:60`).
- Every document has `schema_version`, `observed_at`, a block anchor where applicable, and `coverage`.
- Additive changes bump the minor version; removals bump the major version. v2/v1 outputs stay byte-identical when new flags are off.

### 5.1 `flashloan.inventory.v3` (hypermove → rollover). Extends v2 at hypermove `discovery.ts:9`.

```ts
pool = {
  id: string,                                       // sha256 of canonical reference
  reference:
    | { kind:'evm_contract', chainId, address }
    | { kind:'evm_v4', chainId, manager, poolId }    // already in the v2 union; v3 actually emits it for resolved V4
    | { kind:'provider_opaque', network, provider, providerPoolId }   // only when unresolved
    | { kind:'sui_object', network:'mainnet', objectId },
  asset_ids: [assetId, assetId],                    // token0, token1 order (V4: currency0 < currency1)
  protocol: string, family: 'V2'|'SOLIDLY_VOLATILE'|'SOLIDLY_STABLE'|'V3'|'ALGEBRA'|'V4'|'CURVE'|'BALANCER'|'OTHER',
  labels: string[],
  pool_key?: { currency0, currency1, fee:int, tickSpacing:int, hooks },
  hook?: { address, code_hash, allowlisted:boolean },          // V4 with hooks only
  fee_mode: 'static'|'dynamic'|'hooked'|'unknown',
  state?: { block:string, block_hash, sqrt_price_x96?, tick?:int, active_liquidity?, reserve0?, reserve1?, lp_fee_pips?:int },
  depth: { reported_liquidity_usd:decimal|null, virtual_depth_usd:decimal|null },  // CL: 2·L·√P; V2: 2·reserve1; USD
  flags: { zero_active_liquidity:boolean, stale_price_suspect:boolean },
  liquidity_eligible: boolean|null, eligibility_reasons: string[],
  capabilities: { state, quote, funding, simulation },   // quote.status 'simulation_only' for hooked V4
  provenance: [{ source, provider_pool_id, observed_at }]
}
```

Rules:
- All `state` in one response shares one `block_hash`.
- `zero_active_liquidity` makes the pool ineligible, with reason `ZERO_ACTIVE_LIQUIDITY`.
- A failed state read gives `STATE_UNAVAILABLE`, never zero liquidity.
- Unresolved V4 stays `provider_opaque` with `UNRESOLVED_POOL_KEY`.
- B2 applies: the state is for filtering only.

### 5.2 `flashloan.movers.v2` (hypermove)

```ts
{ schema_version:'flashloan.movers.v2', started_at, completed_at, parameters,
  chains:[{ network, chain_id, outcome, coverage:{ …v1 fields, source_results[] },   // per-source SUCCESS|FAILED|UNSUPPORTED
    tokens:[{ rank, token_id, symbol, name,
      sources:('dexscreener.search'|'dexscreener.profile'|'dexscreener.boost'|'geckoterminal.trending'|'onchain.pool_created'|'onchain.v4_initialize'|'seed')[],
      signals:{ change_m5_pct, change_h1_pct, change_h24_pct, volume_m5_usd, volume_h24_usd, volume_spike_z,
                buys_m5, sells_m5, imbalance_m5, pools_with_active_liquidity:int, venues:int, age_hours,
                paid_visibility_only:boolean, socials_declared:string[] },        // self-declared, unverified
      exclusions:string[],                                                         // TAX_SUSPECT, AGE_LT_MIN, SINGLE_POOL, ZERO_LIQ_ONLY …
      score:number }] }],                                                          // rank only
  warnings }
```

Score (deterministic; weights are configuration values, defaults shown):

`score = 1.0·clip(volume_spike_z,0,5) + 0.8·|imbalance_m5| + 1.2·ln(pools_with_active_liquidity) + 0.6·ln(1+venues) + 0.5·clip(|change_h1_pct|/10,0,3) − 2·[paid_visibility_only]`

A token with any exclusion is not ranked. A token with fewer than 2 live pools gets `SINGLE_POOL`.

### 5.3 `flashloan.watchlist.v1` (the search engine's product)

```ts
{ schema_version:'flashloan.watchlist.v1', network, chain_id, observed_at, registry_version, ttl_seconds:int /*120*/,
  tokens:[{ token_id, score, reasons:string[] }],
  pools:[ inventory.v3 pool ],                 // eligible pools touching watched tokens, plus anchor pools
  anchors:[assetId],                           // flash/settlement assets (WETH, USDC, USDG …)
  coverage:{ tokens_considered, tokens_watched, pools_considered, pools_watched, truncated:boolean } }
```

Budget: ≤ 30 tokens and ≤ 400 pools per chain (public limits raised through env within tested bounds).

### 5.4 `flashloan.registry.v1` (hypermove serves; rollover pins `registry_version`; discovery-only per B3)

```ts
{ schema_version:'flashloan.registry.v1', registry_version:sha256, networks:{ [network]:{
   venues:[{ id, family, factory, init_code_hash?, pool_code_hash?, quoter_kind:'exact_override'|'v4_state_quoter'|'onchain_quoter', cpmm:boolean, status:'reviewed'|'research' }],
   lenders:[{ id, kind:'morpho'|'balancer_v2'|'balancer_v3'|'aave_v3'|'v3_flash'|'v4_flash', address, code_hash, fee_bps, callback, assets:'any'|assetId[] }],
   converters:[{ id, kind:'erc4626'|'lst_wrap'|'index_redeem'|'pt_yt'|'other', address, preview_fn, status }],
   hooks:[{ address, code_hash, status:'allowlisted'|'research', reviewed_at }],
   liquidation_targets:[{ id, kind, address, status:'research' }],
   executors:[{ id, address, code_hash, venues:[venueId], lenders:[lenderId] }] }}}
```

### 5.5 rollover-skill internal and ledger schemas

```ts
'token-behavior/1'  = { chain_id, token, block, transfer_tax_bps, sell_ok, blacklist_suspect, method:'eth_call_override' }
'watch-event/1'     = { chain_id, block, block_hash, tx_hash, log_index, pool, kind:'swap'|'sync'|'modify_liquidity', received_at_ms }
'allocation-plan/1' = { start_asset, lender:{ id, fee_bps }, principal_raw,
                        seed:{ method:'fold_closed_form'|'probe_bracket', d_star_raw, cpmm_hops:int, non_cpmm_hops:int },
                        legs:[{ hop, splits:[{ pool, amount_in_raw, quoted_out_raw, executor_min_out_raw, priced_out_raw }] }],  // priced = min(quoted, executor-requested)
                        refine:{ method:'golden_section'|'grid', evaluations }, min_out_raw, deadline_block }
'opportunity/1'     = { schema_version, chain_id, block, trigger:{ tx_hash, log_index }|null, cycle:{ start, route:[pool], tokens:[addr] },
                        edge_bps, allocation:allocation-plan/1, gross_raw, net_raw, net_usd,
                        gas:{ units, source:'executor_eth_call'|'model', l1_fee_wei },
                        latency_ms:{ event_to_plan, plan_to_sim },
                        verdict:'SHADOW_RECORDED'|'REJECTED'|'STALE'|'SUBMITTED', reject_reason? }
'shadow-ledger/1'   = { opportunity_id, block, would_be_net_usd,
                        competitor:{ tx_hash, from, to, realized_start_asset_raw, block_offset, method:'block_receipts_transfer_flow' }|null,
                        outcome:'WE_WOULD_WIN'|'COMPETITOR_CAPTURED'|'NOBODY'|'UNCERTAIN'|'STALE', miss_reason? }
```

Existing schemas remain authoritative for execution: `evm-execution-receipt.schema.json`, `evm-admission-evidence.schema.json`, `candidate-ledger/1`.

---

## 6. Allocation formulas (normative; implemented in `src/evm/cycle-engine.ts`)

Notation:
- A hop maps input `d` to `f(d) = γ·d·R_out/(R_in + γ·d)`, with `γ = 1 − fee` and **virtual** reserves.
- V2/Solidly-volatile: actual reserves.
- V3/V4/Algebra, inside the current tick: `R_in, R_out = L/√P, L·√P` (orientation by direction; raw units; P = token1/token0).
- φ = lender fee fraction; g = gas in start-asset raw units.

**6.1 Fold (constant-product hops only).** Hop a (`a_in, a_out, γ_a`) then hop b (`b_in, b_out, γ_b`):

```
E_in  = a_in·b_in / (b_in + γ_b·a_out)
E_out = γ_b·a_out·b_out / (b_in + γ_b·a_out)
γ     = γ_a
f_ab(d) = γ·d·E_out / (E_in + γ·d)
```

Fold left to right over every hop.
If any hop is not constant-product (`registry.venues[].cpmm=false`: Solidly-stable, Curve, Balancer weighted or stable), skip the closed form:
`seed.method='probe_bracket'`, and the bracket comes from the probe edge and the shallowest pool's virtual depth (finding 6).

**6.2 Optimal principal:**

```
d* = max(0, (√(γ·E_in·E_out/(1+φ)) − E_in)/γ)
profit(d*) = f(d*) − d*·(1+φ) − g
```

Edge exists iff `γ·E_out/E_in > 1+φ`.

**6.3 Refinement.** If d* moves any CL hop across its tick boundary, or the seed is `probe_bracket`, run `maximizeConcave` on `[d*/4, 4·d*]` with exact quotes (8–20 evaluations).
The exact quote always wins over the closed form.

**6.4 Parallel pools on one hop** (KKT, `docs/ratio.md:40`).
- Allocate so marginal outputs are equal: `q_i'(a_i) = λ`. Closed form per pool: `a_i(λ) = max(0, (√(γ_i x_i y_i/λ) − x_i)/γ_i)`. Bisection on λ until Σa_i equals the hop input.
- Opening a pool costs `c_open = g_leg`.
- The λ solution seeds `splitAmount(…, openCost)` (greedy marginal chunks, 8 chunks).

**6.5 Lender selection.** Among config-rooted lenders (B3) with `available ≥ d*`, minimize `φ·d* + g_lender`.
Default order: Morpho (0) → Balancer (0) → V3/V4 flash (pool fee) → Aave V3 (5 bps).
If d* exceeds every lender, cap d at the maximum available unless the executor supports nested lenders.

**6.6 Executor-requested output.** Each leg's `priced_out_raw = min(quoted_out_raw, executor_min_out_raw)`, where `executor_min_out_raw` is the amount the executor itself requests (e.g. the portable V2 executor requests `leg.minAmountOut`).
Net is computed from `priced_out_raw`, never from the larger quote (finding 3).

**6.7 Acceptance:**

```
net = priced_out(d) − d·(1+φ) − gas_units·basefee_eff − l1_fee     (start-asset raw, one block)
accept ⇔ net > max(min_profit_abs, k·σ_gas) ∧ executor eth_call succeeds ∧ every token passes token-behavior/1
          ∧ every hooked V4 pool is allowlisted (live only)
```

`min_profit_abs` and `k` are configuration values, replacing the hard-coded reservation-as-cost and $10 floor at `src/evm/acceptance.ts:176–178`. Defaults keep current behavior.

**6.8 Screening cap** (hypermove ranking only): `cap_usd ≈ V_shallow·(√(1+g′) − 1)²`, with g′ the gap net of both pools' fees.

**6.9 Consolidation (D4).** `cycle-engine.ts` exports the single allocation API: `foldCycle`, `seedPrincipal`, `solveSplitLambda`, `splitAmount`, `maximizeConcave`, `chooseLender`.
`src/liquidity/price-gap.ts`, `src/route-solver.ts` and `src/adaptive-sizing.ts` migrate onto it with parity tests (EDGE-09), and their private allocators are deleted.

---

## 7. hypermove MCP implementation

Precondition: `main` has 61 uncommitted modified files. Commit or stash the owner's pending work, then branch `flashloan-v8`.

| ID | Change | Files | Flag |
|---|---|---|---|
| H1 | Emit `inventory.v3`: typed `evm_v4` refs, `family`, `fee_mode`, one-block `state` (V2 `getReserves`; V3 `slot0`+`liquidity`; Algebra `globalState`+`liquidity`; V4 StateView `getSlot0`+`getLiquidity`), `virtual_depth_usd`, flags | `src/lib/mcp/flashloan/discovery.ts` (schema :9, records :123–127); a new `depth.ts` only if `discovery.ts` passes 300 lines | `FLASHLOAN_INVENTORY_V3` |
| H2 | Enable `flashloan_resolve_pool_inventory_v1` for base and robinhood with reviewed PoolManager/StateView addresses and code hashes. **Hook policy (D2):** report hooked pools with `fee_mode:'hooked'`, `hook.code_hash`, `capabilities.quote='simulation_only'`. No reserve-math quote for hooked pools. | `pool-resolution.ts:114`, `evm.ts:70`, `contracts.ts`, `public-contracts.ts` | `FLASHLOAN_POOL_RESOLUTION_V1` |
| H3 | `movers.v2`: GeckoTerminal trending pools (`/api/v2/networks/{net}/trending_pools`), on-chain creation (`PoolCreated` and V4 `Initialize` from registry factories, address-filtered ranges), signals, score, exclusions. A network the source does not list → `UNSUPPORTED`, outcome `PARTIAL` (finding 13). | `movers.ts` (:67), new `sources/geckoterminal.ts` | `FLASHLOAN_MOVERS_V2` |
| H4 | `flashloan_get_watchlist_v1`: movers v2 → H1 discovery for top-K → filter → `watchlist.v1` | `public-mcp.ts`, `public-contracts.ts`, `public-worker.ts` | `FLASHLOAN_WATCHLIST_V1` |
| H5 | `flashloan_get_registry_v1`: typed registry including the `hooks` allowlist; `registry_version` = sha256 of canonical JSON | `networks.ts`, `contracts.ts`, `public-mcp.ts` | `FLASHLOAN_REGISTRY_V1` |

Public tool I/O:

| Tool | Input | Output | Limits |
|---|---|---|---|
| `flashloan_get_watchlist_v1` | `{ network, max_tokens≤30, max_pools≤400, min_virtual_depth_usd=5000, seed_tokens?[], exclude_tokens?[] }` | `watchlist.v1` | ≤ 25 s, 1 public concurrency |
| `flashloan_get_registry_v1` | `{ networks?[] }` | `registry.v1` | cached |
| `flashloan_discover_arbitrage_pools` | unchanged + `schema_version?:'v2'|'v3'` | inventory v2 (default) or v3 | unchanged |
| `flashloan_get_token_movers` | unchanged + `schema_version?:'v1'|'v2'` | movers v1 (default) or v2 | unchanged |

Failure semantics:
- Every source failure appears in `source_results` and makes the outcome `PARTIAL`.
- A state-read failure gives `STATE_UNAVAILABLE`.
- No silent omission anywhere.

Tests go in `tests/flashloan-v8-*.test.ts` (vitest), next to `tests/flashloan-public.test.ts`.

---

## 8. rollover-skill implementation

Precondition: commit the uncommitted engine (`src/evm/cycle-engine.ts`, `src/evm/cycle-watch.ts`, `contracts/ExactSwapQuoter.sol`, `src/test/cycle-engine.test.ts`), then branch `flashloan-v8`.
Flags live under `config/flashloan-integration-versions.json` → `features.v8` (an object next to `integrationV7`).

| ID | Change | Files (existing first, WR-04) | Flag |
|---|---|---|---|
| R0a | Drop zero-active-liquidity CL pools; record skips | `src/evm/cycle-watch.ts` `classifyPools` (:54) | `activeLiquidity` |
| R0b | `token-behavior/1` probe (transfer + sell via `eth_call` state override) | `src/evm/pool-universe.ts` | `tokenBehavior` |
| R0c | Executor-measured gas via `eth_call` at the same block; the model becomes a labelled fallback | `cycle-watch.ts` `evaluateCycle` (:137), constants (:31) | `measuredGas` |
| R0d | Configurable `min_profit_abs`, `k`, reservation semantics | `src/evm/acceptance.ts:176–178`, `schemas/evm-acceptance-config.schema.json` | always on (defaults = current) |
| R1 | V4 pools: accept `evm_v4` + `pool_key`; fall back to `src/evm/v4-resolution.ts`. Quote through `contracts/V4StateQuoter.sol` as a code override: hooks execute, so hook fees count. Hooked pools are research-only unless allowlisted (D2). | `cycle-watch.ts` `createExactQuoter` (:33), `classifyPools` | `v4Quotes` |
| R2 | State mirror plus WS trigger: Swap/Sync/ModifyLiquidity logs **by address only** (V4: PoolManager, demultiplexed by `id`). **Coalesce per block** (Base: per flashblock): one requote batch per block per dirty pool set (finding 10). Native WS needs Node 22+ or an injected WebSocket (finding 5). | transport from `src/liquidity/l2-sources.ts`, producer/worker from `src/liquidity/trigger-watcher.ts`; new `src/evm/trigger-lane.ts` | `triggerLane` |
| R3 | Incremental search: pre-indexed cycle → edge map; search only cycles with a dirty edge. **Cap** `max_cycles` (default 50,000, best-K by probe edge) with a 2 s rebuild budget; report `truncated` (finding 11). | `src/evm/cycle-engine.ts` | `triggerLane` |
| R4 | Allocation §6: `foldCycle`, `seedPrincipal`, `solveSplitLambda`, `chooseLender`, `priced_out` rule | `src/evm/cycle-engine.ts` | `foldSeed` |
| R5 | Watchlist/registry ingestion: `--watchlist <file|mcp:net>`, `--registry`; pin `registry_version`; B2/B3 enforced | `src/evm/cli.ts` (cycle-watch :56), `src/evm/discovery.ts` | `watchlist` |
| R6 | Shadow ledger. **Competitor join (finding 7):** for blocks b..b+2, read `eth_getBlockReceipts`, pick txs touching any route pool, compute net start-asset Transfer flow to non-pool addresses. A positive flow is `COMPETITOR_CAPTURED`; ambiguous flows (internal or contract-held) are `UNCERTAIN`. | new `src/evm/shadow-ledger.ts` | `shadow` (on with `triggerLane`) |
| R7 | Live path: re-simulate at the head. **Recheck cancellation, staleness and flags immediately before signing and again before submission (finding 2).** Send via the private relay. Reconcile through `evm acceptance-reconcile` (`src/evm/cli.ts:16`), extended with the Arbitrum runtime's reconcile logic (`src/liquidity/arbitrum-execution.ts:20,307`) for Base/Robinhood (finding 4). The first revert halts the lane. | `src/evm/acceptance.ts`, `src/execution-lock.ts`, `src/loss-ledger.ts`; relay pattern from `crates/flashloan-scan/src/arb.rs` | `live` (off; needs an admission producer and owner approval) |
| R8 | Executor coverage: roots for PancakeSwap V3, Aero CL and Hydrex (Base) and Robinhood venues; deploy `NativeV4FlashExecutor` (legacy executors untouched, per the binding decision) | `config/base-mainnet.json`, `config/robinhood-mainnet.json`, deployment manifests | deployment approval |
| R9 | Allocation consolidation (D4): migrate `price-gap.ts`, `route-solver.ts`, `adaptive-sizing.ts` onto the §6.9 API; delete the private allocators | those files + `cycle-engine.ts` | none (behavior-preserving; EDGE-09 parity) |

CLI (new modes on the existing command):

```
evm cycle-watch --chain 8453 --watchlist <file|mcp:base> --registry <file|mcp> \
  --trigger ws --ws-url $BASE_WS_URL --shadow --out .nim/v8/base-<date>.jsonl \
  [--min-profit-usd 0.05] [--max-hops 3] [--max-cycles 50000] [--live]
# --live is refused unless features.v8.live, an admission producer and owner approval are present
```

Latency budget (Base 2 s blocks; Robinhood sub-second) [estimated]:

| Step | Budget |
|---|---|
| Event to dirty set | < 50 ms |
| Requote touched edges (batched) | < 250 ms |
| Fold seed and λ split | < 5 ms |
| Refine | < 300 ms |
| Executor simulation | < 150 ms |
| **Total, p50** | **< 800 ms** (p95 < 1.5 s) |

A missed budget yields `STALE`, which is never sent.

---

## 9. Scaling to all DeFi protocols on supported networks

Supported networks:
- base, arbitrum, robinhood: full lane.
- ethereum: research.
- sui: registry only; the existing PTB path is separate.

Adapter interfaces (one class per family, in existing `src/evm/` or `src/liquidity/` modules):

```ts
interface VenueAdapter     { family; cpmm: boolean; readState(pools, block): PoolState[]; quote(state, tokenIn, amountIn): bigint;
                             virtualReserves(state, dir): [bigint, bigint, number]; encodeLeg(split): Hex; requestedOut(split): bigint }
interface LenderAdapter    { kind; available(asset, block): bigint; feeBps: number; encodeLoan(asset, amount, inner: Hex): Hex }
interface ConverterAdapter { kind; preview(amountIn, block): bigint; encode(amountIn, minOut): Hex; synchronous: true }  // deferred outputs rejected
interface TargetAdapter    { kind; scan(block): Target[]; encode(target): Hex }                                         // research-only
interface TriggerAdapter   { subscribe(addresses, onEvent): Unsubscribe }                                                // WS, flashblocks, Timeboost
```

Admission ladder (never skipped):
1. `research`: registry entry and adapter with unit vectors.
2. `quote_parity`: equals the on-chain quoter or a fork swap at ≥ 3 sizes on ≥ 2 blocks.
3. `native_proof`: positive round-trip net on a pinned fork, all fees included.
4. `shadow`: ≥ 7 days of ledger rows.
5. `reviewed`: owner approval, config roots, and (for hooks) the code-hash allowlist.

Priority backlog:

| Priority | Family | Why |
|---|---|---|
| 1 | Uniswap V4 including hooks (D2 policy) | Majority of Robinhood depth; Base trending tokens |
| 2 | Algebra/Hydrex, PancakeSwap V3, Aero CL | Found by the scanner; executor lacks roots |
| 3 | Curve stable / Balancer | Stable and LST cycles (`probe_bracket` seed) |
| 4 | ERC-4626 and LST converters | Synchronous conversion edges |
| — | Index redeem, PT/YT, auctions | Tested negative; `research` only |

---

## 10. Environment contract (secret-free)

| Key | Repo | Needed for | Placeholder |
|---|---|---|---|
| `BASE_RPC_URL`, `BASE_WS_URL` | rollover | R2 (the public RPC is insufficient) | `https://<provider>/base`, `wss://<provider>/base` |
| `ROBINHOOD_RPC_URL`, `ROBINHOOD_WS_URL` | rollover | R2 | `https://<provider>/robinhood` |
| `ARBITRUM_RPC_URL`, `ARBITRUM_WS_URL` | rollover | R2 | — |
| `PRIVATE_RELAY_URL` | rollover | R7 only | — |
| `FLASHLOAN_MCP_URL` | rollover | `mcp:` sources | `https://mcp.overguild.com` |
| Node ≥ 22 (or injected WebSocket) | rollover | R2 native WS | runtime |
| `FLASHLOAN_INVENTORY_V3`, `FLASHLOAN_MOVERS_V2`, `FLASHLOAN_WATCHLIST_V1`, `FLASHLOAN_REGISTRY_V1`, `FLASHLOAN_POOL_RESOLUTION_V1` | hypermove | H1–H5 | `false` |
| per-network RPC endpoints | hypermove | state reads | existing `engine.options.endpoints` |

TLS hostname verification is always on. The DexScreener and GeckoTerminal public endpoints need no keys.

---

## 11. Verification plan and E2E

**Prerequisite T0 (blocks EDGE-05).** Select one historical Base same-block backrun of ≥ $100 from the 2026-10-30 study.
Record `{ block, trigger_tx, backrun_tx, realized_raw }` in `test/fixtures/v8-backrun-base.json`, re-verified from chain receipts (finding 9).

| Edge | Seam | Proof | Pass criterion |
|---|---|---|---|
| EDGE-01 | schema | vitest round-trip for inventory v3, movers v2, watchlist v1, registry v1; v1/v2 defaults unchanged | old snapshots byte-identical; invalid fixtures rejected with codes |
| EDGE-02 | quotes | Fork: V4StateQuoter override vs actual fork swap on hooked and hookless V4 pools (Base, Robinhood) | equal to the wei |
| EDGE-03 | allocation | Property tests: `foldCycle`+`seedPrincipal` vs brute force (2–4 CPMM hops); `probe_bracket` for non-CPMM; λ split vs exhaustive; `priced_out=min`; zero-liquidity drop; taxed token reject | seed inside the refine bracket; split ≤ 1 chunk from exhaustive |
| EDGE-04 | trigger | Replay `watch-event/1` fixtures, including Robinhood unfiltered-log responses and bursts of many swaps in one block | one requote per pool per block; result equals a full scan at that block; cycle cap reports `truncated`; p50 < 800 ms |
| EDGE-05 | e2e | Anvil fork at T0 block − 1, inject the trigger tx, run watchlist → lane → allocation → executor | plan found; executor repays and nets > 0; receipt reconciles; our net ≥ 50% of the historical realized |
| EDGE-06 | shadow | Ledger join on fixture blocks with known competitor txs, including contract-held profit | correct `COMPETITOR_CAPTURED`/`UNCERTAIN`; ≥ 90% agreement with hand-labelled samples |
| EDGE-07 | live | `--live` without flags/admission refuses; stale refuses; **cancellation during the final awaited verification asserts zero sends**; first revert halts | all refusals logged with codes; zero sends |
| EDGE-08 | mcp | hypermove watchlist from recorded provider fixtures and a fork RPC → rollover consumes it unchanged | parse ok; `registry_version` pinned; B2/B3 enforced (hypermove state never quoted; unrooted entry `NOT_ROOTED`) |
| EDGE-09 | consolidation | Golden parity: price-gap, route-solver and adaptive-sizing outputs before vs after migration on existing fixtures | byte-identical plans or documented intended diffs |
| EDGE-10 | hooks | A hooked pool without an allowlist entry: researched (quoted by execution) but refused at live acceptance | `HOOK_NOT_ALLOWLISTED` |

**Coverage map:**

```
CODE PATHS (proposed)                                 FLOWS
[+] hypermove                                         [+] discover → watchlist → engine
  ├── inventory v3 build ......... EDGE-01, EDGE-08     ├── [→E2E] EDGE-08 cross-repo
  ├── V4 resolution + hook policy  EDGE-01, EDGE-10     └── [→E2E] EDGE-05 fork backrun
  ├── movers v2 sources/score .... EDGE-01            [+] failure states
  └── registry ................... EDGE-01, EDGE-08     ├── source FAILED/UNSUPPORTED → PARTIAL (EDGE-01)
[+] rollover-skill                                      ├── state read fail → STATE_UNAVAILABLE (EDGE-01)
  ├── classify/active-liq/tax .... EDGE-03              ├── stale budget → STALE, no send (EDGE-04, EDGE-07)
  ├── V4 quote override .......... EDGE-02              ├── cancel during final verify → zero sends (EDGE-07)
  ├── trigger lane + coalesce .... EDGE-04              └── hook not allowlisted → refused (EDGE-10)
  ├── allocation (fold/λ/lender) . EDGE-03
  ├── shadow ledger + join ....... EDGE-06
  ├── live gate .................. EDGE-07
  └── consolidation parity ....... EDGE-09
```

**Chaos threats** (generated by `nim-skill deliver chaos --map FLASHLOAN-SYSTEM-PRD.md`), each covered by its edge proof:

| Edge | Threat | Required behavior in the proof |
|---|---|---|
| EDGE-01 | Transport drops during payload transmission (schema) | A truncated or aborted provider/MCP response is rejected by schema validation. The source is marked `FAILED`, the outcome `PARTIAL`; never parsed as an empty success. |
| EDGE-02 | A dependency exceeds its deadline (quotes) | A quote `eth_call` past its per-step budget marks the edge unpriced (`QUOTE_TIMEOUT`); the opportunity becomes `STALE`. No fallback to a cached quote. |
| EDGE-03 | Concurrent calls mutate the same state (allocation) | A new block arriving mid-plan invalidates the plan. Allocation is pure over one pinned block snapshot, and the executor simulation re-runs at the newest block; a mismatch gives `STALE`. |
| EDGE-04 | Malformed, empty or oversized input (trigger) | Malformed logs dropped with a counter; empty watchlist = idle; oversized Robinhood log responses capped and split by block range; the watchlist TTL is enforced. |
| EDGE-05 | A later step fails after an earlier mutation (e2e) | Executor revert leaves zero balance change (atomic). Ledger rows use atomic writes (`src/evm/storage.ts` `atomicJson`), so a crash never leaves a half-written row. A live revert halts the lane. |

Every planned branch maps to an edge proof. Existing suites (`npm test`, `npm run evm:test`, hypermove `flashloan:test`) must stay green.

**Go/no-go for live (R7):**
- EDGE-01…10 pass.
- ≥ 7 days of shadow per chain with Σ `WE_WOULD_WIN` net > projected gas + 2× margin.
- Explicit owner approval.

---

## 12. Failure modes

| Path | Realistic failure | Handling | Test | User sees |
|---|---|---|---|---|
| WS subscription | Provider drops the socket | Reconnect with backoff; gap → full rescan at head; `STALE` meanwhile | EDGE-04 | `STALE` rows, logged reason |
| Robinhood logs | Topic filters ignored → huge responses | Address-only filters, response-size cap, per-block coalescing | EDGE-04 | no impact |
| V4 hooked pool | Hook reverts or charges a hidden fee | Quoted by execution; revert → edge dropped; live needs allowlist | EDGE-02, EDGE-10 | `HOOK_NOT_ALLOWLISTED` / `QUOTE_REVERT` |
| Fold seed | Tick crossing or non-CPMM hop | Mandatory exact refine; `probe_bracket` | EDGE-03 | none |
| Executor output | Executor requests less than the quote | `priced_out=min` | EDGE-03 | lower net, not overstated |
| Competitor join | Profit kept in a contract | `UNCERTAIN` outcome, never counted as a miss or a win | EDGE-06 | explicit uncertainty |
| Live send | Timeout halts the attempt but a late RPC completes | Recheck right before sign and submit | EDGE-07 | zero sends |
| Registry drift | Registry lists an unrooted venue | B3: `NOT_ROOTED`, ignored for execution | EDGE-08 | coverage note |
| Consolidation | A migrated caller changes output | Golden parity | EDGE-09 | none |

No failure mode is silent, untested and unhandled. Critical gaps: 0.

---

## 13. Delivery plan

**PRs** (one per wave; 5 in total):

| PR | Repo | Content | Depends on |
|---|---|---|---|
| 1 | hypermove | H1, H2, H5 + EDGE-01 schema tests | — |
| 2 | rollover-skill | commit existing engine; R0a–d, R1, R4, R9 + EDGE-02/03/09/10 | — |
| 3 | hypermove | H3, H4 + EDGE-01 movers/watchlist | PR 1 |
| 4 | rollover-skill | R2, R3, R5, R6 + EDGE-04/06/08, T0 fixture + EDGE-05 | PR 2, PR 3 |
| 5 | rollover-skill | R8 deploy manifests, then R7 live + EDGE-07 | PR 4 and the shadow verdict |

**Parallel lanes:**
- Lane A: hypermove PR 1 → PR 3.
- Lane B: rollover PR 2.
- Then PR 4, which joins both lanes, then PR 5.
- Conflict flag: the schemas in §5 are shared contracts. Freeze them at PR 1 and PR 2 merge.

**Implementation tasks:**

- [ ] **T0 (P1, human ~2h / CC ~15min)**: fixture: pin the historical Base backrun tx (EDGE-05 prerequisite). Files: `test/fixtures/v8-backrun-base.json`. Verify: receipt re-read.
- [ ] **T1 (P1, human ~1d / CC ~1h)**: hypermove: inventory v3 (H1) + schemas. Files: `discovery.ts`, `tests/flashloan-v8-schemas.test.ts`. Verify: EDGE-01.
- [ ] **T2 (P1, human ~1d / CC ~1h)**: hypermove: V4 resolution enable + hook policy (H2). Files: `pool-resolution.ts`, `evm.ts`, `contracts.ts`. Verify: EDGE-01, EDGE-10.
- [ ] **T3 (P2, human ~4h / CC ~30min)**: hypermove: registry v1 incl. hook allowlist (H5). Verify: EDGE-01.
- [ ] **T4 (P1, human ~1d / CC ~1h)**: rollover: R0a–d accuracy fixes. Files: `cycle-watch.ts`, `pool-universe.ts`, `acceptance.ts`. Verify: EDGE-03.
- [ ] **T5 (P1, human ~1d / CC ~1h)**: rollover: V4 quote override (R1). Verify: EDGE-02.
- [ ] **T6 (P1, human ~1d / CC ~1h)**: rollover: allocation API (R4) incl. `priced_out`, `probe_bracket`. Verify: EDGE-03.
- [ ] **T7 (P2, human ~2d / CC ~2h)**: rollover: consolidation (R9). Verify: EDGE-09.
- [ ] **T8 (P1, human ~1d / CC ~1h)**: hypermove: movers v2 + watchlist (H3, H4). Verify: EDGE-01.
- [ ] **T9 (P1, human ~3d / CC ~3h)**: rollover: trigger lane, coalescing, capped index (R2, R3). Verify: EDGE-04.
- [ ] **T10 (P1, human ~1d / CC ~1h)**: rollover: watchlist/registry ingestion, B2/B3 (R5). Verify: EDGE-08.
- [ ] **T11 (P1, human ~1d / CC ~1h)**: rollover: shadow ledger and receipt join (R6). Verify: EDGE-06.
- [ ] **T12 (P1, human ~1d / CC ~1h)**: rollover: fork e2e script (EDGE-05).
- [ ] **T13 (P2, owner-gated)**: R8 roots + NativeV4 deploy.
- [ ] **T14 (P1, owner-gated after shadow)**: R7 live with pre-sign recheck. Verify: EDGE-07.

---

## 14. System map (nim-deliver)

```json nim-deliver
{
  "featureId": "flashloan-system-v8",
  "taskType": "feature",
  "status": "Approved",
  "input": {
    "entrypoint": "hypermove: flashloan_get_watchlist_v1 | flashloan_get_registry_v1; rollover-skill: evm cycle-watch --watchlist --registry --trigger ws --shadow [--live]",
    "payload": "flashloan.watchlist.v1 + flashloan.registry.v1 (MCP or files); chain RPC/WS endpoints; config features.v8.*"
  },
  "processing": {
    "apiHops": [
      "hypermove: movers.v2 (DexScreener, GeckoTerminal, on-chain creation) -> discovery inventory.v3 (+V4 resolution, hook policy, one-block state, depth) -> watchlist.v1",
      "rollover-skill: universe verify (pinned block, code hash, token-behavior/1) -> state mirror <- WS logs (address-only, coalesced per block) -> capped incremental findCycles -> fold seed | probe bracket -> lambda split -> lender -> exact refine -> priced_out -> executor eth_call -> shadow ledger | live recheck -> relay -> acceptance-reconcile"
    ],
    "datastores": [
      ".nim/v8/<chain>-<date>.jsonl (opportunity/1, shadow-ledger/1)",
      "config/flashloan-integration-versions.json (features.v8)",
      "config/base-mainnet.json, config/robinhood-mainnet.json (execution roots, source of truth)",
      "hypermove registry config (registry_version, hook allowlist)",
      "test/fixtures/v8-backrun-base.json"
    ],
    "services": ["Chain RPC/WS (read)", "DexScreener, GeckoTerminal (public read)", "hypermove MCP", "PRIVATE_RELAY_URL (live only)", "Anvil (proofs)"]
  },
  "output": {
    "state": "Typed liquidity-verified watchlist; per-block opportunities with exact quotes, measured gas and closed-form-seeded allocation; shadow ledger comparing would-be vs competitor capture; live sends only under flags, allowlist and approval.",
    "transitions": [
      "discovered -> resolved(v4 key, state, hook) | unresolved(reason)",
      "watched -> triggered(block) -> planned -> simulated -> SHADOW_RECORDED | REJECTED(reason) | STALE",
      "SHADOW_RECORDED -> WE_WOULD_WIN | COMPETITOR_CAPTURED | NOBODY | UNCERTAIN",
      "live: rechecked -> submitted -> reconciled | halted(LIVE_REVERT) | refused(code)"
    ]
  },
  "seams": [
    { "id": "schema", "description": "inventory.v3, movers.v2, watchlist.v1, registry.v1 additive versions" },
    { "id": "quotes", "description": "V4 hooked/hookless exact quotes via V4StateQuoter override" },
    { "id": "allocation", "description": "fold seed, probe bracket, lambda split, lender, priced_out, exact refine" },
    { "id": "trigger", "description": "address-filtered WS logs, per-block coalescing, capped incremental cycle search" },
    { "id": "e2e", "description": "pinned-fork historical backrun replay through the executor" },
    { "id": "shadow", "description": "opportunity ledger and block-receipt competitor join" },
    { "id": "live", "description": "flags, admission, pre-sign recheck, stale refusal, first-revert halt" },
    { "id": "mcp", "description": "hypermove watchlist consumed unchanged; B2/B3 boundary rules" },
    { "id": "consolidation", "description": "legacy allocators migrated with golden parity" },
    { "id": "hooks", "description": "hook allowlist enforced at live acceptance" }
  ],
  "edgeProofs": [
    { "edgeId": "EDGE-01", "seamId": "schema", "command": "npm --prefix ../../hypermove/hypermove-app exec vitest run tests/flashloan-v8-schemas.test.ts", "logMarker": "FLV8_EDGE_01", "sourceFiles": ["../../hypermove/hypermove-app/tests/flashloan-v8-schemas.test.ts"] },
    { "edgeId": "EDGE-02", "seamId": "quotes", "command": "node --test --test-name-pattern=FLV8_EDGE_02 dist/test/flashloan-v8.test.js", "logMarker": "FLV8_EDGE_02", "sourceFiles": ["src/test/flashloan-v8.test.ts", "contracts/V4StateQuoter.sol"] },
    { "edgeId": "EDGE-03", "seamId": "allocation", "command": "node --test --test-name-pattern=FLV8_EDGE_03 dist/test/cycle-engine.test.js", "logMarker": "FLV8_EDGE_03", "sourceFiles": ["src/test/cycle-engine.test.ts", "src/evm/cycle-engine.ts"] },
    { "edgeId": "EDGE-04", "seamId": "trigger", "command": "node --test --test-name-pattern=FLV8_EDGE_04 dist/test/flashloan-v8.test.js", "logMarker": "FLV8_EDGE_04", "sourceFiles": ["src/test/flashloan-v8.test.ts", "src/evm/trigger-lane.ts"] },
    { "edgeId": "EDGE-05", "seamId": "e2e", "command": "node scripts/flashloan-v8-fork-e2e.mjs --chain 8453 --fixture test/fixtures/v8-backrun-base.json", "logMarker": "FLV8_EDGE_05", "sourceFiles": ["scripts/flashloan-v8-fork-e2e.mjs", "test/fixtures/v8-backrun-base.json"] },
    { "edgeId": "EDGE-06", "seamId": "shadow", "command": "node --test --test-name-pattern=FLV8_EDGE_06 dist/test/flashloan-v8.test.js", "logMarker": "FLV8_EDGE_06", "sourceFiles": ["src/test/flashloan-v8.test.ts", "src/evm/shadow-ledger.ts"] },
    { "edgeId": "EDGE-07", "seamId": "live", "command": "node --test --test-name-pattern=FLV8_EDGE_07 dist/test/flashloan-v8.test.js", "logMarker": "FLV8_EDGE_07", "sourceFiles": ["src/test/flashloan-v8.test.ts", "src/evm/acceptance.ts"] },
    { "edgeId": "EDGE-08", "seamId": "mcp", "command": "node scripts/flashloan-v8-mcp-e2e.mjs", "logMarker": "FLV8_EDGE_08", "sourceFiles": ["scripts/flashloan-v8-mcp-e2e.mjs"] },
    { "edgeId": "EDGE-09", "seamId": "consolidation", "command": "node --test --test-name-pattern=FLV8_EDGE_09 dist/test/flashloan-v8.test.js", "logMarker": "FLV8_EDGE_09", "sourceFiles": ["src/test/flashloan-v8.test.ts", "src/liquidity/price-gap.ts", "src/route-solver.ts", "src/adaptive-sizing.ts"] },
    { "edgeId": "EDGE-10", "seamId": "hooks", "command": "node --test --test-name-pattern=FLV8_EDGE_10 dist/test/flashloan-v8.test.js", "logMarker": "FLV8_EDGE_10", "sourceFiles": ["src/test/flashloan-v8.test.ts"] }
  ]
}
```

---

## 15. What already exists / not in scope

**Reused, not rebuilt:**

| Existing | Where | Used for |
|---|---|---|
| V4 key resolution (Initialize scan) | rollover `src/evm/v4-resolution.ts`; hypermove `pool-resolution.ts` | R1, H2 |
| V4 exact VM simulation | `src/liquidity/v4-simulation.ts`, `contracts/V4StateQuoter.sol` | R1 |
| Code-override exact quoter | `src/evm/cycle-watch.ts:33`, `contracts/ExactSwapQuoter.sol` | R1, R3 |
| Cycle search, concave sizing, greedy split | `src/evm/cycle-engine.ts` | R3, R4 |
| WS transport; producer/worker | `src/liquidity/l2-sources.ts`, `src/liquidity/trigger-watcher.ts` | R2 |
| Pinned-block universe verification | `src/evm/pool-universe.ts` | R0b, R5 |
| Execution lock, loss ledger, acceptance | `src/execution-lock.ts`, `src/loss-ledger.ts`, `src/evm/acceptance.ts` | R7 |
| Private relay pattern | `crates/flashloan-scan/src/arb.rs` | R7 |
| Inventory v2 `evm_v4` reference kind | hypermove `discovery.ts:12` | H1 |

**Not in scope:**
- Sandwiching and other user front-running (policy).
- Directional meme trading (incompatible with flash funding).
- A liquidation bot (owner direction).
- The Sui PTB lane (separate path).
- Asynchronous agent services (ACP/x402) inside loans.
- Porting the Rust `flashloan-daemon` backrun projector: R2/R3 implement it in TypeScript to avoid two implementations.

---

## 16. Eng review record (gstack /plan-eng-review, 2026-11-03)

Reviewer: Claude (native). Outside voice: skipped (owner preference: no Codex outside pass).

### Reality rows
- REALITY: premise-table pass 21 claims checked, unverified=2 (GeckoTerminal Robinhood network id; GeckoTerminal rate limit) src/evm/cycle-watch.ts:31,33,54,137; src/evm/acceptance.ts:176-178; hypermove discovery.ts:9, evm.ts:70, pool-resolution.ts:114, movers.ts:67
- REALITY: already-done finding V4 resolution, V4 simulation and the trigger producer/worker exist; the plan reuses them (§15)
- REALITY: surface-check finding `reconcileAccounts` was Arbitrum-only (src/liquidity/arbitrum-execution.ts:20); corrected in R7
- REALITY: binding-decisions pass hypermove owns public facts, rollover owns validation/policy/receipts; NativeV4 leaves legacy executors untouched
- REALITY: numbers pass baselines measured (.nim/base-live-20261103, .nim/robinhood-live-20261103); latency [estimated]; $2,339 [re-measure before gate]
- REALITY: deferred-asks pass no linked issue
- REALITY: pr-count finding default one PR per wave; 5 PRs across 2 repos (§13)

### Findings and dispositions
1. [P1] (9/10) hypermove evm.ts:70 no-hook gate vs H2 → **D2 accepted**: execute-to-quote plus code-hash allowlist (§7 H2, §8 R1, EDGE-10). Prior learning applied: v4-hook-quote-gate (10/10, 2026-10-10).
2. [P1] (9/10) R7 pre-sign recheck → **D3 accepted** (§8 R7, EDGE-07). Prior learning applied: abort-after-final-rpc-before-send (10/10, 2026-10-14).
3. [P2] (8/10) executor-requested output → **D3 accepted** (§6.6, §5.5). Prior learning applied: portable-v2-requested-output (10/10, 2026-10-22).
4. [P2] (9/10) reconcile reference → **D3 accepted** (§8 R7).
5. [P2] (9/10) Node 22+ WebSocket → **D3 accepted** (§8 R2, §10).
6. [P2] (8/10) fold valid only for CPMM → **D3 accepted** (§6.1, `probe_bracket`).
7. [P2] (7/10) competitor join → **D3 accepted** (§8 R6, `UNCERTAIN`).
8. [P2] (8/10) hypermove state not for quotes → **D3 accepted** (B2).
9. [P2] (7/10) EDGE-05 fixture → **D3 accepted** (T0).
10. [P2] (7/10) per-block coalescing → **D3 accepted** (§8 R2).
11. [P2] (6/10) cycle index cap → **D3 accepted** (§8 R3).
12. [P2] (7/10) registry vs config source of truth → **D3 accepted** (B3).
13. [P3] (6/10) GeckoTerminal network coverage → accepted with D3 (§7 H3 `UNSUPPORTED`).
14. [P3] (6/10) duplicated allocators → **D4: build in v8** (R9, EDGE-09).
- Scope (D1): **original arrangement kept**; all of R0–R9 and H1–H5 are in v8. R7 stays owner-gated after the shadow verdict.

### Decision ledger
- D1 scope/structure: approved: Original (all items). Answer: AskUserQuestion 2026-11-03.
- D2 hook policy: approved: execute-to-quote + code-hash allowlist for live.
- D3 spec corrections 2–13: approved: apply all.
- D4 allocator consolidation: approved: build in v8 (R9).
- Approval readiness: PASS (D1–D4 cite actual answers).

### Completion summary
- Step 0: Scope Challenge: scope accepted as-is (D1 original)
- Reality rows: 7/7 emitted, 2 unverified premises
- Architecture review: 4 issues (1, 8, 10, 12)
- Code quality review: 4 issues (3, 4, 6, 14)
- Test review: diagram produced, 3 gaps (2, 9, 11) now mapped to EDGE-04/05/07
- Performance review: 2 issues (10, 11)
- NOT in scope: written. What already exists: written.
- TODOS.md updates: 0 (D4 moved the only TODO into scope)
- Failure modes: 0 critical gaps
- Unresolved decisions: 0
- Outside voice: skipped (owner preference)
- Parallelization: 2 lanes, then 2 sequential joins
- Lake score: 3/3 (D2, D3, D4 scored options chose the complete option)

---

## 17. v8.1 amendments (code analysis, 2026-11-04; PR2 scope)

Scope of this run: PR2 only (R0a–d, R1, R4, R9). hypermove untouched. R8 is fork-proof only; mainnet deploy waits for owner approval after shadow data.

- **A1. Allocation math is reused, exact-integer.** `src/liquidity/price-gap.ts` already implements §6.1 (`composeCurves`, Möbius form `f(x)=a·x/(b+c·x)`), §6.2 (`stationaryInput`) and §6.4 (`allocateCpmm`, bigint λ water-filling). R4 moves them into `src/evm/cycle-engine.ts` (the §6.9 API). It does not reimplement the float formulas. Per hop, `a=γn·R_out`, `b=γd·R_in`, `c=γn`. CL in-tick virtual reserves use Q96 integer math: token0 in gives `R_in=L·2^96/√P`, `R_out=L·√P/2^96`, and token1 in is the mirror.
- **A2. R9 premise corrected.** `src/route-solver.ts` has no allocator; it returns the best quote per venue. `src/adaptive-sizing.ts` is a state-bound sampling envelope (deadline, abort, state digest), not duplicate math. `searchAllocation` solves route-subset splits with branch ordering, which is a different problem. All three stay. R9 = `price-gap.ts` imports the moved functions; EDGE-09 = byte parity on recorded fixtures plus the existing evidence suites.
- **A3. Refine is always run.** Prior lesson: a continuous seed is not the integer-floored optimum. Bracket `[d*/4, 4·d*]` for any CL/V4/non-CPMM hop; `[d*/2, 2·d*]` with ≤ 8 evaluations for all-CPMM cycles.
- **A4. Priority-fee competition.** The incumbent Base backrunners we measured pay 3–50 gwei priority fees (`docs/state/active_session.md:1737`). Additive now: `opportunity/1.gas.priority_fee_wei` and acceptance `bidShareBps` (default 0). The bidding model is PR4/PR5.
- **A5. Trigger source (PR4).** `TriggerAdapter` with sources in this order: Base flashblocks WS (sub-block) → `eth_subscribe` logs → HTTP block poll. Each ledger row records `trigger.source` and `lag_ms`. No `*_WS_URL` is currently configured.
- **A6. Measured gas scope.** The Portable executor (MultiVenue venue kinds V2=2, V3=3, V4=4, ALGEBRA=5) encodes V2/V3/Algebra/hookless-V4 cycles. Gas comes from `estimateGas` called by the owner at the same block with `minProfit=1`, and only when model net > 0. Every other cycle reports `gas.source='model'` and `gas_fallback_reason`.
- **A7. R8 needs one deploy, not several.** Pancake V3 and Hydrex/Algebra are owner `configureRoot` txs on the deployed Portable executor; the callbacks already exist. Aero CL is covered by `AeroSplitFlashExecutorV2` (Base). Only `NativeV4FlashExecutor` is deployed, estimated at < 0.0001 ETH per chain, after a fork proof.
- **A8 (review F1).** CL virtual reserves get independent decimal test vectors computed outside the code path, and explicit rounding: `R_in` rounds up and `R_out` rounds down, so the seed never overstates output. Prior learning: `v3-q96-shared-bad-fixture`.
- **A9 (review F3).** `token-behavior/1` is cached per token per run. The balance-slot search is capped at Solidity slots 0–9 plus the Vyper layout, and proxy or ERC-7201 storage returns `UNKNOWN` without further RPC.
- **A10 (review F4).** Before any measured-gas call, read the executor's `owner()` (must equal the operator) and its lender pin. A failed check gives `gas.source='model'` with `EXECUTOR_OWNER_MISMATCH` or `LENDER_NOT_CONFIGURED`.
- **A11 (review F5).** EDGE-02 probes a V4 swap that crosses beyond the supplied bitmap words. If V4StateQuoter reverts there, the words widen up to 8; beyond that the edge is `QUOTE_REVERT`. A failed V4 quote is never read as a zero output.

### 17.1 Eng review of §17 (gstack /plan-eng-review, 2026-11-04)
- D1 structure: **Original arrangement** (user answer). R9 moves `composeCurves`, `stationaryInput` and `allocateCpmm` into `src/evm/cycle-engine.ts`. `price-gap.ts` and `src/evidence/solver.ts` import them from there. EDGE-09 is the existing `flashloan-evidence-gap.test.ts` vectors, unchanged and green.
- D2 fixes F1, F3, F4 and F5: **applied** (A8–A11).
- REALITY: premise-table pass 7 claims checked, unverified=0. Evidence: `contracts/MultiVenueArbitrageExecutor.sol:23,122`; `src/liquidity/price-gap.ts:7,28,34`; `src/evidence/solver.ts:1`.
- REALITY: already-done pass `git log origin/main --since=2026-11-03` touches none of the named files.
- REALITY: surface-check pass `nim-skill deliver` and `evm cycle-watch` exist (`src/evm/cli.ts` diff).
- REALITY: binding-decisions pass. D1–D4 of §16 kept. Owner scope this run: PR2 only, fork-only R8, hypermove untouched.
- REALITY: numbers pass. Balances [measured: cast balance 2026-11-04]; deploy cost [estimated].
- REALITY: deferred-asks pass, no linked issue. PR3–PR5 deferred by owner budget.
- REALITY: pr-count pass, 1 PR (PR2).
- Sections:
  - Architecture: 1 issue (F4, executor trust boundary).
  - Code quality: 1 issue (D1).
  - Tests: 2 issues (F1, F5). Prior learnings applied: v3-q96-shared-bad-fixture and portable-v2-requested-output (A6/§6.6).
  - Performance: 1 issue (F3, RPC fan-out).
  - Outside voice: skipped (owner preference).

### 17.2 PR2 delivery evidence (2026-11-04, branch `flashloan-v8`, uncommitted)
- **Done:** R0a–d, R1, R4, R9 behind `features.v8.*` (all off by default; flag-off output keeps the v7 shape). R8 is fork-proven and the manifests are prepared but not broadcast.
- **EDGE-02:** passed on two live hookless Base ETH/USDC V4 pools at two sizes each (block 53487849): the V4StateQuoter override equals Uniswap's V4Quoter to the wei. **Hooked parity is not proven.** Both Base RPCs refused every `eth_getLogs` page (-32011), so no hooked pool could be discovered. Rerun with `FLV8_EDGE02_BASE_RPC` once logs are available.
- **EDGE-03, EDGE-09, EDGE-10:** all pass. Suites: `npm test` 308 pass / 0 fail / 5 skipped plus cargo green, `npm run evm:test` 22/22, `forge test` 49 pass / 6 skipped. Harness: `.nim/v8-verification.json` (strict, verified). `nim-skill deliver verify --map .nim/v8/pr2-map.md`: passed.
- **R8 fork (Base, block ≈53487925):**
  - NativeV4FlashExecutor deploy takes 2,794,832 gas.
  - Configuring Morpho and the PoolManager succeeds.
  - A backrun of a synthetic 400 ETH trigger netted 0.0757 WETH on a 1 WETH Morpho flash loan, with the lender repaid exactly and execution at 629,722 gas.
  - Evidence: `.nim/v8/fork-native-v4.json`. Root calldata for Pancake V3 and Hydrex is in `docs/deployments/base-portable-roots-v8.json`; neither factory is pinned on the Portable executor today.
- **Live smoke (read-only, Base, 165 pools):**
  - With flags on, the fold seed sizes each near-break-even cycle in 1 evaluation instead of 33. The scan took 15.9 s vs 34.5 s with flags off.
  - Best exact edge was −0.44 to −0.68 bps, so there were still no positive cycles.
  - The token probe found 1 taxed token (excluded), 20 OK and 11 UNKNOWN.
  - 24 V4 pools came back `UNRESOLVED_POOL_KEY` (needs `--v4-scan-from` with working `getLogs`, or inventory v3 `pool_key`).
- **Cross-module fix (WR-02):** the v7 native codec (`src/liquidity/arbitrum-execution.ts`) encoded V4 swaps with `sqrtPriceLimitX96=0`, which a real PoolManager rejects. It now sends directional limits, and a codec test asserts them.
- **Open:**
  - Hooked EDGE-02 parity.
  - R0c measured gas only runs for an unsplit, model-positive best cycle, so it has not fired live.
  - No unit test yet for the "positive exact edge overrides d*=0" rule inside `evaluateCycle`.
  - The hypermove copy of this PRD is not updated (hypermove untouched by owner decision).
  - Mainnet deploy and root txs wait for owner approval.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex (skipped by owner preference) | Independent 2nd opinion | 0 | skipped | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | clean (all resolved into the plan) | 14 + 5 issues (§16, §17.1), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex, plan-review, skipped (owner preference), no findings.
- **VERDICT:** Eng review complete; 14 findings all resolved by approved decisions D1–D4. §17 review: 5 findings resolved by D1 and D2. Ready to implement PR 1 and PR 2; R7 live remains gated on the shadow verdict and owner approval.

NO UNRESOLVED DECISIONS
