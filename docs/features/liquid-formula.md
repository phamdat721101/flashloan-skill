# Liquidity formula upgrade

Status: approved implementation plan; local analytics implemented; production admission pending.

## Client outcome

Capture/inspect liquidity and calculate conditional forward state and an exactly quoted flash-loan size with explicit state provenance, coverage and bounded work. The full production trading outcome remains pending the admission gates below.

## Audience

Quantitative developers and operators of the existing Arbitrum/Sui liquidity runtime.

## Scope

The authoritative detailed spec is ../liquid-formula.md. Implemented modules cover V2 projection/inverse, V3/static no-hook ERC20 V4 wrappers, Cetus X64 math, bounded sizing and both-direction selection, common-head Arbitrum capture, worker/CLI, schema examples, independent SDK verification, unsigned Arbitrum Morpho/Balancer route compilation and candidate handoff. Additional implemented profiles cover Algebra linked ticks/execution callbacks, rollback-only V4 hook simulation, Cetus BCS/table decoding and checkpoint streams, unsigned Cetus Sui PTBs, DeepBook input-fee order-book quotes and conditional sizing. Production admission requires reviewed deployments and live proofs; arbitrary hooks, DEEP-funded fees and universal venue compilation are unsupported.

## Non-goals

Cross-chain atomic borrowing, guaranteed predictions/ordering/profit, claiming a sampled global optimum, automatic subscriptions, Stylus/io_uring rewrites and mutation of signed bytes.

## Alternatives considered

Rust-only production, generic V3 reuse for Sui/Algebra, derivative-only optimization and direct synchronous searches. These conflict with the selected implementation or protocol semantics.

## Selected approach and why

TypeScript bigint production math reuses existing state/execution boundaries; Rust remains independent reference/replay. Separate X64/Q96 rules and immutable v4 artifacts preserve correctness. Worker threads bound CPU/heap. Exact samples and truthful optimality labels replace unverifiable optimization claims. Existing v3 interfaces remain compatible; new Algebra callback and V4 quoter contracts require reviewed deployment pins.

## Risks

Input digests and caller assertions do not authenticate chain state or fee/coverage evidence. Source/provider retention, dynamic hooks and object versions require independent admission. Existing public RPCs can rate-limit; tick reads are concurrency-bounded. No production transaction has been sent for this upgrade.

## Acceptance criteria

Local: schema and CLI fixtures, inverse thresholds/ceilings, all directions/decimals, rounding/dust, signed crossing, horizon rejection, idempotent replay across classification, deterministic sizing, exhaustive small domains, cancellation, common-head/code/fee/state checks and tamper-proof candidate handoff. Full: independent protocol math and all five existing E2E seams plus per-combination low-notional live receipt proving debt, treasury profit and gas.

## Rollout and rollback

Use wallet-free analysis first, then shadow integration and per-adapter admission. Preserve simulation, deployment, lease, custody and risk gates. Revoke eligibility on gaps, changed revisions/fees and unknown effects. The global liquid-pattern map remains Draft until full proofs pass.

## Environment contract

Local math and preparation are network-free and secret-free. This implementation is verified with recorded fixtures and loopback RPC tests; public RPC/fork tests remain opt-in and were not run during completion. Capture requires reviewed HTTPS or local fixture endpoints. Private keys/passwords stay in existing signer boundaries, never JSON or logs. A development-only Ajv validator is pinned. The already-installed @noble/hashes 1.8.0 is now an explicit runtime dependency for canonical Sui object digests. Published examples, schemas and compiled worker code remain in the existing npm distribution.

## Post-delivery evidence

Local command/SDK/benchmark output and source hashes are scoped to analytics, not production acceptance. The external Cetus reference is pinned to SDK5.1.8 and kept outside project/runtime dependencies; 79 generated fixtures reproduce representative cases offline. Production needs corrected deployment/code pins, public operator/treasury configuration, explicit borrow/gas-loss budgets, complete decoder/compiler admission and authoritative canary receipts.
