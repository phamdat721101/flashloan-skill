# Limitless prediction implementation — 6 November 2026

The agent now has a separate Base prediction execution lane in `src/prediction/`. It uses funded USDC and outcome inventory. Prediction settlement is asynchronous, so these trades cannot use a future prediction payout to repay an atomic flashloan.

## Implemented behavior

The CLI accepts one closed-schema JSON request and returns one JSON result. It supports discovery, preparation, execution, reconciliation, cancellation, positions, redemption, watch, halt and resume, plus capabilities and doctor. It accepts binary and NegRisk CLOB markets, FAK and GTC, and legacy/share or collateral/USDC fees. Unsupported venue types fail closed.

The optional official SDK is pinned to 1.3.0. Its public OrderBuilder, OrderSigner and HMAC HttpClient handle amounts, EIP-712 signing and authentication. The adapter submits explicit clientOrderId, timestamp, receive window and self-trade-prevention fields. It does not use the high-level createOrder wrapper, which omits those recovery fields.

Paper mode reads public market data, uses virtual cash and hypothetical visible-book fills, and never loads HMAC or signer credentials. Assisted execution needs an independently signed Ed25519 grant for the exact prepared plan. Autonomous execution needs a finite independently signed session grant. The runtime holds only the approval public key; agent input cannot grant itself authority.

A dedicated account journal reserves prediction capital independently from flashloan budgets. Account locking, checksummed replay, file/directory fsync and durable identities precede external effects. Unknown submission acceptance persists across restarts; orders are queried by clientOrderId and are not automatically reposted. Partial positions survive cancellation. A resumed reservation must retain its original grant and pass current cash/inventory and loss gates. Explicit lock recovery refuses a living process.

Receipt logs bind fills to the exact signed order digest, account, token, exchange and canonical safe/finalized block. REST status is authoritative for refresh, but a MINED/CONFIRMED claim needs canonical fill evidence regardless of a `matched` boolean. WebSocket messages only request bounded REST refreshes. Settled historical orders avoid repeated portfolio-history scans; explicit reconciliation of a stored terminal order audits its receipt hashes.

FIFO cost basis, fee bounds and realized PnL derive from confirmed fills. Resolution supports binary CTF and NegRisk adapter redemption, including losing inventory that burns for zero payout. Prediction paper and live journals are separate; fixture and production paths are separate too.

Base transaction reserves include L2 execution gas and twice estimated L1 publication/operator fees. Receipts account for publication charges and the historical operator fee. L1 charges vary and cannot be capped by the L2 transaction itself. An exceeded reserve or missing receipt fee evidence blocks recovery for review.

## Input/output contract

The full contract is `schemas/prediction-v1.schema.json`, pinned by SHA-256 in `config/prediction/schema-version.json`. The installed skill carries the same schema and manifest. Implementation dependencies and acceptance criteria are compiled in `docs/features/limitless-prediction.spec.json` (SPEC-2026-110608), with seven source-verified symbols.

| Object | Required meaning |
| --- | --- |
| prediction-request/1 | requestId, command, closed per-command payload with mode |
| prediction-intent/1 | unique intent/account/market; outcome, side, order type and bounded amounts |
| prediction-plan/1 | exact unsigned order, market/account snapshots, fee reserve, approvals, gas reserve, expiry and policy/plan hashes |
| prediction-grant/1 | independent owner signature; exact plan or finite session; account, policy, market, action and risk limits |
| prediction-result/1 | outcome ok/blocked/pending/failed; typed data/errors/evidence |
| prediction-event/1 | sequenced previous/event hashes and validated state transition |

USDC/share quantities use unsigned raw strings with six decimal places implied. Token IDs are strings. Prices are integer millionths: 400000 means 0.40 USDC per share. GTC uses `sharesRaw`; FAK BUY uses `spendCapRaw`; FAK SELL uses `sharesCapRaw`. Unsafe SDK numbers and unaligned quantities are rejected rather than silently rounded.

A public doctor request is:

```json
{"schemaVersion":"prediction-request/1","requestId":"doctor-1","command":"doctor","payload":{"mode":"paper","publicOnly":true}}
```

A paper BUY preparation request, after explicitly enabling paper configuration, is:

```json
{"schemaVersion":"prediction-request/1","requestId":"prepare-1","command":"prepare","payload":{"mode":"paper","intent":{"schemaVersion":"prediction-intent/1","intentId":"intent-1","accountId":"base-bot-1","marketSlug":"OWNER_SELECTED_CURRENT_SLUG","outcome":"YES","side":"BUY","orderType":"FAK","spendCapRaw":"1000000","limitPricePpm":400000}}}
```

Preparation returns `data.kind="plan"` with `data.plan.planHash`; execution references that returned hash. The maximum offered BUY collateral here is 1 USDC, plus the explicit fee reserve. A better price can buy more shares. Execution can return `pending`; this means reconcile persisted identities, not submit another order. Actual schemas reject illustrative placeholder slugs if they fail the identifier format; a real market must come from discovery.

## Verification evidence

- Final prediction suite: 10/10 passed, including all five EDGE proofs, real SDK signature/HMAC parity, CLI subprocess restart, lost response, bounded approvals, partial fills/cancel race, FIFO, redemption, torn ledger, authority continuation, dead locks, installer/schema parity, missing-matched settlement and zero-payout burn.
- Repository `npm test` passed: Solidity build, existing Node tests and Rust workspace tests. The final targeted suite additionally covers changes made during review.
- `forge test --offline -q` passed.
- Public read acceptance passed against Base chain 8453, `/maintenance/status` and current supported Limitless markets. The verified maintenance response is `{active:[],scheduled:[]}`.
- Strict nim harness verified the compiled dependency spec, schema pin, test evidence and public-read evidence. Cache prefix equality was checked; provider cache savings were not measured.
- Gstack checklist and a fresh adversarial review found settlement proof, omitted Base publication fees, zero-payout redemption, historical reconciliation exhaustion and missing SELL/redemption bounds. These were fixed with focused regression coverage. Nested Codex reviews were skipped under the Codex host rule; this was not an independent outside-model audit.

Local evidence: `.nim/limitless-test-output.txt`, `.nim/limitless-forge-regression.txt`, `.nim/limitless-harness-verification.json`, `.nim/limitless-compiled-spec.json`, `.nim/deliver/prediction-public-evidence.json`, `.nim/limitless-deliver-verify.json`, `.nim/limitless-deliver-post.txt`.

## Remaining operating boundary

Example configuration keeps `enabled=false`, `live=false`, empty venue pins/market authority and zero live risk limits. No production token, signer, grant, allowance, order or funded redemption was created. Funded acceptance is NOT_RUN; profitability and Coinbase Wallet native-position parity are not established. Existing unrelated Solana changes are preserved.

Reusable learning proposal, pending owner approval: verify exact provider response and credential field names against real SDK transport, and require receipt-backed settlement independently of optional execution flags. This is evidence from this implementation, not an activated procedure or project rule.

Follow-up on 7 November: public-data paper acceptance found and corrected REST orderbook double scaling and misuse of the LP-reward `minSize` as a trade minimum. The current suite has 11 tests; see `reports/2026-11-07/limitless-public-paper-acceptance.md`. The original 6 November fixture results above remain historical evidence, not proof that the earlier book normalization was correct.
