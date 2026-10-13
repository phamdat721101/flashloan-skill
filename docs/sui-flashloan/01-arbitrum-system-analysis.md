# Arbitrum System Analysis & Operational Learnings

## 1. Deep Analysis of the Existing Arbitrum Flashloan Engine

The existing system implemented in `/Users/phamdat/openx/rollover-skill` represents an institutional-grade, high-performance speculative flashloan engine on Arbitrum One (`FAAS-OPT-NITRO-V3` / `SPEC-2026-1004`).

### 1.1 Architectural Topology & Pipeline Flow

The engine overcomes the standard MEV simulation bottleneck ($15 - 35\ \mu\text{s}$ in `revm`) through an **Optimistic Speculative Dispatch** paradigm:

```
[ Dual-Head Ingress ] ──► Sequencer Feed + Canonical Block Stream
       │
       ▼ (< 400 ns)
[ Forward State S(t+1) ] ──► Register Projection (xy=k or CLMM Tick Walk)
       │
       ▼ (< 1.5 µs)
[ Closed-Form Solver ] ──► Analytical Optimal Sizing Q*
       │
       ▼ (< 300 ns)
[ Zero-Copy Patching ] ──► Pre-Signed EIP-1559 Raw Transaction Buffer
       │
       ▼ (< 1.2 µs)
[ io_uring Dispatch ] ──► Direct Socket Egress to Sequencer
       │
       ▼
[ On-Chain Guard ] ──► MultiVenueArbitrageExecutor Reverts Early (<2,000 gas) if Unprofitable
```

#### Pipeline Critical Path Metrics:
- **Sequential Legacy Model**: Ingress $\to$ Decode $\to$ Math $\to$ `revm` Sim ($25\ \mu\text{s}$) $\to$ Sign $\to$ Dispatch $\approx \mathbf{45\ \mu\text{s}}$.
- **Optimistic Speculative Model**: Register Projection ($<400\text{ ns}$) $\to$ Closed-form $Q^*$ ($<1.5\ \mu\text{s}$) $\to$ Zero-copy Patch ($<300\text{ ns}$) $\to$ `io_uring` Dispatch ($<1.2\ \mu\text{s}$) $\approx \mathbf{< 4.5\ \mu\text{s}}$ total latency.

### 1.2 On-Chain Executor Contracts

The Arbitrum repository maintains three generations of flashloan executors:
1. `ImmutableArbitrageExecutor.sol`:
   - Enforces owner-managed protocol-root registries.
   - Pinned code hashes for Aave Addresses Provider and Uniswap v4 `PoolManager`.
   - Strict callback-only phase state machine: `Phase::Idle`, `Phase::AwaitingFlash`, `Phase::Unlocking`.
2. `MultiVenueArbitrageExecutor.sol` (Deployed at `0xd130b45b7e7d08fb7dbb1c79fa5d9b95ea8e27b2`):
   - Multi-venue route execution across Uniswap V2, V3, and V4.
   - Pins runtime code hashes for V2 factories, V3 factories, and V4 managers.
   - Disallows arbitrary V4 hooks (`HooksDisabled()`).
   - Callback protection: verifies `msg.sender == AavePool` and `initiator == address(this)`.
3. `ArbitrumMultiSplitFlashExecutor.sol` (Deployed at `0xb1aac2079c52fd31e038ec348505a0f55859d60f`):
   - Supports $\ge \$100\text{k}$ Morpho Blue 0%-fee flash loans across non-USDC assets (WETH, ARB, USDT).
   - Multi-pool convex split routing and triangular multi-hop (PancakeSwap v3, Camelot v3, Uniswap v3).
   - Dynamic intermediate balance unwinding avoiding 1-wei rounding mismatches.
   - Atomic profit verification and sweep to treasury.

---

## 2. Exhaustive Audit of Operational Logs, Memory, and Lessons

Analyzing all historical artifacts in `.nim/` reveals critical operational hazards that informed our architectural constraints.

### 2.1 Learnings from `.nim/agent-support-log.md`

| Timestamp | Primitive | Failure / Shape Caught | Resolution / Defensive Rule |
| :--- | :--- | :--- | :--- |
| `2026-10-04T02:31Z` | `nim-error-handler` | Missing local memory; false prior-context claims. | Denied AS-SCP index creation before code migration; enforced ground-truth validation. |
| `2026-10-04T02:44Z` | `nim-error-handler` | Workspace configures lessons recall without `.nim/lessons.jsonl`. | Required dual-file BM25 recall to prevent silent omission of prior operational lessons. |
| `2026-10-06T13:17Z` | `nim-error-handler` | TypeScript executor capability union not widened with producer definitions. | Enforced typecheck before behavioral tests when expanding shared contracts. |
| `2026-10-06T13:18Z` | `nim-error-handler` | Solidity 0.8.25 vs 0.8.26 toolchain mismatch. | Classified as compiler toolchain mismatch, avoiding false source-code diagnostic. |
| `2026-10-06T13:50Z` | `nim-error-handler` | Absence of executor wallet, RPC, or pool addresses in environment. | Prevented live contract deployment with guessed or invented constructor addresses. |
| `2026-10-06T16:40Z` | `nim-error-handler` | Alloy implicit contract-creation transaction rejected. | Required explicit `Create` kind in Alloy transaction builder. |
| `2026-10-07T15:39Z` | `nim-error-handler` | Rust compiler (`cargo check`) caught moved deployment draft reused in gas re-estimation. | Computed final gas before consuming the request object to preserve borrow validity. |
| `2026-10-07T16:40Z` | `nim-error-handler` | Live V2 factory reverted on optional `INIT_CODE_PAIR_HASH` getter. | Disallowed non-standard optional getters as required fingerprints; pinned runtime code hash instead. |
| `2026-10-07T17:29Z` | `nim-enforcer` | Orchestrator fixture relied on sub-net profit, weakening runtime guard. | Raised test fixture above mandatory profit floor so test expectations cannot relax runtime guards. |
| `2026-10-10T04:53Z` | `nim-error-handler` | Foundry compilation rejected non-checksummed address literal. | Enforced compiler-checksummed addresses for Solidity constants. |
| `2026-10-10T05:00Z` | `nim-enforcer` | AS-SCP rejected raw JSON Schema as SpecEnvelope. | Only compiled valid `SpecEnvelope` envelopes to ensure symbol validation integrity. |
| `2026-10-11T14:32Z` | `nim-error-handler` | Shell-expansion and AS-SCP hydrate exposed unsupported Morpho selector. | Verified exact ABI function selectors against deployed bytecode before relay broadcast. |

### 2.2 Reusable Lessons from `.nim/lessons.jsonl`

1. **Lesson ID `f97459b8` (Shared Contract Expansion)**:
   * *Problem*: Adding required fields to shared types left test fixtures structurally stale.
   * *Rule*: When expanding a shared data contract, search and update production and test object literals simultaneously, then run typecheck before behavioral tests.
2. **Lesson ID `98f5138b` (Execution Gate Change)**:
   * *Problem*: Changing an execution authorization contract left legacy broadcast fixtures without the new required relay input.
   * *Rule*: Update configuration defaults, runtime gate tests, and execution fixtures together whenever broadcast authorization inputs change.
3. **Lesson ID `eef39705` (Read-Only RPC Scan Under Sandbox)**:
   * *Problem*: Sandboxed read-only scanner produced transport errors mistaken for an absent market signal.
   * *Rule*: When an RPC scan fails under sandbox networking, retry the non-sending command with approved network access before classifying the result as "no edge".
4. **Lesson ID `7d2b8799` (Repeated Action Threshold)**:
   * *Problem*: Repeated an equivalent failed action three times in one task.
   * *Rule*: Inspect auditor status and submit a materially different plan before retrying.

### 2.3 Verification Records in `.nim/memory.jsonl`

`.nim/memory.jsonl` logs over 90 deterministic execution verification entries with MD5 keys and TTL timestamps, ensuring that repeated pipeline solves, route estimations, and simulator runs do not duplicate work and that known failed routes are cached and rejected immediately.

---

## 3. Structural Translation to Sui

Translating this system to Sui requires carrying over all rigorous safety invariants while replacing EVM-specific vulnerabilities:

1. **Eliminating Callback Hijack Vectors**:
   - EVM required complex phase states (`Phase::AwaitingFlash`) to ensure callbacks originated from verified pools.
   - On Sui, the **Hot Potato** is unforgeable and has no callbacks. The pool that issues the `FlashLoanReceipt` is the only module whose `repay` function can unpack it.
2. **Eliminating ABI Selector & Checksum Incompatibilities**:
   - Move modules use strongly typed function signatures verified at package publication time (`sui client publish`). There are no 4-byte selector collisions or address checksum issues.
3. **Preserving Closed-Form Mathematical Sizing & Zero-Copy Execution**:
   - The analytical sizing math ($Q^*$) and forward-state projections are portable directly to Rust for Sui CLMMs (Cetus) and CLOBs (DeepBook v3).
   - Zero-copy byte patching applies directly to Sui's binary canonical serialization (BCS) format.
4. **Preserving Fail-Fast Invariant Verification**:
   - The on-chain `arbitrage_guard` Move module acts identically to the Stylus/Solidity invariant check, aborting the PTB if net profit $< \text{min\_profit}$.
