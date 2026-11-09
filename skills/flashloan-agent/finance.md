# Finance mode (optional, default off)

Use only for explicit requests about a user's own lending position, repayment, risk reduction or an XRPL Payment. Finance is a separate lane: it never changes arbitrage floors, prompts or prediction authority.

## What it does

1. **Read**: `positions` for Aave V3 / Morpho Blue on Arbitrum and Base, plus XRPL account balances and XLS-66 loan statements when the amendment is verified. Robinhood is portfolio only. Missing coverage is reported, never shown as zero.
2. **Compare**: `hold` is always the zero-action baseline. A candidate is admissible only with complete state, fresh cost evidence and explicit bounds.
3. **Prepare**: the MCP returns an unsigned research `Plan` with `execution:false`. The model never writes calldata.
4. **Local**: `import-plan` → `simulate` (exact native simulation, LocalPlan hash) → owner grant → `execute` → `reconcile`.

## Commands

```sh
# remote research (finance.request/1) or local action (finance.local-request/1): one JSON on stdin, one JSON on stdout
node dist/finance/cli.js --config <owner-profile.json> [--adapters <adapters.json>] < request.json
# owner host records a signed Ed25519 grant (finance.approval/1); prints approvalRef
node dist/finance/cli.js --config <owner-profile.json> --adapters <adapters.json> --record-grant < grant.json
```

Exit codes: 0 ok or partial read, 2 blocked/unsupported/unknown, 1 failure.

## Rules for the agent

- Never ask for, print or store a private key, grant signature or signed transaction. The owner host signs grants. The wallet signer comes only from `FINANCE_EVM_SIGNER_KEY_FILE` (mode 600) or an admitted XRPL sign-only host.
- `outcome: ok` for import/simulate means nothing moved. Only a reconciled receipt reports an outcome.
- `SUBMISSION_UNKNOWN` means: run `reconcile` with the same `actionId`. Never prepare or send a replacement.
- `RECONCILIATION_MISMATCH` halts writes for that account until the owner reviews native state.
- `MISSING_BOUND` means the user must state a maximum spend/cost or a debt/supply postcondition. Do not invent one.
- Flash protection (`protect`) only works for an admitted, position-owning smart account. Never point an executor at someone else's collateral.
- XRPL writes are Payment only (no paths, partial payments, Batch, LoanPay or Vault). A missing codec or simulator leaves them unavailable.
- Prediction context is read-only and hands off to the separate prediction CLI with its own config and grants.
- Never promise savings, returns or that liquidation will be prevented.

## Profile

`finance.profile/1` (see `contracts/finance-v1.schema.json`). `policyHash` is the profile hashed without itself:

```sh
node -e "import('./dist/finance/contracts.js').then(c=>{const p=JSON.parse(require('fs').readFileSync(process.argv[1]));console.log(c.policyHash(p))})" profile.json
```

Any profile edit changes `policyHash` and invalidates earlier simulations and grants.
