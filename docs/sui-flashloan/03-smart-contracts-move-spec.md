# Sui Move Smart Contracts Specification

## 1. Package Overview & Architecture

The smart contract layer for the Sui Flashloan Service is structured as an institutional Move package: `sui_flash_executor`.

```
contracts/sui_flash_executor/
├── Move.toml
└── sources/
    ├── hot_potato_lender.move    # Zero-fee / low-fee Hot Potato Flash Loan Vault
    ├── arbitrage_guard.move      # On-chain fail-fast profit invariant & treasury sweep
    └── dex_adapters.move         # Normalized PTB helper interfaces for Cetus & DeepBook
```

---

## 2. Package Configuration (`Move.toml`)

```toml
[package]
name = "sui_flash_executor"
edition = "2024.beta"
license = "MIT"

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/mainnet" }
DeepBook = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/deepbook", rev = "framework/mainnet" }

[addresses]
sui_flash_executor = "0x0"
```

---

## 3. Production Source Code

### 3.1 `sources/hot_potato_lender.move`

```move
// SPDX-License-Identifier: MIT
module sui_flash_executor::hot_potato_lender {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::transfer;

    // --- Error Codes ---
    const E_INSUFFICIENT_POOL_LIQUIDITY: u64 = 101;
    const E_INSUFFICIENT_REPAYMENT: u64 = 102;
    const E_WRONG_POOL_RECEIPT: u64 = 103;
    const E_UNAUTHORIZED: u64 = 104;

    // --- Capabilities ---
    public struct AdminCap has key, store {
        id: UID,
    }

    // --- Shared Flash Pool ---
    public struct FlashPool<phantom T> has key {
        id: UID,
        reserves: Balance<T>,
        fee_bps: u64, // 0 for zero-fee private vault, or basis points (e.g. 5 = 0.05%)
        active_loans_count: u64,
    }

    /// The Hot Potato struct: NO abilities (no copy, drop, store, key)
    /// Guarantees that the value must be unpacked within the exact same transaction block.
    public struct FlashLoanReceipt {
        pool_id: ID,
        borrow_amount: u64,
        fee_amount: u64,
    }

    // --- Events ---
    public struct PoolCreated has copy, drop {
        pool_id: ID,
        fee_bps: u64,
    }

    public struct FlashLoanBorrowed has copy, drop {
        pool_id: ID,
        borrow_amount: u64,
        fee_amount: u64,
        borrower: address,
    }

    public struct FlashLoanRepaid has copy, drop {
        pool_id: ID,
        repay_amount: u64,
        fee_amount: u64,
        borrower: address,
    }

    // --- Module Initializer ---
    fun init(ctx: &mut TxContext) {
        let admin_cap = AdminCap {
            id: object::new(ctx),
        };
        transfer::transfer(admin_cap, tx_context::sender(ctx));
    }

    // --- Pool Lifecycle ---
    public fun create_pool<T>(fee_bps: u64, ctx: &mut TxContext) {
        let pool_uid = object::new(ctx);
        let pool_id = object::uid_to_inner(&pool_uid);

        let pool = FlashPool<T> {
            id: pool_uid,
            reserves: balance::zero<T>(),
            fee_bps,
            active_loans_count: 0,
        };

        transfer::share_object(pool);

        event::emit(PoolCreated {
            pool_id,
            fee_bps,
        });
    }

    public fun deposit_liquidity<T>(
        pool: &mut FlashPool<T>,
        deposit: Coin<T>,
        _ctx: &mut TxContext,
    ) {
        let deposit_balance = coin::into_balance(deposit);
        balance::join(&mut pool.reserves, deposit_balance);
    }

    public fun withdraw_liquidity<T>(
        _admin: &AdminCap,
        pool: &mut FlashPool<T>,
        amount: u64,
        ctx: &mut TxContext,
    ): Coin<T> {
        let withdrawn_balance = balance::split(&mut pool.reserves, amount);
        coin::from_balance(withdrawn_balance, ctx)
    }

    // --- Core Hot Potato Flash Loan Functions ---

    /// Borrow liquidity from the pool. Returns the borrowed coin and the un-droppable FlashLoanReceipt.
    public fun borrow_flash_loan<T>(
        pool: &mut FlashPool<T>,
        amount: u64,
        ctx: &mut TxContext,
    ): (Coin<T>, FlashLoanReceipt) {
        assert!(balance::value(&pool.reserves) >= amount, E_INSUFFICIENT_POOL_LIQUIDITY);

        let fee_amount = if (pool.fee_bps > 0) {
            ((amount as u128) * (pool.fee_bps as u128) / 10_000) as u64
        } else {
            0
        };

        let loan_balance = balance::split(&mut pool.reserves, amount);
        let loan_coin = coin::from_balance(loan_balance, ctx);

        pool.active_loans_count = pool.active_loans_count + 1;

        let receipt = FlashLoanReceipt {
            pool_id: object::id(pool),
            borrow_amount: amount,
            fee_amount,
        };

        event::emit(FlashLoanBorrowed {
            pool_id: object::id(pool),
            borrow_amount: amount,
            fee_amount,
            borrower: tx_context::sender(ctx),
        });

        (loan_coin, receipt)
    }

    /// Repay the borrowed liquidity plus required fee. Unpacks and consumes the Hot Potato.
    public fun repay_flash_loan<T>(
        pool: &mut FlashPool<T>,
        repayment: Coin<T>,
        receipt: FlashLoanReceipt,
        ctx: &mut TxContext,
    ) {
        // Destructure the Hot Potato (only possible within this module)
        let FlashLoanReceipt { pool_id, borrow_amount, fee_amount } = receipt;

        assert!(object::id(pool) == pool_id, E_WRONG_POOL_RECEIPT);

        let required_amount = borrow_amount + fee_amount;
        let repayment_value = coin::value(&repayment);
        assert!(repayment_value >= required_amount, E_INSUFFICIENT_REPAYMENT);

        let repayment_balance = coin::into_balance(repayment);
        balance::join(&mut pool.reserves, repayment_balance);

        pool.active_loans_count = pool.active_loans_count - 1;

        event::emit(FlashLoanRepaid {
            pool_id,
            repay_amount: repayment_value,
            fee_amount,
            borrower: tx_context::sender(ctx),
        });
    }

    // --- Read-Only Getters ---
    public fun get_pool_reserves<T>(pool: &FlashPool<T>): u64 {
        balance::value(&pool.reserves)
    }

    public fun get_fee_bps<T>(pool: &FlashPool<T>): u64 {
        pool.fee_bps
    }
}
```

---

### 3.2 `sources/arbitrage_guard.move`

```move
// SPDX-License-Identifier: MIT
module sui_flash_executor::arbitrage_guard {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::transfer;

    // --- Error Codes ---
    const E_INSUFFICIENT_NET_PROFIT: u64 = 201;
    const E_DEADLINE_EXPIRED: u64 = 202;
    const E_BALANCE_MISMATCH: u64 = 203;

    // --- Operator Capability ---
    public struct OperatorCap has key, store {
        id: UID,
    }

    // --- Events ---
    public struct ArbitrageExecuted has copy, drop {
        token_type: vector<u8>,
        net_profit: u64,
        treasury: address,
        executor: address,
    }

    fun init(ctx: &mut TxContext) {
        let cap = OperatorCap { id: object::new(ctx) };
        transfer::transfer(cap, tx_context::sender(ctx));
    }

    /// On-chain Fail-Fast Invariant:
    /// Asserts that realized profit meets or exceeds the minimum hurdle `min_profit`.
    /// Sweeps the entire net profit to `treasury`.
    /// If profit < min_profit, aborts the entire PTB atomically!
    public fun verify_and_sweep<T>(
        _cap: &OperatorCap,
        surplus_coin: Coin<T>,
        min_profit: u64,
        treasury: address,
        ctx: &mut TxContext,
    ) {
        let profit_value = coin::value(&surplus_coin);
        assert!(profit_value >= min_profit, E_INSUFFICIENT_NET_PROFIT);

        event::emit(ArbitrageExecuted {
            token_type: b"SUI/USDC",
            net_profit: profit_value,
            treasury,
            executor: tx_context::sender(ctx),
        });

        transfer::public_transfer(surplus_coin, treasury);
    }

    /// Exact balance conservation check to prevent 1-mist rounding bleed
    public fun assert_exact_minimum<T>(
        coin_ref: &Coin<T>,
        expected_minimum: u64,
    ) {
        assert!(coin::value(coin_ref) >= expected_minimum, E_BALANCE_MISMATCH);
    }
}
```

---

### 3.3 `sources/dex_adapters.move`

```move
// SPDX-License-Identifier: MIT
module sui_flash_executor::dex_adapters {
    use sui::coin::{Self, Coin};
    use sui::tx_context::TxContext;

    // --- Normalized PTB Splitting Utility ---
    /// Splits an input coin into exact repayment quantity and surplus profit coin
    public fun split_repayment_and_profit<T>(
        mut total_coin: Coin<T>,
        repayment_amount: u64,
        ctx: &mut TxContext,
    ): (Coin<T>, Coin<T>) {
        let repay_coin = coin::split(&mut total_coin, repayment_amount, ctx);
        let profit_coin = total_coin; // remainder is pure net profit
        (repay_coin, profit_coin)
    }
}
```

---

## 4. Test Suite (`tests/hot_potato_test.move`)

```move
#[test_only]
module sui_flash_executor::hot_potato_test {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui_flash_executor::hot_potato_lender::{Self, FlashPool, FlashLoanReceipt, AdminCap};
    use sui_flash_executor::arbitrage_guard::{Self, OperatorCap};

    const ADMIN: address = @0xA11CE;
    const OPERATOR: address = @0xB0B;
    const TREASURY: address = @0xCAFE;

    #[test]
    fun test_flash_loan_atomic_success() {
        let mut scenario = ts::begin(ADMIN);

        // 1. Initialize modules
        {
            hot_potato_lender::create_pool<SUI>(0, ts::ctx(&mut scenario));
        };

        // 2. Fund pool with 1,000 SUI
        ts::next_tx(&mut scenario, ADMIN);
        {
            let mut pool = ts::take_shared<FlashPool<SUI>>(&scenario);
            let deposit = coin::mint_for_testing<SUI>(1_000_000_000_000, ts::ctx(&mut scenario));
            hot_potato_lender::deposit_liquidity(&mut pool, deposit, ts::ctx(&mut scenario));
            ts::return_shared(pool);
        };

        // 3. Borrow 100 SUI, simulate profitable trade (+10 SUI), and repay
        ts::next_tx(&mut scenario, OPERATOR);
        {
            let mut pool = ts::take_shared<FlashPool<SUI>>(&scenario);
            let (borrowed_coin, receipt) = hot_potato_lender::borrow_flash_loan<SUI>(
                &mut pool,
                100_000_000_000,
                ts::ctx(&mut scenario)
            );

            // Simulate simulated arbitrage gain (+10 SUI profit)
            let mut returned_funds = borrowed_coin;
            let profit = coin::mint_for_testing<SUI>(10_000_000_000, ts::ctx(&mut scenario));
            coin::join(&mut returned_funds, profit);

            // Split into exact repayment (100 SUI) and profit (10 SUI)
            let repay_coin = coin::split(&mut returned_funds, 100_000_000_000, ts::ctx(&mut scenario));
            let profit_coin = returned_funds;

            // Repay flash loan -> consumes Hot Potato receipt!
            hot_potato_lender::repay_flash_loan(&mut pool, repay_coin, receipt, ts::ctx(&mut scenario));

            // Verify profit >= 5 SUI hurdle and sweep to treasury
            let op_cap = arbitrage_guard::init_for_testing(ts::ctx(&mut scenario));
            arbitrage_guard::verify_and_sweep(
                &op_cap,
                profit_coin,
                5_000_000_000, // min profit: 5 SUI
                TREASURY,
                ts::ctx(&mut scenario)
            );
            arbitrage_guard::destroy_cap_for_testing(op_cap);

            ts::return_shared(pool);
        };

        ts::end(scenario);
    }
}
```

---

## 5. Deployment & On-Chain Publishing Instructions

```sh
# 1. Run strict unit tests
sui move test

# 2. Build bytecode
sui move build

# 3. Publish to Sui Testnet/Mainnet
sui client publish --gas-budget 200000000 --json > deployment.json

# 4. Extract generated Package ID & Capabilities
PACKAGE_ID=$(jq -r '.objectChanges[] | select(.type=="published") | .packageId' deployment.json)
ADMIN_CAP=$(jq -r '.objectChanges[] | select(.objectType | contains("AdminCap")) | .objectId' deployment.json)
OPERATOR_CAP=$(jq -r '.objectChanges[] | select(.objectType | contains("OperatorCap")) | .objectId' deployment.json)
```
