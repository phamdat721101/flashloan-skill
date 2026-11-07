# Limitless public-data paper acceptance — 7 November 2026

The continuation found and fixed an orderbook-unit bug that the initial fixtures missed. After correction, all 11 prediction tests passed and the existing runtime completed a 14-step lifecycle using current public Limitless data. No authenticated API request, provider write or funded trade occurred.

## What changed

Limitless returns orderbook level `size` in raw six-decimal token units. For example, 150000000 means 150 shares. Price remains a decimal: 0.74 means 740000 ppm. The earlier adapter multiplied size by 1e6 again, overstating depth and thresholds. The initial test fixture supplied human-readable sizes and therefore reproduced the wrong assumption.

The API's `minSize` has a different purpose: LP rewards and adjusted-midpoint filtering. It does not establish a minimum trade size. The earlier preparation gate incorrectly rejected trades below it. Both meanings are explicitly documented in the [official orderbook contract](https://docs.limitless.exchange/api-reference/trading/orderbook).

The adapter now preserves integer size values as raw strings, rejects unsafe JSON numbers and quantities outside uint256, and exposes the internal threshold as `minRewardSharesRaw`. Only prices are converted from decimals. Preparation retains schema, SDK amount-alignment, price, authority and risk checks while removing the reward-threshold admission gate. YES/NO complementary books retain identical quantities.

Fixture orderbooks now use raw API units and a 100-share reward threshold. The regression test verifies numeric/string quantities, exact strings above JavaScript's safe-integer range, rejection of fractional/negative/unsafe/overflow values, NO-book conversion and a one-share visible partial fill below that reward threshold. The fill consumes exactly 400000 raw USDC at price 0.40, so a raw-depth inflation cannot pass unnoticed.

## Public-data acceptance

The run used the production transport with an isolated paper configuration and 100 virtual USDC. It selected a currently listed DOGE hourly binary market with collateral fees solely to exercise a two-sided book. This is a test selection, not a market recommendation.

The adapter was instrumented to allow only unauthenticated public GET requests. Signing, submission, cancellation, transaction preparation and broadcast adapter methods were blocked. Paper cancellation changed only the isolated local journal.

| Check | Result |
| --- | --- |
| Public doctor and market discovery | Passed; Base chain8453 |
| Prepare and execute hypothetical BUY | Passed |
| New runtime instance reading existing positions | Passed |
| Prepare and execute hypothetical SELL | Passed |
| Resting post-only GTC and cancellation | Passed |
| Reconcile and positions | Passed |
| Halt and paper resume | Passed |
| Lifecycle commands | 14 passed |
| Public REST requests | 22 |
| Authenticated requests / provider writes | 0 / 0 |
| Virtual starting cash | 100 USDC |
| Hypothetical realized PnL | **-0.987090 USDC** |
| Funded acceptance | **NOT_RUN** |

The round trip lost virtual money after spread and fees. It proves the execution/accounting path can operate on actual public response shapes; it does not demonstrate a forecasting edge or profitable strategy. Visible-book simulation does not establish real fills, queue position or latency. The provider does not guarantee upstream orderbook snapshot freshness; the local observation time alone cannot prove it.

## Verification and changed state

Production changes are limited to the prediction book parser and removal of the incorrect preparation gate. The existing fixture/test file, skill reference, feature brief/map and verified dependency specification were updated. The public request/result schemas and schema digest did not change. Existing example configuration remains disabled with zero live authority. Unrelated Solana work was preserved.

The final targeted build and all 11 prediction tests passed. A fresh Gstack adversarial follow-up reported no blocking issues in the narrow fix. The strict nim harness verified the public paper evidence, regression output, schema pin and seven source-resolved spec dependencies. The current compiled feature spec is SPEC-2026-110701. The repository regression suite and Solidity tests passed during the preceding implementation; this continuation reran the affected prediction suite and delivery checks.

Evidence is stored locally under `.nim/prediction-paper-20261107/`: `orderbook-doc.txt`, `raw-orderbook.json`, `public-requests.json`, `steps.json`, `positions.json`, `evidence.json`, `tests.txt`, `compiled-spec.json`, `harness-verification.json`, `delivery-evidence.json` and `delivery-post.txt`. These are distinct from funded execution evidence. The local `acceptance.mjs` is an explicit guarded host adapter; its paper configuration and ledger are isolated from the example configuration.

Reusable learning proposal, pending owner approval: use source-shaped fixtures and verify units and economic meaning independently. A field named `minSize` may express reward eligibility rather than trade admission. Check real public books in a bounded paper lifecycle before promoting an integration beyond fixture acceptance. This remains a provisional learning, not an activated procedure or project rule.

The remaining live operating dependencies are unchanged: reviewed production venue/code pins, a dedicated eligible account and signer, independent approval keys/grants, explicit budgets and separately authorized funded acceptance.
