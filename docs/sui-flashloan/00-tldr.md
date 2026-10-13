# Sui Hot Potato Flashloan Service — TL;DR & Executive Summary

## 1. Executive Summary

This specification defines the complete architecture, smart contract implementation (Sui Move), and off-chain speculative execution engine for an autonomous **Flashloan Arbitrage Service on the Sui Network**.

It directly evolves the proven Arbitrum Nitro speculative pipeline (`FAAS-OPT-NITRO-V3` / `SPEC-2026-1004`) to take advantage of Sui’s unique object-centric architecture and native **Programmable Transaction Blocks (PTB)** via the **Hot Potato Pattern**.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      SUI HOT POTATO FLASHLOAN ARBITRAGE TOPOLOGY                       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  [ Ingress Stream ] ──► Fullnode WebSocket / Mysticeti DAG Ingress (<10 ms)            │
│         │                                                                              │
│         ▼                                                                              │
│  [ Forward-State Solver ] ──► Register S(t+1) Math + Analytical Sizing Q* (<1.5 µs)   │
│         │                                                                              │
│         ▼                                                                              │
│  [ Zero-Copy PTB Builder ] ──► Pre-Formatted BCS Transaction Envelope (<400 ns)       │
│         │                                                                              │
│         ▼                                                                              │
│  [ Fast Dispatch ] ──► Direct Validator Submission (<2.5 ms)                           │
│         │                                                                              │
│         ▼                                                                              │
│  [ On-Chain Execution (PTB) ]                                                          │
│         ├─ 1. Borrow Flash Loan: Lender::borrow() ──► (Coin<T>, HotPotatoReceipt)     │
│         ├─ 2. Leg 1 Swap: Cetus CLMM Swap ──► Coin<Intermediate>                       │
│         ├─ 3. Leg 2 Swap: DeepBook v3 Swap ──► Coin<T>                                 │
│         ├─ 4. Repay Flash Loan: Lender::repay(Coin<T>, HotPotatoReceipt) ──► Consumed! │
│         └─ 5. Guard & Profit Sweep: ArbitrageGuard::verify_and_sweep(Surplus, MinProf) │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Paradigm Comparison: EVM (Arbitrum) vs. Sui Move

| Dimension | Arbitrum One (Nitro / EVM) | Sui Network (Move VM) | Architectural Advantage on Sui |
| :--- | :--- | :--- | :--- |
| **Execution Pattern** | **Callback Pattern** (`IFlashLoanSimpleReceiver`, `IMorphoFlashLoanCallback`) | **Hot Potato Pattern** (Struct with zero abilities: no `copy`, `drop`, `store`, `key`) | Eliminates contract callback interfaces; guaranteed linear consumption at compile/typecheck time. |
| **Atomic Composition** | Requires deploying an intermediary contract router (`MultiVenueArbitrageExecutor`) to chain multi-DEX calls. | **Programmable Transaction Blocks (PTB)** natively chain up to 1,024 commands atomically. | No custom routing contract needed for intermediate token transfers; commands pass outputs directly. |
| **Reentrancy Risk** | High; requires complex state machines (`Phase::AwaitingFlash`, `Phase::UnlockingV4`) to prevent hijacking. | **Mathematically Zero**; Sui Move enforces strict borrow semantics and no dynamic dispatch reentrancy. | Total immunity to callback reentrancy or state injection attacks. |
| **Fail-Fast Revert Cost** | $\approx \$0.005 - \$0.015$ (Nitro L2 execution gas). | $\approx \$0.0008 - \$0.002$ ($< 0.001$ SUI; storage rebate covers cleaned objects). | Over $5\times - 10\times$ lower failed speculative execution penalty. |
| **Latency & Finality** | $\sim 100 - 125\text{ ms}$ Sequencer soft confirmations. | $\sim 300 - 400\text{ ms}$ Mysticeti DAG BFT consensus; sub-round fast path for owned gas objects. | Deterministic, non-reorgable finality without EVM uncle-blocks or L2 sequencer stalls. |
| **Lending Protocols** | Aave v3, Morpho Blue, Balancer v2. | **Scallop Protocol**, **NAVI Protocol**, Custom Hot Potato Vault. | Scallop & NAVI provide native zero/low fee flash loans with deep SUI, USDC, USDT liquidity. |
| **DEX Venues** | Uniswap v2/v3/v4, Camelot v3, PancakeSwap v3. | **Cetus CLMM** (Concentrated Liquidity), **DeepBook v3** (Native CLOB), Turbos, Aftermath. | Ultra-efficient hybrid routing between AMM curves and on-chain orderbook limit orders. |

---

## 3. Core System Components

1. **Smart Contract Layer (`sui-flash-executor`)**:
   - `hot_potato_lender::FlashPool<T>`: Standalone Hot Potato flash loan vault with 0% fee capability and un-droppable `FlashLoanReceipt`.
   - `arbitrage_guard`: On-chain invariant verification asserting that realized profit $\ge \text{min\_profit}$, sweeping profits to treasury, and reverting the entire PTB if negative.
   - `dex_adapters`: Normalized PTB builder entry points for Cetus CLMM, DeepBook v3 CLOB, Scallop, and NAVI.
   - Capability-gated access (`OperatorCap`, `AdminCap`) for operator configuration and treasury operations.

2. **Off-Chain Speculative Route & Sizing Engine**:
   - **Ingress**: WebSocket/gRPC stream tracking live Sui shared object updates (`CetusPool`, `DeepBookPool`, `ScallopPool`).
   - **Forward-State Math ($S_{t+1}$)**: Closed-form register projection for Cetus tick crossings and DeepBook orderbook depth in CPU registers ($<500\text{ ns}$).
   - **Analytical Sizing ($Q^*$)**: Fast calculus derivative solver for 2-hop cycles and bounded 1D Brent solver for piecewise CLMM tick boundaries ($<1.5\ \mu\text{s}$).
   - **Zero-Copy PTB Patcher**: Pre-allocated BCS byte buffers patched with optimal borrow amount $Q^*$ and minimum profit in $<300\text{ ns}$.

3. **Data Schemas & Strict Enforcer Verification**:
   - Type-safe JSON Schemas (`sui-scan-config`, `sui-scan-envelope`, `sui-opportunity`, `sui-ptb-route`, `sui-execution-receipt`).
   - Hardened risk gates: daily loss limits, gas budget caps (MIST), shared object version mismatch mitigation, and conservative receipt valuation.

---

## 4. Locked Deliverable Sentence

> The Sui Hot Potato Flashloan Service delivers an end-to-end, sub-millisecond speculative arbitrage engine combining zero-ability Move Hot Potatoes, native PTB multi-DEX composition (Cetus & DeepBook v3), and closed-form mathematical sizing, reducing on-chain fail-fast revert costs below $0.002 while eliminating EVM callback attack surfaces entirely.
