# AI Finance lane (finance-skill-v1)

Source specification: `AI-FINANCE-UPGRADE-PRD.md` (contract `urn:openx:finance-wire:1`, digest `8046b6f9…de4edb`). Map: [finance-skill-map.md](finance-skill-map.md). Machine spec: [finance-skill.spec.json](finance-skill.spec.json). Later stage: [finance-native-credit.md](finance-native-credit.md).

## Client outcome

An existing crypto holder can read an admitted loan or account, compare holding with ordinary repayment or risk reduction, and see exact amounts, costs and permissions. They can choose a reviewed action and trace it to its actual native outcome. Read-only use needs no signing key or new funded wallet. There is no promise of savings, returns or liquidation prevention.

## Audience

Existing MCP/skill operators and one controlled borrower account per admitted market. Arbitrage and prediction stay separate lanes.

## Scope (implemented, default off)

- **R0:** a verbatim, digest-pinned contract with 17 shared vectors plus strict boundary and semantic validators. Golden research-plan and local-plan hashes match the PRD producer.
- **R1:** an authenticated MCP client with bounded job polling. Pinned-block Aave V3 / Morpho Blue reads, with eMode blocked, code-hash pins and share math. XRPL validated-ledger account, reserve and XLS-66 loan reads (Loan → LoanBroker → Vault join, same ledger).
- **R2:**
  - owner profile with a self-hash, tighten-only constraint intersection, and LocalPlan bound to fresh fee/nonce/sequence and code/owner/approval-key pins
  - exact `eth_call` simulation and one-use Ed25519 grants
  - fsynced hash-chained journal with account+sender leases and crash-safe SUBMITTING
  - receipt and position reconciliation
  - XRPL Payment builder with sign-only host and pinned optional codec gates
- **R3:** `contracts/FinanceProtectionAccount.sol` (position-owning smart account; Morpho flash via the audited `FlashCallbackCore`; repay → withdraw → exact-route swap → repay flash → on-chain bounds). Plus a TypeScript `compileProtect` recipe bound into the LocalPlan.
- **R4:** prediction-context handoff to the independent PredictionRuntime as a read-only paper request. No grant or budget crosses over.

## Non-goals

Arbitrage floor changes, server signers, model-authored calldata, generic call execution, automatic migration, XRPL credit writes (deferred to V2), cross-chain flash, prediction-funded borrowing, and live or funded runs without separate authorization.

## Selected approach and why

An isolated `src/finance/` lane that mirrors the proven `src/prediction/` patterns (validator, Ed25519 grant, ExecutionLock journal, stdin CLI). It reuses `canonicalBytes`, `estimateEvmFees`/`receiptNativeCost`, `ExecutionLock` and `FlashCallbackCore`. It adds no new runtime dependency (ajv and viem are already present; the XRPL codec is optional and pinned).

## Gstack review (lean in-host eng review, 2026-11-09)

Verdict: approved with three obligations, all met:
1. R3 inherits `FlashCallbackCore` (Morpho flash).
2. `strictParse` rejects duplicate and prototype keys before Ajv.
3. Nonce reservation and lease checks happen before any signer access.

The CEO/design/DX phases and the Codex outside voice were skipped at the owner's request. The engineering-design score from the PRD is unchanged: commercial greenlight is NOT ESTABLISHED (13/42).

## E2E status

| Rows | Fidelity | Status |
|---|---|---|
| E2E-01, 03 (transport), 07, 11, 12 (hash parity), 13 | unit + CLI + loopback MCP | PASS |
| E2E-04, 05, 06, 08, 09, 10, 15, 16, 17, 18, 20, 21 (local-reported only), 22 | anvil local chain + recorded-shape XRPL fixture | PASS |
| E2E-19 | Forge (8 cases) + anvil runtime path | PASS |
| E2E-25 | handoff only; prediction lifecycle covered by existing `prediction:test` | PASS (handoff) |
| E2E-02, 23, 24 | require the HyperMove worker (MC-*) | BLOCKED: producer not implemented |
| E2E-26 | browser UI (HyperMove) | N/A in this repo |
| E2E-27 | installer packages the pinned contract; a tampered schema fails `loadContract` | PASS (unit) |
| E2E-28 live read matrix, E2E-29 funded pilot | live providers / owner authorization | NOT_RUN: needs explicit authorization |
| E2E-30 | no bridge code path exists; foreign-asset flash rejected by `InvalidRoute` | PASS (Forge asset-pair case) |

Local positive fixtures are not mainnet, fork or funded evidence.

## Risks

- Real Aave/Morpho market manifests and XLS-66 loan flag bits must be pinned against live deployments before E2E-28.
- `config/finance/adapters.example.json` admits no market by default.
- An MCP tool name (`finance_<operation>`) must match the HyperMove MC-02 registry.
- One signer EOA shared by an EOA position and its protection account is serialized by the sender lease.

## Rollout and rollback

Enable read-only first (`enabled:true, live:false`), then one admitted market with `live:true`. To roll back, set `enabled:false` before reverting code. The journal and signed artifacts are kept for any submitted or UNKNOWN action.

## Environment contract

- `FINANCE_MCP_AUTH_TOKEN`: optional session token.
- `FINANCE_EVM_SIGNER_KEY_FILE`: owner-only key file, write path only.
- `FINANCE_{ARBITRUM,BASE,XRPL}_RPC_URL`: named by the adapter manifest.
- The optional XRPL codec is pinned by `codecVersion`, with null as the default.
- Verified HTTPS everywhere, except loopback in fixtures.
