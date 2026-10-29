# Feature: flashloan-skill-v7-integration — implementation specification

**Status:** Implementing. SK-00..SK-10 are implemented and proven in lane A (local deterministic Node + Foundry). Lanes B–E are pending owner authorization. **Date:** 2026-10-29. **Base:** `306ca6e`.
**Source:** `docs/flashloan-prompt-v7-skill-remediation-spec-2026-10-29.md`. It is local and gitignored. In this document it is called "the v7 source" and cited by its section ID.
**Companion files:**
- System Map: [flashloan-v7-integration-map.md](flashloan-v7-integration-map.md)
- Ledger: [flashloan-v7-integration.spec.json](flashloan-v7-integration.spec.json)
- Contract: `schemas/flashloan-integration-v1.schema.json` (54,516 bytes, sha256 `1de7fced7a55bccf7fc5c45ab41934087344054961238a48484598944256aaaf`)
- Vectors: `schemas/examples/flashloan-integration-v1/`
- Harness: `src/test/flashloan-v7-integration.test.ts`

## 1. Client outcome

An operator gives one `flash-intent/1` file plus MCP discovery output. The local skill then does the following, in order:

1. Resolves every v4 pool to a canonical `manager + poolId + PoolKey`.
2. Gives every target exactly one disposition.
3. Compiles one effective policy through the existing `compilePolicy`.
4. Sizes and simulates the exact calldata on the matching deployed codec.
5. Signs only when an admitted, authorized, budgeted and fresh plan qualifies under a strict `net > threshold`.

When something is missing, the result names the exact dependency (`nextDependency`) and keeps independent research. A round that finds no trade is a valid outcome, so "no trade" is not a failure.

## 2. What the v7 source gets right, and what this spec adds

The v7 source is a contract-level document. It fixes names, invariants and acceptance rows, but it does not bind them to code. This spec adds the binding:
- exact functions and signatures
- reason codes
- files to touch, limited to existing modules wherever possible
- one test per behavior
- dependency order
- five errata found by executing the contract (§9)

Code facts below were verified against the working tree at `306ca6e`.

| Defect (v7 source) | Where it is in code today | Proven by |
|---|---|---|
| 23 v4 IDs rejected before RPC | `pool-universe.ts:127`: only `reference.kind==='evm_contract'` is accepted. `:129` dedupes by address, so all pools on one PoolManager collapse. `PoolAdapter` (`:10`) has no V4. `parseInventory` (`:63`) accepts inventory.v2 only. | EDGE-01 baseline: `[NOT_EVM_CONTRACT, NO_CODE, DUPLICATE]` |
| Native ETH rejected in quote, prepare and settle | `MultiVenueArbitrageExecutor.sol:204,235` rejects zero currency. `_settleV4` (`:240`) is private and ERC20-only. There is no `receive()`. | SK-05 tests |
| Artifacts drifted | `deployment.ts:237,241` reads mutable `out/` and fails `DEPLOYMENT_ARTIFACT_CHANGED`. `verifyRuntime` (`:76`) handles only the owner immutable. | SK-03 tests |
| Hardcoded acceptance policy | `acceptance.ts:131,178` applies a $10 floor (twice). `:179` caps at $100k. `:174` hardcodes a depeg band. | S-E04 |
| Gas reservation used as cost | `acceptance.ts:176-189` passes all of `budget.remaining('trade')` as `costInBorrowAsset` and `maxGasCost`, which inflates the on-chain floor (`arbitrum.ts:88-90`). | EDGE-02 vectors, SK-04 test |
| Admission bound only to MultiVenue | `loadAdmissionEvidence` (`acceptance.ts:64-66`) hard-binds the `MULTI_LENDER_ROUTE_ABI[0]` selector. | S-E07 |
| No split codec | The adapter defaults to `MULTI_VENUE_ROUTE_CODEC` (`arbitrum-execution.ts:87`). | S-E05 |

## 3. Reuse map: extend these, do not duplicate

| Concern | Reuse | Do NOT create |
|---|---|---|
| v4 pool ID | `deriveV4PoolId` (`state-adapters.ts:310`), which is pure. `poolIdFromKey` stays hook-strict for legacy callers (lesson #19). | A second keccak/abi helper |
| Initialize logs | `discovery.ts:21-68` paging, manager code-hash check and extsload slot | A second log reader |
| Snapshot | `readEvmAnalyticsSnapshot` (`sources.ts:90/263`), whose v4 config is `{address: manager, key}` and which caps at ≤6 configs | A new state reader |
| Policy | `compilePolicy` (`economics.ts:20`), `rawThreshold`, `verifyPlan` (`:54`, strict `>`) | A second policy resolver |
| Uint bound | `uint()` (`liquidity/state.ts:25`, throws `INTEGER_OUT_OF_RANGE`) | Regex-only checks |
| Canonical JSON | `digest()` (`state.ts:31`) canonical bytes. Vector parity is proven in EDGE-03. | A different key sort |
| Fees | `estimateEvmFees`, `receiptNativeCost`, `nativeCostInAsset` (`src/evm-fees.ts:52-84`). `evmProfile(...).feeModel` is `bundled` (Nitro, including 4663) or `op-stack`. | A new fee client |
| Budget, journal, lock | `EvmBudget` (`budget.ts:11`), `assessReadiness` (`:57`), `AttemptJournal` (`liquidity/journal.ts:26`), `ExecutionLock` | A new ledger or queue |
| Execution | `EvmLiquidityExecutionAdapter` with a `RouteCodec` (`arbitrum-execution.ts:27,68`), `LiquidityRuntime` | A new signer |
| Ajv | the `contracts.ts:70-87` pattern | Adding v7 to the shared `strict:true` registry (see erratum E2) |

## 4. Gate and rollout

The gate lives in `config/flashloan-versions.json` at `features.integrationV7: false`. It is read once by `checkCapabilities` (`gap-runtime.ts`). While it is off, every existing command, schema and output stays byte-identical. Test S-E11 diffs today's output for the same approved request.

The new CLI command `integration-run` is registered only in SK-02. Until then, calling it returns `VERSION_UNSUPPORTED`.

## 5. Shared data model (contract `urn:flashloan-integration:1`)

The pipeline order is:

`Intent` → `PoolResolutionRequest`/`Report` → `ResolvedPool[]` → `Policy` + `Cost` → `CandidateLedger` → `Plan` → `ExecutorManifest` + `AdmissionBundle` → `ExecutionEvidence` → `Result`. `Readiness` is computed beside all of these stages.

Encoding rules (v7 source §Shared contract):
- Money, blocks and raw amounts are decimal strings, bounded semantically to ≤ uint256.
- Signed values never use `-0`.
- Prices are positive integer ratios with explicit decimals. No floating point.
- Code and block hashes are lowercase Keccak `0x…32B`. Content hashes are `sha256:` plus hex. The two are never converted into each other.
- Timestamps are RFC3339 with a `Z` suffix.

**Canonical hash.** `domainHash(domain, v) = "sha256:" + hex(sha256(utf8(domain) ‖ 0x0a ‖ canonical(v)))`.
- `canonical` is `digest`'s sorted-key `JSON.stringify` (parity proven by EDGE-03).
- It additionally rejects non-safe-integer numbers (including floats) and lone UTF-16 surrogates (erratum E5).

The domains are:

| Domain | Preimage |
|---|---|
| `flash/effective-policy/1` | Policy minus `policyHash` and `roundId` |
| `flash/executor-manifest/1` | Manifest minus `manifestHash` |
| `flash/execution-plan/1` | The whole Plan (it has no self-hash field) |
| `flash/route-cost/1` | The whole Cost |
| `flash/abi/1` | The canonical ABI array |

`payloadHash` is the sha256 of the decoded unsigned calldata bytes. The legacy `compilePolicy` hash stays as it is today and is carried as `compiledPolicyHash` (raw hex with a `sha256:` prefix added).

**Semantic validators (the v7 source's 9).** Each is owned by exactly one function below. Ajv only checks shape.

| # | Rule | Owner |
|---|---|---|
| 1 | AssetId equals kind/chain/address. No zero ERC20. Pool currencies are uint160-ordered. `poolId == deriveV4PoolId(key)`. | `validateResolvedPool` (SK-01) |
| 2 | Manager code hash and Initialize are at one canonical block. Every reference binds to the same `State`. | `resolveV4Pools` (SK-01) |
| 3 | Ledger IDs are unique. Outcome counts sum to `requested` and to `items.length`. `EVALUATED` requires route-attempt evidence. | `validateCandidateLedgerV2` (SK-09, extends `candidate-ledger.ts:32`) |
| 4 | Policy only comes from `compilePolicy`. `comparison: gt`. Inclusive solvers get threshold+1. | `toEffectivePolicy` (SK-02) |
| 5 | Accounting identities (§7 SK-04). | `verifyPlanV7` (SK-04, wraps `verifyPlan`) |
| 6 | `networkNativeUpperRaw ≤ gasReservationNativeRaw ≤ remaining`. | `buildRouteCost` (SK-04) |
| 7 | Evidence fidelity/override rules. A fixture never admits. | `verifyAdmissionBundle` (SK-07) |
| 8 | Public MCP output has `execution=false`. Authorization is resolved locally. | `adaptIntent` (SK-02) |
| 9 | Unknown fields or versions are rejected. Bounds are intersected. Every attempt is charged to the shared counters. | `validateIntegration` + `RoundCounters` (SK-00) |

## 6. Reason codes (closed registry, erratum E3)

`REASON_CODES` in `src/evidence/integration.ts`. Any other string fails validation. The registry imports and re-exports the existing literal unions, such as the `RejectReason` values in `pool-universe.ts:11` that are reused here, rather than redeclaring them (review A7).

| Group | Codes |
|---|---|
| Identity | `UNRESOLVED_POOL_KEY`, `POOL_ID_MISMATCH`, `MANAGER_CODE_DRIFT`, `MANAGER_UNMAPPED`, `UNSUPPORTED_HOOK`, `UNSUPPORTED_DYNAMIC_FEE`, `STATE_UNINITIALIZED`, `REORGED_INITIALIZATION`, `WRONG_CHAIN` |
| Capability | `UNSUPPORTED_NATIVE_CURRENCY`, `UNSUPPORTED_TOKEN_BEHAVIOR`, `CODEC_UNAVAILABLE`, `SPLIT_UNSUPPORTED` |
| Policy | `INPUT_BLOCKED_PROFILE`, `INPUT_BLOCKED_AUTHORIZATION`, `POLICY_UNSUPPORTED_FIELD`, `CONSTRAINT_ASSET_MISMATCH` |
| Economics | `INSUFFICIENT_NET_PROFIT`, `PRICE_IMPACT_EXCEEDED`, `LENDER_CAPACITY`, `COST_EVIDENCE_EXPIRED` |
| Budget | `DEFERRED_RPC_BUDGET`, `DEFERRED_EVALUATION_BUDGET`, `DEADLINE_EXCEEDED`, `PLAN_EXPORT_BUDGET` |
| Admission | `ADMISSION_MISSING`, `ADMISSION_BINDING_MISMATCH`, `ADMISSION_EXPIRED`, `PRODUCER_UNTRUSTED` |
| Freshness | `STATE_CHANGED`, `NONCE_DRIFT` |
| Recovery | `PNL_UNKNOWN_HALT`, `UNRESOLVED_BUDGET_RESERVATION` |
| Versioning | `VERSION_UNSUPPORTED` |

## 7. Work packages: exact I/O

Dependency order: **SK-00 → SK-01 → {SK-02 → SK-04} → SK-06 → SK-07 → SK-08 → SK-09 → SK-10**. SK-03 → SK-05 is a parallel Solidity track that SK-06 joins. Each package lands in its own commit with its tests.

### SK-00 (new): contract loader and hashing

- **New file:** `src/evidence/integration.ts`. It is justified because the contract needs its own Ajv instance.
- **`validateIntegration<T>(def: IntegrationDef, value: unknown): T`**
  - Uses Ajv2020 with `{strict:true, strictTypes:false, allErrors:true}` (E2) and `addFormat('date-time', RFC3339Z)` (E1).
  - On failure throws `IntegrationValidationError('SCHEMA_INVALID_ARTIFACT:<def>:<errors≤8>')`.
  - Returns `structuredClone`.
  - Then runs the semantic validator registered for `def`.
- **`domainHash(domain, value): \`sha256:${string}\``** and **`canonicalBytes(value): Buffer`**.
- **`REASON_CODES`**. `RoundCounters { rpc, evaluations, deadlineAt }` has `charge(kind)`, which throws `DEFERRED_*_BUDGET`. It is shared by the resolver, retries and quote workers.
- **Tests:** EDGE-00, 02 and 03 move from the test-local oracle to these exports, against the same vectors.

### SK-01: canonical v4 inventory bridge

- **Input:** inventory.v2/v3 rows. A v4 row has `reference: {kind:'v4_pool', chainId, manager, poolId}`. The legacy `provider_opaque` rows with a 32-byte ID are also accepted, but only when `managerMappingRef` maps the provider to a manager.
- **New file:** `src/evm/v4-resolution.ts`:
  ```ts
  resolveV4Pools(req: PoolResolutionRequest, reader: V4Reader, counters: RoundCounters): Promise<{ report: PoolResolutionReport; configs: AnalyticsPoolConfig[] }>
  readV4Initialize(reader, manager, ids: Hex[], range: {from: bigint; to: bigint}, counters): Promise<Map<Hex, InitializeFact>>   // extracted from discovery.ts:30-64, which then calls it
  validateResolvedPool(p: ResolvedPool): void   // semantic rule 1
  toAnalyticsConfig(p: ResolvedPool, adapterRevision: string): AnalyticsPoolConfig | null   // null when support.read=false
  ```
- **Algorithm:**
  1. Dedupe on `(chainId, manager, poolId)`.
  2. Query Initialize by the indexed `id` topic over bounded pages. Each page is charged to `counters`.
  3. Pin the `blockHash` of each log and recheck it at the snapshot block. A mismatch gives `REORGED_INITIALIZATION`.
  4. Recompute `deriveV4PoolId(key)`. A mismatch gives `POOL_ID_MISMATCH`.
  5. Check that the manager code hash matches its pin. A mismatch gives `MANAGER_CODE_DRIFT`.
  6. Read `extsload` slot0. Zero gives `STATE_UNINITIALIZED`.
  7. Set support flags per adapter. A hook is `read:true, quote:false`, `UNSUPPORTED_HOOK`. A dynamic fee (`fee & 0x800000`) is `UNSUPPORTED_DYNAMIC_FEE`. Native currency is `read/quote:true, prepare/simulate/execute:false`, `UNSUPPORTED_NATIVE_CURRENCY`, until SK-05 is admitted.
- **Output:**
  - `PoolResolutionReport{resolved[], unresolved[{providerPoolId, reasonCode}], complete, rpcCallsUsed}`.
  - Configs. `readEvmAnalyticsSnapshot` accepts ≤6 configs per call, so up to `limits.maxPools` pools are read in batches of 6. Every batch is pinned to the same `blockNumber`, and batches are merged only when their `blockHash` values are identical; otherwise the round fails with `STATE_CHANGED`. Each batch is charged to `counters`. Pools beyond the limit become `DEFERRED_EVALUATION_BUDGET`, never a silent drop. (Review A6: a hard clamp to 6 would leave 17 of the 23 Robinhood pools permanently deferred.)
  - Initialize lookups use one `eth_getLogs` per page with the topic-1 array set to all unresolved IDs, never one scan per pool (review A12).
  - A missing key gives an `UNRESOLVED_POOL_KEY` row. It never aborts unrelated pools.
- **Changes to `pool-universe.ts`:**
  - `PoolAdapter` gains `'UNISWAP_V4'`.
  - `UniversePool.poolId` for v4 becomes `uniswap_v4:${manager}:${poolId}`.
  - The dedupe key becomes `poolId`, not the address (lesson #30).
  - `parseInventory` accepts v3 only when the gate is on.
  - `universeTokenOutcomes` joins on `poolId`.
- **Branch and route IDs:** derive them as `domainHash` prefixes, never by joining pool IDs (lesson #31, 128-char limit).
- **Tests:**
  - `v7 SK-01 resolves 23-pool captured inventory with one disposition each`. The fixture is the captured Robinhood inventory plus recorded logs (S-E01).
  - `… reorged Initialize log invalidates cached key`.
  - `… hooked dynamic-fee pool is read-only`.
  - EDGE-01's baseline stays permanently as the **gate-off** regression for S-E11: legacy universe output is unchanged. A new gate-on case asserts resolution (review A8).

### SK-02: typed intent and single policy compiler

- **New file:** `src/evidence/intent.ts`:
  ```ts
  adaptIntent(intent: Intent, refs: { profile?: ApprovedProfile; asset?: Asset; valuation?: {price: Ratio; ref: EvidenceRef}; authorization?: EvidenceRef }, nowNs: bigint)
    : { kind: 'ready'; request: RunRequest /*5.2*/; constraints: RequestedConstraints | null }
    | { kind: 'research-only'; blockers: ReasonCode[] }   // profileRef null => INPUT_BLOCKED_PROFILE for sizing/execution, discovery continues
  ```
  - It maps `chainId eip155:N` to `networkId "N"` and rejects lossy forms.
  - It never sets a default principal, lender, USDC or gasless value.
  - `mode:'execute'` without `authorizationRef` becomes `research-only` with `INPUT_BLOCKED_AUTHORIZATION`.
- **Change to `economics.ts:20`.** The signature becomes:
  ```ts
  compilePolicy(request, approved, asset, valuation, nowNs, requestedConstraints?: RequestedConstraints)
  ```
  - When `requestedConstraints` is `undefined`, the code path is unchanged and the output is byte-identical (tested).
  - When it is present:
    - Require `repaymentAssetId` to equal the asset. Otherwise fail with `CONSTRAINT_ASSET_MISMATCH`.
    - `principalCapRaw = min(...)`.
    - `maxBranches = min(profile.maxBranches, maxRoutes)`.
    - `minProfitRaw = max(rawThreshold(...), minNetProfitRaw)`.
    - `maxPriceImpactBps = min(...)`.
    - Validate first, then recompute `policyHash` the same way as today.
  - Unknown keys throw `POLICY_UNSUPPORTED_FIELD`.
  - Never pass constraints into the strict RunRequest schemas.
- **`toEffectivePolicy(policy, profileRef, asset, extras): Policy`** produces `effective-execution-policy/1`.
  - `compiledPolicyHash = 'sha256:' + policy.policyHash`.
  - `policyHash = domainHash('flash/effective-policy/1', …)`.
  - Gas and loss limits come from the profile, intersected with `TRADING_GAS_CAP` and `TRADE_SUBMISSION_CAP` (`budget.ts:6-7`) by taking the min. They are never widened.
- **CLI:** `integration-run` in `src/evm/cli.ts`, with flags as in the System Map.
  - research and simulate never load signer env.
  - execute resolves the existing env binding.
  - The legacy `acceptance` is untouched. Its $10 / $100k lane is not reachable from `integration-run`. Any field the runner cannot enforce gives `POLICY_UNSUPPORTED`.
- **Tests:** `absent constraints keep compilePolicy output byte-identical` (S-E11), `constraints only tighten` (S-E04), `null profileRef yields INPUT_BLOCKED for sizing`.

### SK-03: immutable deployment artifact provenance

- **Store:** `.nim/artifacts/executors/<sha256>.json`, which is local evidence. The public copy goes to `docs/deployments/artifacts/<sha256>.json`. `docs/deployments/*` is gitignored, and today's files there are force-added. Add the `.gitignore` exception `!docs/deployments/artifacts/` in the same commit (review A9). The file is written once. If the path exists with different bytes, fail with `ARTIFACT_IMMUTABLE`.
- **Changes to `deployment.ts`:**
  ```ts
  storeArtifact(bytes: Buffer): Promise<{ sha256: string; path: string }>
  buildExecutorManifest(entry: DeploymentEntry, artifactSha256: string, compiler: {version; binaryHash; settingsHash}, sourceRevision: string, capabilities: string[]): ExecutorManifest
  verifyRuntime(live: Hex, artifact: ForgeArtifact, immutables: Record<string, Hex /*32B*/>): void   // generalises :76; owner and wrappedNative named refs
  ```
  - `deployment-status --executor-manifest <file>` loads the stored artifact by hash instead of `out/`.
  - `out/` is a diagnostic only: `REBUILD_MATCHES` or `REBUILD_DIFFERS`.
- **Historical rebuild:** `3aec463`, solc 0.8.26, optimizer 200. It is stored only after it passes the unchanged `verifyRuntime` for all three deployments. The original artifact-file hash stays `UNRESOLVED` until independently found (v7 source SK-03).
- **Schema:** `ExecutorManifest` is the contract `$def`. `evm-deployment-manifest.schema.json` is unchanged; the new manifest is a separate record.
- **Tests:** `historical artifact passes and one-byte mutation rejects`, `current out/ build cannot overwrite stored manifest` (S-E03).

### SK-04: gas evidence, reservation and ledger

- **`src/evm-fees.ts` (reused, extended):**
  ```ts
  nativeToRepaymentUpper(nativeRaw: bigint, nativeUsdUpper: Ratio, repaymentUsdLower: Ratio, nativeDecimals: number, repaymentDecimals: number): bigint
  ```
  - Ceiling division. A zero denominator throws `ZERO_DENOMINATOR`, a non-positive price throws `NONPOSITIVE_PRICE`. Pinned by the `nativeToRepayment` vector: 432683.x rounds up to 432684.
  - `nativeCostInAsset` delegates to it.
  - The hardcoded depeg band moves into profile valuation bounds.
  - Both price bounds come from feeds named in the approved profile and are read at the plan's `State` block. A missing feed for a chain (for example, if 4663 has no repayment-asset feed) gives `INPUT_BLOCKED`. There is never a default or a 1:1 assumption (review A3).
- **`economics.ts`:**
  ```ts
  buildRouteCost(fee: Awaited<ReturnType<typeof estimateEvmFees>>, conversion: {...}, budget: EvmBudget, policy: Policy, state: State, feeRef: EvidenceRef): Cost
  contractMinSurplus(policy: Policy, cost: Cost): bigint   // minNet + networkUpper + otherUpper + 1; lender fee is in debt, not added
  verifyPlanV7(plan: Plan, policy: Policy, cost: Cost): void
  ```
  - Cost fields: `networkNativeUpperRaw = fee.nativeCost`, estimated fresh on the exact calldata.
  - `gasReservationNativeRaw` sits in `[networkNativeUpperRaw, min(policy.maxGasReservationNativeRaw, budget.remaining('trade'))]`. Anything outside that range throws `CHAIN_BUDGET_EXHAUSTED`.
  - Accounting identities (vector `accounting`):
    - `principal = deployed + unused`
    - `terminal = proceeds(excl. opening/prefund) + unused`
    - `surplus = terminal − principal − lenderFee`
    - `net = surplus − networkUpper − otherUpper`
    - The trade qualifies only if `net > minNet`.
- **Status chain:** if Status (49986) is enabled later, add a `feeModel: 'linea'` profile in `src/evm-chains.ts`. `estimateEvmFees` then calls `linea_estimateGas` with `from` and uses the returned base/priority fees. Never hardcode a gasless fee.
- **`acceptance.ts`:** unchanged. Only `integration-run` uses `buildRouteCost`.
- **Tests:** EDGE-02 vectors; `reservation never becomes modeled cost`.

### SK-05: native-v4 executor (Solidity track)

- **New file `contracts/core/FlashCallbackCore.sol`:** an abstract contract holding:
  - the phase machine (`Idle`, `AwaitingFlash`, `UnlockingV4`, `Unwrapping`, `Wrapping`)
  - lender authentication: kind 1 Morpho, 2 Balancer; codehash pin; request hash; expected input
  - immutable `owner`, `wrappedNative`, `wrappedNativeCodeHash`

  Hooks are `internal virtual`. **Legacy contracts are not edited.** Editing them would drift their pinned artifacts again; migrating them onto the core is a later, separately reviewed revision.
- **New file `contracts/NativeV4FlashExecutor.sol`:**
  - ABI exactly as in the v7 source ("Proposed native executor ABI"): `executeNativeArbitrage(NativeRoute)`, owner-only, nonpayable.
  - `NativeRoute{lenderKind, lender, flashAsset, principalRaw, branches[], minSurplusRaw, deadline}`, and the `NativeAction` kinds `0 = SWAP`, `1 = UNWRAP`, `2 = WRAP`.
- **Settlement:**
  - ERC20 debt: `sync(c) → transfer → settle()`.
  - Native debt: `sync(address(0)) → settle{value: owed}()`, where `owed` is ≤ the authenticated delta and the allocated input.
  - Positive deltas: `take(c, this, amt)`.
  - Use the BalanceDelta sign convention from Uniswap core (lesson #9: the upper 128 bits are amount0).
- **`receive()`:**
  - Accepts only from the manager (during `UnlockingV4`) or from WETH (during `Unwrapping`).
  - Everything else reverts.
  - A forced send through selfdestruct cannot be refused. It is excluded from profit because native credits are tracked only as `logicalNative += takeAmount | withdrawAmount`, never as `address(this).balance`.
  - `logicalNative` is a signed per-branch ledger: `+take(native)`, `+WETH.withdraw`, `−settle{value}` and `−WETH.deposit`. Each entry is scoped to the action that produced it.
  - At the end, `address(this).balance − nativeOpening − logicalNative` is unexplained surplus. It stays in custody, and the event reports it separately (review A2).
  - Phases are distinct: `UnlockingV4` accepts ETH only from the manager, and `Unwrapping` accepts it only from the WETH address.
- **Event:** `NativeArbitrageExecuted(bytes32 routeHash, address asset, uint256 principal, uint256 surplus, uint256 branches, uint256 unexplainedNative)`.
- **New file `test/NativeV4FlashExecutor.t.sol`:**
  - Extend `TestStrictV4Manager` (`AeroSplitExecutorV2.t.sol:11`) into a native-aware strict manager that honours `msg.value` and the synced currency.
  - Add a `TestWETH` mock.
  - Tests: `test_nativeCycleUnwrapSwapWrapRepays`, `test_priorErc20SyncResetBeforeNativeSettle`, `test_forcedEthDuringCallbackNotCountedAsProfit`, `test_receiveReentrancyReverts`, `test_branchAllocationsMustSumToPrincipal`, `test_unauthenticatedCallbackReverts`.
  - **Callback-auth parity (review A1):** this core is a third copy of callback authentication, alongside `MultiVenue._checkLoanCallback` and `Portable._authenticateSplit`. An abstract Foundry suite, `CallbackAuthParity`, runs the same seven negative cases (wrong sender, wrong phase, replay, wrong hash, wrong lender kind, codehash drift, completed callback) against all three families. Merging the legacy contracts onto the core is recorded debt and is triggered by the next legacy redeploy.
  - A fork test is opt-in through `EVM_FORK_REQUIRED` (the `EvmRealLender.t.sol:26` pattern). It needs real liquidity, so a zero-liquidity swap that reverts never counts as a pass (lesson #13).
- **`abi-check.ts`:** add the `NATIVE_V4_ROUTE_ABI` parity check. Add the contract to `CONTRACTS` in `deployment.ts:14`. Configure roots for both the base and the inherited roles (lesson #48).
- **Deployment and admission** require separate owner authorization. They are not part of this feature's Done.

### SK-06: single and split codec selection

- **In `arbitrum-execution.ts`:**
  ```ts
  selectRouteCodec(manifest: ExecutorManifest, mode: 'single' | 'split', native: boolean): RouteCodec   // throws SPLIT_UNSUPPORTED / CODEC_UNAVAILABLE -> POLICY_UNSUPPORTED
  ```
  - Capability to codec: `erc20-multivenue/1` → `MULTI_VENUE_ROUTE_CODEC`; `erc20-portable-split/1` → new `PORTABLE_SPLIT_ROUTE_CODEC`, which decodes `executeSplitArbitrage` using the ABI in `src/contracts/flash-executor.ts:235`; `evm-native-v4/1` → new `NATIVE_V4_ROUTE_CODEC`.
  - The receipt event decoder is selected together with the codec.
  - The portable executor requests `leg.minAmountOut` itself from a V2 pair (gstack pitfall `portable-v2-requested-output`). So `PORTABLE_SPLIT_ROUTE_CODEC` encodes the exact quoted output for V2 legs, and the solver prices that requested output. A slippage guard never stands in for it (review A5).
- **Split search:** reuse `searchAllocation` (`liquidity/price-gap.ts`) and `solvePoolGraph`.
  - Shared pools replay in deterministic order from one evolving state.
  - Branch allocations sum to the deployed principal.
  - A split is kept only if it is strictly better than the single route at the same state.
- **Tests:** `split request on single-only deployment returns POLICY_UNSUPPORTED`, `shared-pool ordered replay equals exact execution` (S-E05).

### SK-07: admission, authority and recovery

- **`loadAdmissionEvidence(path, chainId, executor, capability: string)`:** `capability` replaces the hardcoded selector at `acceptance.ts:66`. Existing callers pass the MultiVenue capability, so their behavior is identical.
- **`verifyAdmissionBundle(bundle: AdmissionBundle, manifest: ExecutorManifest, plan: Plan, policy: Policy, state: State, trustedProducers: EvidenceRef[], now)`.** It requires:
  - `executorManifestHash === domainHash('flash/executor-manifest/1', manifest)`
  - the same equality for `payloadHash`, `policyHash` and `stateDigest`
  - a producer in `trustedProducers`, which comes from config and is never supplied by the bundle. That config file's sha256 is pinned in `flashloan-versions.json`. Changing it is an owner-reviewed commit, approved through the nim-propose gate, never an agent-local edit. The runtime refuses any producer list whose hash differs from the pin (review A11). This is the trust boundary: an agent that edits both files is caught by review, not by code. The limitation is stated here so nobody assumes code enforces it.
  - `expiresAt > now`
  - each referenced proof's bytes re-hashed from disk
  - `fixture === false`

  Any failure throws `ADMISSION_*`, and `sign` is never reached.
- **Session authorization and approvals:** session authorization (`authorizationRef`) is distinct from approval of a new deployment or a risk expansion. The latter are never inferred.
- **Recovery:** reuse the `AttemptJournal` states, `recover-lock` and `EvmBudget.unresolved()`. Nothing clears a live lock or unknown P&L by default.
- **Tests:** `edited/replayed/wrong-chain proof never signs` (S-E07).

### SK-08: readiness, freshness and transport

- **`toReadiness(r: ReturnType<typeof assessReadiness>, intent: Intent, budget: EvmBudget, admission: EvidenceRef | null): Readiness`.**
  - Unknown values are `null`, never `0`.
  - `pnlState = 'UNKNOWN'` when `budget.unresolved().length > 0`. That blocks execute only; research continues.
- **Freshness:** `maxBlockLag` comes from the policy. The current exact-head rule holds until a profile changes it. Retries never widen it.
- **Re-check immediately before signing:** head, nonce, code, owner and roots. Any drift gives `STATE_CHANGED` or `NONCE_DRIFT`, and the candidate is invalidated with `EvmBudget.cancelUnsent`. Never resend.
- **Cancellation (gstack pitfall `abort-after-final-rpc-before-send`, review A4):** recheck the `AbortSignal` and the deadline after the **last** awaited verification RPC and immediately before `sign`, and again before `submit`. Test: `cancel during final verification RPC sends zero`. It uses the fixture's `abortRelay`, which aborts on the second chain read, and asserts `controls.sends === 0` with the reservation cancelled.
- **Transport:** HTTPS only. HTTP is allowed only for a localhost fixture.
- **Tests:** EDGE-04; `new block after simulation invalidates candidate`, which uses `evm-rpc-fixture.ts` controls `nonce`/`drift`/`abortRelay` (S-E08, S-E09).

### SK-09: receipt truth and bounded reporting

- **`buildRoundResult(...)`** produces `flash-round-result/1`.
- **`toLegacyOutcome(status)`** uses the table in `.spec.json → resultStatusMap`, checked by EDGE-05.
  - `MODEL_OPPORTUNITY`, `SUBMITTED_UNKNOWN` and `HALTED` map to `null`. They produce no legacy daily row, and `projectRoundRow` (`execution-outcome.ts:21`) skips them while the gate is on.
- **Receipt adapter:** an `ExecutionEvidence/2` adapter over `reconcileReceipt` (`economics.ts:100`).
  - Actual cost comes from `receiptNativeCost`; on op-stack this includes the L1 fee exactly once.
  - Drift is recorded per asset.
  - A revert's gas is charged.
  - An unknown receipt gives `SUBMITTED_UNKNOWN`, `pnlState: HALTED` and no `realizedNetRaw`.
- **`validateCandidateLedgerV2`:** semantic rule 3. Quote errors and tick exhaustion are never `NO_OPPORTUNITY_WITHIN_DOMAIN`.
- **Tests:** EDGE-05; `unknown receipt halts without realized net` (S-E09, S-E10).

### SK-10: installation, versions, rollout, observability

- **`config/flashloan-versions.json`:**
  - `prompt` gains a `v7` entry pinning `skills/flashloan-agent/prompt-v7.md`, copied byte-exact from the v7 source's §Prompt v7.
  - `schemas` gains `"flashloan-integration": {"version":"1","sha256":"1de7…aaaf"}`.
  - New `codecs` and `features.integrationV7`.
- **`checkCapabilities`:** a schema sha mismatch returns `VERSION_UNSUPPORTED`.
- **Installer:** `src/agent-cli.ts install` also copies `schemas/flashloan-integration-v1.schema.json`, the examples and `config/flashloan-versions.json`. Add `config/` to package `files`. It never copies env, `.nim/` or signing state.
- **Stage logs:** structured JSON lines, one per stage, with `{chain, roundId, stage, stateDigest, candidateHash, policyHash, payloadHash, elapsedMs, counters, reasonCode}`. They never contain calldata or signed bytes.
- **Tests:** `gate off output byte-identical to baseline` (S-E11), `installed schema sha mismatch returns VERSION_UNSUPPORTED`.

## 8. E2E verification plan

| Lane | Meaning | This feature |
|---|---|---|
| A | Local deterministic, no credentials: `npm run build && node --test dist/test/flashloan-v7-integration.test.js`, `forge test --match-contract NativeV4`, `npm run evm:abi-check` | Required for Done |
| B | Pinned fork, no broadcast: `EVM_FORK_REQUIRED=1 forge test --fork-url $ROBINHOOD_RPC_URL --fork-block-number <pinned>` | Required for Done (read-only) |
| C | Fresh mainnet unsigned exact simulation | PENDING; owner opt-in |
| D | Authorized deployment plus a budgeted transaction, only if a real route qualifies | PENDING; separate authorization |
| E | Canonical receipt/finality reconciliation | PENDING; follows D |

Passing A or B is never reported as C, D or E. With no real profit, the round ends `INCONCLUSIVE` or as a bounded negative. Lane D is never forced.

The baseline suite must remain green after every SK: `npm run typecheck`, `npm test`, `node --test dist/test/flashloan-v6-edge.test.js`, `npm run evm:abi-check`, `forge test`.

In a fresh checkout, run `forge build` before the Node tests (lesson #45).

## 9. Errata found by executing the contract

These are recorded, not silently fixed. The pinned bytes stay unchanged because HyperMove vendors the same SHA. Any byte change is a coordinated `v1.1`.

| ID | Finding (reproduced 2026-10-29) | Resolution |
|---|---|---|
| E1 | `format: date-time` throws "unknown format" under strict Ajv. The repo has no `ajv-formats`. | The loader registers an RFC3339-Z regex. No new dependency. |
| E2 | 6 `strictTypes` violations: Asset `if/then/else.assetId`, and CandidateResultV2 `snapshot`/`researchPlan`/`researchPlans` `allOf`. | Own Ajv instance with `strictTypes:false`, all other strict checks on. Fix in v1.1. |
| E3 | `reasonCode(s)` are free strings. | Closed `REASON_CODES` (§6) enforced semantically. Propose an enum in v1.1. |
| E4 | The Uint regex admits 2^256 (78 digits). | `uint()` bound check (vector `uint[1]`). |
| E5 | The legacy `digest()` accepts unsafe integers, floats and lone surrogates. | `domainHash` guards. `digest` stays unchanged for legacy hashes. |

### Implementation notes (2026-10-29)

- **E6:** the v7 version keys live in `config/flashloan-integration-versions.json`, not in the closed, vendor-pinned v6 manifest. `checkIntegrationVersions` returns `VERSION_UNSUPPORTED` on any drift, or while `features.integrationV7` is false (the default).
- **`integration-run`** runs the identity, policy and ledger half of the System Map, and never signs. Execution stays in the admitted acceptance lane. Wiring amount-aware search and exact native simulation over resolved v4 configs into that lane is the stated next dependency in every result.
- **Fixes found by the tests:** I1–I3 in the ledger (`implementationFindings`).
- **Admission producers:** `config/admission-producers.json` ships empty. No producer is trusted until the owner adds one and re-pins its hash, so no admission bundle can pass today.

## 10. Recalled lessons applied as checkable predicates

| Lesson | Predicate in this spec |
|---|---|
| #9 | v4 delta sign: SK-05 strict manager test asserts the upper-128 bits are amount0. |
| #13 | Fork false-pass: SK-05 fork test requires nonzero liquidity and real settlement. |
| #19 | Identifier/policy split: SK-01 uses `deriveV4PoolId`, not `poolIdFromKey`. |
| #30 | All v4 pools share the manager address: SK-01 dedupes on poolId. |
| #31 | branchId length: SK-01 and SK-06 IDs are `domainHash` prefixes. |
| #37 / #34 | Fixture discriminants and enums: copy them from the schema, never guess; EDGE-00 validates every example. |
| #45 | Fresh checkout: run `forge build` before Node tests. |
| #48 | Inherited roots: the SK-05 deployer configures roots by capability, not by contract name. |

## 11. Definition of Done for the implementation

- Every SK item's tests are real; the `test.todo` count is 0.
- EDGE-01..05 markers report `scope: "runtime"`.
- Lanes A and B pass with recorded commands and outputs.
- The S-E11 differential check passes.
- The nim-deliver map moves to `Implementing`, then `Done`.

Lanes C, D and E stay PENDING unless the owner separately authorizes them. This document does not admit any deployment, risk change or trade.

## 12. Gstack review findings and resolutions

See Appendix A.

## Appendix A: `/plan-eng-review` (2026-10-29, native Claude, Codex outside voice skipped per owner preference)

**Target:** this spec plus its map, ledger, contract schema and harness. **Mode:** FULL_REVIEW, scope accepted as-is.

The scope was already approved in the owner's plan: a spec and harness only, with the MCP side handled as a contract. The structure gate (8+ proposed files) was therefore not re-asked. Remedies A1-A12 were applied under the plan's approved step "resolve findings in the spec". No per-remedy question was put to the owner. That is a deviation from the skill's interactive ledger, recorded here so the owner can reopen any of them.

**Reality rows:**
- **premise-table** pass. Every defect row in §2 carries a file:line receipt; unverified=0. "23 pools" and "3aec463 artifacts pass" are claims from the v7 source and stay attributed to it.
- **already-done** pass. `git log --all -S` finds no `integration-run` or `v4_pool`. Base `306ca6e`.
- **surface-check** finding. Existing commands and flags are verified against `src/evm/cli.ts:16`. `--executor-manifest` and `integration-run` are labeled proposed. The `docs/deployments/*` ignore rule was fixed as A9.
- **binding-decisions** pass. The 2026-10-29 v6 decision on ownership (HyperMove owns public facts; rollover-skill owns validation, policy and receipts) is honored.
- **numbers** pass. 54,516 bytes, sha `1de7…aaaf`, 6 strictTypes violations and vector 432684 are all [measured: scratch Ajv/node runs, EDGE-02]. Effort has no number claimed.
- **deferred-asks** pass. Lanes C/D/E, HyperMove M-E rows and deployment are deferred, each with its reason in §8 and the ledger.
- **pr-count** pass. One commit per SK and one PR per track (TS, Solidity); no ship policy file exists.

**Findings:**

| ID | Sev | Conf | Section | Finding | Resolution |
|---|---|---|---|---|---|
| A1 | P1 | 8 | Arch | The new core is a third copy of callback authentication. Drift between copies is a security risk. | `CallbackAuthParity` suite across 3 families; debt D-01 in the ledger |
| A2 | P1 | 8 | Arch/Sec | The native ledger only added credits, so a debit-less path could overstate attributable ETH. | Signed per-action `logicalNative`; separate Unwrapping and UnlockingV4 phases |
| A3 | P1 | 9 | Arch | Native-to-repayment conversion needs two feeds that may not exist on 4663. | Feeds come from the profile at the plan block; missing gives INPUT_BLOCKED |
| A4 | P1 | 10 | Tests | Pitfall `abort-after-final-rpc-before-send` was not covered. | Recheck before sign and submit; zero-send test |
| A5 | P2 | 9 | Code | The portable V2 leg requests `minAmountOut` itself. | Codec encodes the exact quoted output |
| A6 | P1 | 9 | Perf/Arch | A clamp of 6 snapshot configs leaves 17/23 pools always deferred. | Batches of 6 pinned to one block, merged only on equal blockHash |
| A7 | P3 | 7 | Code | The reason-code registry would duplicate existing literal unions. | Import and re-export the existing unions |
| A8 | P2 | 8 | Tests | The EDGE-01 baseline would be deleted when SK-01 lands, losing the gate-off proof. | Keep it as an S-E11 gate-off regression; add a gate-on case |
| A9 | P2 | 10 | Dist | `docs/deployments/*` is ignored, so public artifacts would silently not commit. | `.gitignore` exception in the SK-03 commit |
| A10 | P3 | 7 | Code | Unwrap and wrap both used the `Wrapping` phase. | Split into Unwrapping and Wrapping |
| A11 | P1 | 8 | Sec | `trustedProducers` in agent-writable config could self-admit. | Sha pin in the versions manifest plus an owner-reviewed change; limitation stated |
| A12 | P2 | 8 | Perf | Per-pool Initialize scans multiply RPC calls. | One topic-array `eth_getLogs` per page |

**Failure modes per new path.**

| Path | Realistic failure | Handled by |
|---|---|---|
| Resolver | Reorg drops Initialize | `REORGED_INITIALIZATION` |
| Policy | Caller constraint for another asset | `CONSTRAINT_ASSET_MISMATCH` |
| Cost | Feed stale or missing | `INPUT_BLOCKED` / `COST_EVIDENCE_EXPIRED` |
| Native executor | ETH forced into the contract | Unexplained surplus, never profit |
| Admission | Edited proof | Re-hash from bytes, `ADMISSION_BINDING_MISMATCH` |
| Send | Abort during the last RPC | Zero sends |
| Receipt | Lost receipt | `SUBMITTED_UNKNOWN` + `HALTED` |

**Error-path coverage.** Every path has a test in the ledger.

**NOT in scope:** runtime code; lanes C, D and E; HyperMove CandidateRequestV2/ResultV2; deployment; Status chain profile; contract v1.1 byte fixes.

**What already exists:** see §3, the reuse map.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | - |
| Outside Review | codex (skipped, owner preference) | Independent 2nd opinion | 0 | disabled | - |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 12 issues, 0 critical gaps (all 12 resolved in spec) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | n/a (no UI) | - |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | - |

- **OUTSIDE COVERAGE:** Codex outside voice disabled per owner preference; no external review completed.
- **VERDICT:** ENG CLEARED for implementation of SK-00..SK-10 per this spec. The runtime remains Draft/PENDING.

NO UNRESOLVED DECISIONS
