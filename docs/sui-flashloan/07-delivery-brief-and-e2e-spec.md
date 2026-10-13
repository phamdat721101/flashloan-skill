# Delivery Brief & End-to-End (E2E) Verification Specification

## 1. Formal Product Delivery Brief (`nim-deliver`)

### 1.1 Client Outcome
An autonomous agent or DeFi operator can submit validated, schema-compliant arbitrage opportunities on the Sui Network to a unified runtime. The runtime constructs a zero-ability Hot Potato Programmable Transaction Block (PTB) chaining flash liquidity across Cetus CLMM and DeepBook v3, validates exact mathematical solvency, and submits the transaction with fail-fast on-chain revert protection, persisting all realized P&L to a tamper-proof ledger.

### 1.2 Target Environment Contract
```env
# Sui Network RPC & Endpoints
SUI_NETWORK=mainnet
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
SUI_WS_URL=wss://fullnode.mainnet.sui.io:443

# Deployed Package & Object IDs
SUI_FLASH_PACKAGE_ID=0x...
SUI_HOT_POTATO_POOL_ID=0x...
SUI_OPERATOR_CAP_ID=0x...
SUI_TREASURY_ADDRESS=0x...

# Operator Credentials (Kept local, never serialized)
SUI_OPERATOR_PRIVATE_KEY=suiprivkey...

# Risk & Throttle Policy
MIN_NET_PROFIT_USD=10.00
MAX_DAILY_LOSS_USD=50.00
MAX_GAS_BUDGET_MIST=50000000
```

---

## 2. Five Mandatory Seam-Anchored Chaos Threats

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FIVE SEAM CHAOS MATRIX                          │
├─────────┬─────────────────────────┬────────────────────────────────────┤
│ SEAM ID │ THREAT HYPOTHESIS       │ DETERMINISTIC RECOVERY / GUARD     │
├─────────┼─────────────────────────┼────────────────────────────────────┤
│ SEAM-01 │ Ingress Desync:         │ Reconcile checkpoint sequence;     │
│         │ Stale object versions   │ abort routing if lag > 500 ms.     │
├─────────┼─────────────────────────┼────────────────────────────────────┤
│ SEAM-02 │ Solver Tick Divergence: │ Bounded Brent fallback with        │
│         │ CLMM tick discontinuity │ max 12 iterations; reject on NaN.  │
├─────────┼─────────────────────────┼────────────────────────────────────┤
│ SEAM-03 │ Shared Object Lockout:  │ Hot Potato reverts in <2,000 gas;  │
│         │ Concurrent pool mut.    │ loss capped below $0.002.          │
├─────────┼─────────────────────────┼────────────────────────────────────┤
│ SEAM-04 │ Gas Equivocation:       │ 16-way gas coin sharding pool      │
│         │ Multiple txs same coin  │ with atomic CAS leases.            │
├─────────┼─────────────────────────┼────────────────────────────────────┤
│ SEAM-05 │ Valuation Drift:        │ Fail-closed halt in loss ledger    │
│         │ Unparseable receipt     │ until operator manually reviews.   │
└─────────┴─────────────────────────┴────────────────────────────────────┘
```

---

## 3. End-to-End Verification Pipeline

### Phase 1: Move Smart Contract Verification
```sh
cd contracts/sui_flash_executor
sui move test
```
* **Success Criteria**: 100% pass rate on `test_flash_loan_atomic_success`, verifying Hot Potato destruction, fee transfer, and `verify_and_sweep` threshold abort.

### Phase 2: PTB Serialization & Dry-Run Simulation
```sh
node dist/sui-cli.js dry-run --opportunity test/fixtures/sui-opportunity-cetus-deepbook.json
```
* **Success Criteria**: `sui_dryRunTransactionBlock` returns `status: "success"` with positive net token balance delta and zero storage rebate leak.

### Phase 3: Fork / Replay Test with Sandboxed State
```sh
cargo test --package sui-flashloan-daemon --test replay
```
* **Success Criteria**: Dual-ingress events replay deterministically, producing exact identical BCS byte buffers and verifying zero memory allocations in the hot path.

### Phase 4: Testnet Canary Run
1. Fund testnet operator address with 10 SUI.
2. Execute a live canary trade with `MIN_NET_PROFIT_USD=1.00`.
3. Assert that the transaction digest is indexed on SuiScan and profit sweeps to the treasury address.

### Phase 5: Autonomous Production Mode
Enable `sui-cli execute-auto` only when:
- Gas coin sharding pool is initialized.
- Daily loss ledger is clean (`current_loss == 0`).
- Operator key matches `OperatorCap` owner address.
