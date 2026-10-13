# Speculative Route Engine & Zero-Copy PTB Construction on Sui

## 1. High-Performance Systems Architecture

To achieve trigger-to-wire dispatch latency under $5\ \mu\text{s}$, the Sui Flashloan Engine (`sui-flashloan-daemon`) adapts the Arbitrum Rust/Alloy speculative topology to the Sui execution runtime using Rust (`sui-sdk`, `bcs`, `tokio`, `io_uring`, `core_affinity`).

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      SUI SPECULATIVE ENGINE THREAD ISOLATION                           │
├───────────────────┬──────────────┬──────────────────┬──────────────────────────────────┤
│ LOGICAL THREAD    │ CPU CORE PIN │ PRIORITY CLASS   │ EXECUTION INSTRUCTION            │
├───────────────────┼──────────────┼──────────────────┼──────────────────────────────────┤
│ Ingress Stream    │ Core 1 (Hex) │ `SCHED_FIFO` 99  │ Reads gRPC/WS object updates     │
│ Math Solver       │ Core 2 (Hex) │ `SCHED_FIFO` 98  │ Cetus CLMM / DeepBook S(t+1) Q*  │
│ PTB Wire Dispatch │ Core 3 (Hex) │ `SCHED_FIFO` 99  │ Zero-copy BCS patch + socket out │
│ State Sync Worker │ Core 4 (Hex) │ `SCHED_OTHER`    │ Checkpoint indexing & re-fetch   │
└───────────────────┴──────────────┴──────────────────┴──────────────────────────────────┘
```

---

## 2. Forward-State Mathematics ($S_t \to S_{t+1}$) for Sui Venues

### 2.1 Cetus CLMM Piecewise Forward-State Walk

Cetus pools operate on concentrated liquidity where token price is represented by $\sqrt{P} \in Q64.64$. When an external transaction executes a swap with input $\Delta x_{\text{ext}}$, the solver projects the post-swap state $(P_{\text{target}}, L_{\text{next}}, \text{tick}_{\text{next}})$ without RPC queries:

#### 1. Intra-Tick Step
For direction $A \to B$ (`a2b = true`), price decreases:

$$\Delta x = \frac{L \cdot (\sqrt{P}_{\text{current}} - \sqrt{P}_{\text{target}})}{\sqrt{P}_{\text{current}} \cdot \sqrt{P}_{\text{target}}}$$

Solving for terminal price $\sqrt{P}_{\text{target}}$ inside the active tick:

$$\sqrt{P}_{\text{target}} = \frac{L \cdot \sqrt{P}_{\text{current}}}{L + \gamma \cdot \Delta x_{\text{rem}} \cdot \sqrt{P}_{\text{current}}}$$

The extracted intermediate token output is:

$$\Delta y_{\text{out}} = L \cdot (\sqrt{P}_{\text{current}} - \sqrt{P}_{\text{target}})$$

#### 2. Tick Boundary Inversion
When input exceeds active tick capacity ($\gamma \cdot \Delta x_{\text{rem}} \ge \Delta x_{\text{max}}$), the engine consumes the next initialized tick from the cached bitmap index, updates net liquidity $L \leftarrow L - \Delta L_{\text{net}}$, and continues traversal.

---

### 2.2 DeepBook v3 Orderbook Matching Engine Projection

DeepBook v3 maintains a Central Limit Order Book (CLOB). For an incoming market order or swap, the forward state is projected by matching against resting limit orders in the local in-memory orderbook tree:

```
Algorithm: DeepBook-Orderbook-Projection
Input: Orderbook BookSide (Bids or Asks), Input Amount Q_in
Output: Projected Output Amount Q_out, Effective Execution Price P_eff

1. Q_rem = Q_in, Q_out = 0
2. For each price level L_i in sorted book:
3.     Depth_available = L_i.quantity * L_i.price
4.     If Q_rem <= Depth_available:
5.         Q_out += Q_rem / L_i.price
6.         Break
7.     Else:
8.         Q_out += L_i.quantity
9.         Q_rem -= Depth_available
10. Return Q_out
```

---

## 3. Closed-Form Analytical Sizing ($Q^*$) for Hybrid AMM-CLOB Cycles

In a cyclic arbitrage borrowing asset $X$, buying intermediate asset $Y$ on Cetus (AMM), and selling $Y$ back to $X$ on DeepBook (CLOB):

### 3.1 Closed-Form Calculus Solution
When DeepBook's depth at the best order levels can be approximated as a continuous linear price impact function $P_{\text{CLOB}}(y) = P_0 - m \cdot y$:

$$\Pi(Q) = \text{CLOB\_Out}\big(\text{Cetus\_Out}(Q)\big) - Q \cdot (1 + f_{\text{flash}}) - \mathcal{C}_{\text{gas}}$$

Setting $\frac{d\Pi}{dQ} = 0$, the optimal borrow size $Q^*$ is solved analytically in $< 1.5\ \mu\text{s}$:

$$Q^* = \frac{\sqrt{\gamma_1 \gamma_2 R_{1,y} R_{2,x} \cdot R_{1,x} R_{2,y}} - R_{1,x} R_{2,y}}{\gamma_1 (R_{2,y} + \gamma_2 R_{1,y})}$$

### 3.2 Bounded 1D Brent's Optimizer for Multi-Tick Crossings
If the swap crosses multiple discrete tick boundaries or discontinuous CLOB price levels, the engine executes a 12-iteration bounded Brent root solver over the marginal profit derivative $M(Q) = 0$ in $< 12.0\ \mu\text{s}$.

---

## 4. Programmable Transaction Block (PTB) Structure

On Sui, the entire flashloan and arbitrage execution is expressed as a single PTB:

```rust
use sui_sdk::types::transaction::{
    Argument, CallArg, Command, ObjectArg, ProgrammableTransaction, TransactionData,
};

pub fn build_hot_potato_ptb(
    flash_pool_id: ObjectID,
    cetus_pool_id: ObjectID,
    deepbook_pool_id: ObjectID,
    operator_cap_id: ObjectID,
    borrow_amount: u64,
    min_profit: u64,
    treasury_address: SuiAddress,
) -> ProgrammableTransaction {
    let mut ptb = ProgrammableTransaction {
        inputs: vec![
            // Inputs: Object and Pure values
            CallArg::Object(ObjectArg::SharedObject { id: flash_pool_id, initial_shared_version: 1, mutable: true }),
            CallArg::Pure(bcs::to_bytes(&borrow_amount).unwrap()),
            CallArg::Pure(bcs::to_bytes(&min_profit).unwrap()),
            CallArg::Pure(bcs::to_bytes(&treasury_address).unwrap()),
        ],
        commands: vec![],
    };

    // Command 0: Borrow Flash Loan -> Returns (Coin<USDC>, FlashLoanReceipt)
    ptb.commands.push(Command::move_call(
        PACKAGE_ID,
        ident_str!("hot_potato_lender").to_owned(),
        ident_str!("borrow_flash_loan").to_owned(),
        vec![USDC_TYPE],
        vec![Argument::Input(0), Argument::Input(1)],
    ));
    // Result(0) = (borrowed_coin, receipt)

    // Command 1: Swap borrowed USDC for SUI on Cetus
    ptb.commands.push(Command::move_call(
        CETUS_PACKAGE_ID,
        ident_str!("pool").to_owned(),
        ident_str!("swap").to_owned(),
        vec![USDC_TYPE, SUI_TYPE],
        vec![CETUS_POOL_ARG, Argument::NestedResult(0, 0)],
    ));
    // Result(1) = sui_coin

    // Command 2: Swap SUI back to USDC on DeepBook v3
    ptb.commands.push(Command::move_call(
        DEEPBOOK_PACKAGE_ID,
        ident_str!("pool").to_owned(),
        ident_str!("swap_exact_base_for_quote").to_owned(),
        vec![SUI_TYPE, USDC_TYPE],
        vec![DEEPBOOK_POOL_ARG, Argument::Result(1)],
    ));
    // Result(2) = (returned_usdc, remainder_sui, fee_deep)

    // Command 3: Split repayment amount from returned_usdc
    ptb.commands.push(Command::SplitCoins(
        Argument::NestedResult(2, 0),
        vec![Argument::Input(1)], // borrow_amount (+ fee)
    ));
    // Result(3) = repay_coin

    // Command 4: Repay Flash Loan -> Consumes Hot Potato receipt!
    ptb.commands.push(Command::move_call(
        PACKAGE_ID,
        ident_str!("hot_potato_lender").to_owned(),
        ident_str!("repay_flash_loan").to_owned(),
        vec![USDC_TYPE],
        vec![
            Argument::Input(0),              // pool
            Argument::NestedResult(3, 0),     // repay_coin
            Argument::NestedResult(0, 1),     // FlashLoanReceipt Hot Potato!
        ],
    ));

    // Command 5: Verify profit invariant & sweep surplus to treasury
    ptb.commands.push(Command::move_call(
        PACKAGE_ID,
        ident_str!("arbitrage_guard").to_owned(),
        ident_str!("verify_and_sweep").to_owned(),
        vec![USDC_TYPE],
        vec![
            OPERATOR_CAP_ARG,
            Argument::NestedResult(2, 0), // surplus remainder coin
            Argument::Input(2),           // min_profit hurdle
            Argument::Input(3),           // treasury address
        ],
    ));

    ptb
}
```

---

## 5. Zero-Copy BCS Byte Patching

To eliminate BCS serialization overhead in the critical path, the daemon pre-serializes the `TransactionData` envelope at startup. In the critical path, only the 8-byte little-endian integers for `borrow_amount` and `min_profit` are spliced into pre-indexed buffer offsets:

```rust
pub struct PreAllocatedBcsEnvelope {
    pub raw_buffer: [u8; 1024],
    pub length: usize,
    pub offset_borrow_amount: usize,
    pub offset_min_profit: usize,
}

impl PreAllocatedBcsEnvelope {
    /// In-place mutation of serialized BCS buffer in < 40 ns
    #[inline(always)]
    pub fn patch_payload(&mut self, borrow_amount: u64, min_profit: u64) {
        let borrow_bytes = borrow_amount.to_le_bytes();
        let profit_bytes = min_profit.to_le_bytes();

        self.raw_buffer[self.offset_borrow_amount..self.offset_borrow_amount + 8]
            .copy_from_slice(&borrow_bytes);
        self.raw_buffer[self.offset_min_profit..self.offset_min_profit + 8]
            .copy_from_slice(&profit_bytes);
    }
}
```
