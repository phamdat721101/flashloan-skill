# Finance V2: native XRPL credit (XLS-66 LoanPay + XLS-33 MPT)

**Status:** specification only, NOT_STARTED. Code ships later behind `nativeCredit=false` and needs separate owner approval. Depends on finance-skill-v1 (SK-02, SK-09).

## Client outcome

An XRPL borrower can repay an XLS-66 loan (periodic, overpayment or full payoff) and pay or hold XLS-33 MPT assets. They see exact native amounts, prerequisites and the reconciled loan state afterwards. There is no promise of savings.

## Why a new contract version

`urn:openx:finance-wire:1` is closed. Request has 12 operations, Asset has no MPT kind, and XrplPayload is Payment-only with `Flags=0`. The PRD requires native credit writes to use an independently versioned contract. V2 is `urn:openx:finance-wire:2` in `schemas/finance-v2.schema.json`, with its own digest pin. v1 bytes, digest and vectors stay unchanged and accepted side by side. `schemaVersion` `finance.request/2` / `finance.local-request/2` selects the validator, and v1 input is never upgraded silently. HyperMove produces the byte-identical producer copy.

## Schema additions (draft)

```json finance-v2-additions
{
  "AssetMpt": { "type": "object", "additionalProperties": false, "required": ["kind", "network", "mptIssuanceId"],
    "properties": { "kind": { "const": "xrpl-mpt" }, "network": { "const": "xrpl" }, "mptIssuanceId": { "type": "string", "pattern": "^[A-F0-9]{48}$" } } },
  "QuantityMpt": { "type": "object", "additionalProperties": false, "required": ["kind", "value"],
    "properties": { "kind": { "const": "mpt" }, "value": { "type": "string", "pattern": "^(0|[1-9][0-9]{0,18})$" } } },
  "XrplLoanPayPayload": { "type": "object", "additionalProperties": false, "required": ["kind", "networkIdentityHash", "amendmentSetHash", "loanStateHash", "tx"],
    "properties": {
      "kind": { "const": "xrpl-loan-pay" }, "networkIdentityHash": { "$ref": "#/$defs/Digest" }, "amendmentSetHash": { "$ref": "#/$defs/Digest" }, "loanStateHash": { "$ref": "#/$defs/Digest" },
      "tx": { "type": "object", "additionalProperties": false, "required": ["TransactionType", "Account", "LoanID", "Amount", "Fee", "Sequence", "LastLedgerSequence", "Flags"],
        "properties": { "TransactionType": { "const": "LoanPay" }, "Account": { "$ref": "#/$defs/XrplAddress" }, "LoanID": { "type": "string", "pattern": "^[A-F0-9]{64}$" },
          "Amount": { "description": "XRP drops | IOU {currency,issuer,value} | MPT {mpt_issuance_id,value}; must equal the vault asset" },
          "Fee": { "$ref": "#/$defs/Uint" }, "Sequence": { "type": "integer", "minimum": 0 }, "TicketSequence": { "type": "integer", "minimum": 1 }, "LastLedgerSequence": { "type": "integer", "minimum": 1 },
          "Flags": { "description": "closed enum {none, overpayment, full-payment}; numeric values pinned from the deployed XLS-66 build before freezing" } } } } }
}
```

Request adds `prepare-loan-pay {account, loanId, mode: periodic|overpayment|full, amount, requestedConstraints}`. `prepare-payment` accepts an MPT `Amount`. LocalPlan binds `loanId`, the loan-state hash, the amendment-set hash and the ledger index. New error codes: `AMENDMENT_INACTIVE`, `LOAN_STATE_CHANGED`, `LOAN_PAYMENT_INVALID`, `MPT_HOLDER_MISSING`, `MPT_LOCKED`, `MPT_TRANSFER_DISABLED`, `MPT_AUTH_REQUIRED`, `MPT_AMOUNT_OUT_OF_RANGE`.

## Admission rules

1. **Amendments.** `LendingProtocol`, `SingleAssetVault` and `MPTokensV1` must be enabled, shown by the `feature` RPC at the validated ledger. Unknown → `FEATURE_STATE_UNKNOWN`; disabled → `AMENDMENT_INACTIVE`.
2. **LoanPay.** All checks run at one validated ledger:
   - the Loan exists, Account is its borrower, and Amount matches the Vault asset
   - periodic mode needs at least `PeriodicPayment` (plus live late fees)
   - overpayment needs the Loan's overpayment flag
   - full mode pays the exact amount owed under native rounding
   - impairment and late state are read live
   - spendable balance after fee and reserve is enough, and the trust line or MPToken exists
3. **MPT.** The holder MPToken exists. Neither issuance nor holder is locked. `lsfMPTCanTransfer` is set for transfers between non-issuers. The holder is authorized when RequireAuth is set. Issuer sends stay within `MaximumAmount − OutstandingAmount`. `TransferFee` is disclosed as a cost. Amounts are integers ≤ 2^63−1; `AssetScale` is display only.
4. **Simulation.** rippled `simulate` on standalone rippled with the amendments, then a read-only live node. Without it the write stays `CAPABILITY_UNAVAILABLE`.
5. **Reconciliation.** `tesSUCCESS` is only the transaction outcome. The loan is re-read: `PaymentRemaining`, `PrincipalOutstanding` and the due date must move as expected. Deletion counts only for full mode. Anything else is `RECONCILIATION_MISMATCH`, which halts writes. A `tec*` result reports the fee consumed.
6. **Authority.** The same one-use Ed25519 grant, with the v2 digest, `loanId` and (for MPT) `mptIssuanceId` bound in, and the sign-only host. Batch (XLS-56) stays rejected.

## Tasks

| ID | Depends on | Work | Done when |
|---|---|---|---|
| SK-13 | SK-02, SK-09 | v2 schema + pin, dual-version validator, MPT quantity math | v1 vectors unchanged; v2 vectors pass; v1 request with MPT rejected |
| SK-14 | SK-13 | Amendment probe; MPT issuance/holder reader; XLS-66 read for MPT assets (removes v1 `mpt-asset-requires-v2` gap) | inactive/unknown amendment blocks; MPT balances native |
| SK-15 | SK-14 | MPT Payment builder + checks | locked / no-transfer / unauthorized / missing-holder blocked with typed codes |
| SK-16 | SK-14 | LoanPay builder, modes, postconditions | under/over/full/late correct; drift after approval → `LOAN_STATE_CHANGED` |
| SK-17 | SK-15, SK-16 | Standalone-rippled E2E + reconciliation; installer packages v2 | fixture-only evidence; mainnet writes need a separate pilot approval |

## E2E (NOT_RUN)

- **E2E-31:** a v1 request carrying MPT or LoanPay is rejected; a tampered v2 pin fails closed.
- **E2E-32:** an inactive or unknown amendment blocks the write, with no plan built.
- **E2E-33:** MPT boundaries are tested: 0, 2^63−1, 2^63, a decimal and a non-integer value.
- **E2E-34:** each MPT block case is rejected: locked issuance or holder, CanTransfer off, RequireAuth without authorization, missing MPToken.
- **E2E-35:** each LoanPay case is handled: below the periodic amount, overpayment without the flag, exact payoff, a late or impaired loan, the wrong asset, and a caller who is not the borrower.
- **E2E-36:** if the loan changes between approval and send, the result is `LOAN_STATE_CHANGED` and nothing is resent.
- **E2E-37:** on standalone rippled, simulate and submit work, a `tec*` result explains the fee consumed, and reconciliation confirms the loan fields.
- **E2E-38:** a LoanPay wrapped in Batch is still rejected.

## Reuse

`XrplFinanceAdapter` (`src/finance/xrpl.ts`) already provides validated-ledger pinning, the Loan→Broker→Vault join, fee/reserve reads, the sign-only host gate and the codec check. V2 extends it with a builder and a reconciler, not a new module.
