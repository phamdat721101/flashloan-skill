# Gstack Architecture Review & Security Audit

## 1. Executive Review Verdict: APPROVED WITH GATES

**Review Level**: Principal Distributed Systems Architect & DeFi Security Reviewer
**Focus Areas**: Move VM Bytecode Verification, Hot Potato Invariants, Sui Mysticeti Consensus Contention, Gas Object Equivocation, and Sub-Round Latency Bounds.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        GSTACK REVIEW SCORECARD                         │
├─────────────────────────┬──────────────┬───────────────────────────────┤
│ ARCHITECTURAL PILLAR    │ STATUS       │ CRITICAL MITIGATION           │
├─────────────────────────┼──────────────┼───────────────────────────────┤
│ Hot Potato Invariant    │ LETHAL PROOF │ Bytecode Verifier eliminates  │
│                         │              │ repayment evasion.            │
├─────────────────────────┼──────────────┼───────────────────────────────┤
│ Shared Object Locks     │ CAUTION GATED│ Pre-sort object arguments to  │
│                         │              │ avoid Mysticeti deadlock.     │
├─────────────────────────┼──────────────┼───────────────────────────────┤
│ Gas Coin Isolation      │ HARDENED     │ Dedicated single-writer coin  │
│                         │              │ prevents equivocation halts.  │
├─────────────────────────┼──────────────┼───────────────────────────────┤
│ S(t+1) Math Accuracy    │ VALIDATED    │ Closed-form Q* eliminates     │
│                         │              │ out-of-gas loop aborts.       │
├─────────────────────────┼──────────────┼───────────────────────────────┤
│ Fail-Fast Revert Cost   │ EXCEPTIONAL  │ Sub-$0.002 abort cost via     │
│                         │              │ native Move assert.           │
└─────────────────────────┴──────────────┴───────────────────────────────┘
```

---

## 2. In-Depth Failure Mode & Edge Case Analysis

### 2.1 Threat 1: Shared Object Contention & Locking Delay in Mysticeti
* **Failure Shape**: When multiple searchers submit PTBs referencing the same `CetusPool` or `DeepBookPool` shared objects within the same consensus round, Mysticeti orders transactions sequentially. If a preceding transaction alters the pool reserves significantly, the second transaction suffers spread compression and aborts.
* **Architecture Fix**:
  1. The on-chain `arbitrage_guard` verifies `min_profit` at the very end of the PTB. If the spread compressed, the transaction aborts, costing only $< 0.001$ SUI in gas.
  2. The off-chain engine maintains parallel sub-round gas price bidding: dynamically scaling computation unit price ($1.05\times - 1.20\times$) during high-volatility spikes to guarantee earlier inclusion in the DAG commit round.

### 2.2 Threat 2: Gas Coin Equivocation & Lockout
* **Failure Shape**: In Sui, an owned object (like a Gas Coin) can only be signed once per version. If two concurrent threads attempt to spend or pay gas from the same Gas Coin object ID simultaneously, validators detect double-spending (equivocation) and lock the gas coin until the next epoch (up to 24 hours).
* **Architecture Fix**:
  - The runtime implements a **Dedicated Gas Coin Sharding Pool**:
    - Pre-allocates 16 independent 50-SUI gas coin objects.
    - Worker threads lease an exclusive gas coin ID with an atomic compare-and-swap (CAS) lock.
    - No two concurrent speculative dispatches ever touch the same Gas Coin object.

### 2.3 Threat 3: 1-Mist Rounding Mismatch in SplitCoins
* **Failure Shape**: In high-throughput AMMs, integer division truncation can leave an intermediate balance 1 Mist short of the required flash repayment, causing an unintended abort.
* **Architecture Fix**:
  - `dex_adapters::split_repayment_and_profit` explicitly computes repayment as `borrow_amount + fee` and assigns the remaining coin directly to profit, ensuring the lender always receives the exact required balance without rounding leakage.

### 2.4 Threat 4: PTB Command & Size Limits
* **Failure Shape**: Sui enforces hard protocol limits: maximum 1,024 commands per PTB and maximum 128 KB serialized transaction size.
* **Architecture Fix**:
  - The arbitrage route is bounded to $\le 4$ hops (typically 2-hop Cetus $\leftrightarrow$ DeepBook). Total commands per PTB $= 6$, consuming $< 800$ bytes of BCS serialization—well below all protocol ceilings.

---

## 3. Tradeoff Analysis & Opinionated Recommendations

### 3.1 Recommendation 1: Custom Hot Potato Lender vs. External Lending Pools
* **Tradeoff**: External pools (Scallop/NAVI) have larger liquidity ($>\$50\text{M}$), but charge $0.05\%$ fee. A custom vault (`hot_potato_lender`) is 0% fee, but requires dedicated operator capital.
* **Opinionated Stance**:
  - **Phase 1 (Production Bootstrap)**: Integrate Scallop and NAVI for broad multi-token coverage (SUI, USDC, USDT, CETUS).
  - **Phase 2 (Capital Optimization)**: Deploy the dedicated 0%-fee `hot_potato_lender` funded with $\$100\text{k}-\$250\text{k}$ SUI/USDC for zero-cost high-frequency cycling.

### 3.2 Recommendation 2: Fast-Path Dry Run vs. Pure Speculative Egress
* **Tradeoff**: Running `sui_dryRunTransactionBlock` guarantees profit before submission but incurs a $15-25\text{ ms}$ round-trip delay. Speculative dispatch has sub-millisecond wire latency but risks aborting on-chain.
* **Opinionated Stance**:
  - **Adopt Hybrid Gating**:
    - Opportunities with quoted profit $\ge \$25$: Fire **optimistically** with zero simulation, relying on `arbitrage_guard` fail-fast protection.
    - Opportunities with quoted profit between $\$10$ and $\$25$: Run quick local state simulation before dispatch.
    - Reject all opportunities below the $\$10$ floor.
