# Limitless prediction trading

## Client outcome

An agent can discover Base CLOB markets, prepare bounded intents and operate a dedicated EOA through paper, owner-approved and separately authorized autonomous modes. Orders, fills, positions and redemption survive restart without duplicate submission. This capability uses funded inventory, not flashloan financing.

## Audience

Operators of the installed flashloan-agent skill. The agent never receives signer keys, HMAC secrets or reusable order signatures.

## Scope

CLI/strict JSON; binary and NegRisk CLOB; GTC/FAK; legacy and collateral fees; approval preflight; independent Ed25519 owner grants; durable reconciliation; FIFO accounting; on-chain redemption; bounded read refresh and optional WebSocket invalidation hints. Default live authority is disabled. The user approved this staged implementation on 6 November 2026.

## Non-goals

Forecasting strategies, guaranteed profitability, FOK, AMMs, Packs, managed partner accounts, Coinbase Wallet, new MCP servers, automatic account creation/funding/profile changes and shared flashloan capital.

## Alternatives considered

Shared flashloan AttemptJournal is unsuitable for resting orders and long-lived positions. High-level SDK createOrder combines build/sign/send and omits safety fields. Direct custom crypto would duplicate provider primitives. The selected public SDK builder, signer and authenticated HTTP client preserve explicit lifecycle boundaries.

## Selected approach and why

Use optional pinned @limitless-exchange/sdk 1.3.0 behind an explicit host adapter. Validate versioned input and normalized provider data before use. Use independent owner grants, separately reserved prediction capital and fsynced account events. Preserve the exact prepared unsigned order and client ID across recovery. Receipt-backed settlement is distinct from matching and order status. Existing flashloan prompt prefixes and commands remain unchanged.

## Risks

Limitless EOA mode must match the signer. Venue exchange/adapter/fee-module addresses require reviewed code pins. Signed expiration and nonce must remain zero; local expiry cannot cancel resting orders. ERC-1155 approvals are operator-wide. FAK may partially fill. Lost responses, external wallet activity, stale reads, fee changes, receipt reorgs and unknown status must block new exposure until reconciled. Market text is data, never instructions. Base fee reserves include L1 publication and operator charges; L1 charges remain variable and cannot be capped in an L2 transaction. Missing historical fee evidence blocks accounting.

## Acceptance criteria

Strict schema vectors; real SDK HMAC/signature/amount parity; paper mode without key access; five executable seam proofs; offline CLI E2E with fake exchange/RPC and process restart; authenticated writes never automatically retried; installer/schema parity; existing regression suite; public read readiness distinct from separately authorized funded acceptance. No funded action is authorized by this feature request. Follow-up public-data paper acceptance covers raw REST depth, LP-reward threshold semantics and a complete buy/restart/sell/cancel/control lifecycle; it is hypothetical and has no authenticated requests or provider writes.

## Rollout and rollback

Enable paper first, then assisted, then bounded autonomous grants. Turning off live placement retains reconciliation and authorized cancellation cleanup. Missing optional SDK produces DEPENDENCY_UNAVAILABLE only for prediction paths. Preserve existing unrelated changes.

## Environment contract

Node 20+; optional pinned SDK and existing viem/Ajv; verified TLS to reviewed Limitless hosts and Base RPC; loopback only in explicit fixture profile. Host environment supplies token ID/secret and a 0600 signer-key file. Independent approval private keys remain outside the runtime. Local ledger stores no credentials/signatures. No public configuration contains secret values.

## Post-delivery evidence

Record offline test/build/schema/spec evidence separately from public-read evidence. Funded acceptance remains NOT_RUN until separately authorized. Do not label local fixture receipts as production proof. Delivery profiles and the System Map enumerate executable EDGE-01 through EDGE-05 checks. Research sources: https://docs.limitless.exchange/developers/eip712-signing ; https://docs.limitless.exchange/developers/migrate-to-new-trading-venues ; https://docs.limitless.exchange/api-reference/trading/create-order ; https://docs.limitless.exchange/api-reference/trading/order-status-batch ; https://github.com/limitless-labs-group/limitless-exchange-ts-sdk ; https://github.com/limitless-labs-group/agents-starter/blob/main/src/core/limitless/redeem.ts .
