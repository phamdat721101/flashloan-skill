# Base and Robinhood flashloan execution

Status: Approved design; code and deployment implemented; live profitable acceptance incomplete.

## Client outcome

Extend the existing pipeline to Base 8453 and Robinhood 4663, deploy every eligible executor revision, and require one finalized real profitable route on each chain. Preserve Arbitrum/Sui behavior and exact-latest-head matching.

## Design rationale

One EVM registry binds network identity, RPC configuration, wrapped-native assets and fee models. Chain-local signer locks and canonical budget ledgers are independent of report paths. The historical Arbitrum multi-split bytecode is excluded; the portable revision shares authenticated swap execution with MultiVenueArbitrageExecutor.

Inputs are public protocol manifests, pinned pool state and price feeds, artifact-bound capability evidence, and an explicit local signer binding. Outputs are route proposals, deployment/readback records, durable decisions, receipts and fixed-point accounting. Secrets and signed bytes never enter public inputs or reports.

## Environment contract

- Node >=20, Rust toolchain from rust-toolchain.toml, Foundry/solc 0.8.26.
- BASE_RPC_URL / ROBINHOOD_RPC_URL override public read RPCs. Optional chain-specific *_SUBMISSION_URL selects a direct submission endpoint.
- OPERATOR_PRIVATE_KEY is read only from the explicitly selected local environment file; the approved source is ~/.flashloan-agent/flashloan-skill/.env.
- HTTPS and hostname verification remain enabled. HTTP is permitted only for localhost test RPCs.
- Chain-specific state is local under .nim; public manifests and deployment proofs contain no credentials.

## Interfaces and behavior

`npm run evm -- profiles` lists supported profiles. `deploy --manifest config/base-mainnet.json --env-file <local-file>` deploys/configures and resumes the canonical signer/chain deployment ledger. `deployment-status --manifest ...` independently checks artifact bytecode, owner, all receipts and finality. `discover --manifest ... --from-block N --to-block M` reports bounded V4 discovery, not whole-market coverage.

`acceptance --config <public-config> --env-file <local-file>` captures complete pinned snapshots, sizes circular routes and simulates exact payloads. Every new head invalidates the candidate. `acceptance-reconcile` checks pending receipts without signing or resending. `recover-lock --chain ID --env-file <local-file>` removes a signing lock only after proving its recorded process is dead; live/inaccessible/invalid owners are rejected.

Budgets are cumulative per chain and signer: deployment/configuration 0.01 ETH; trading gas 0.002 ETH; at most three submitted trade attempts; flash principal <=100,000 USD; at most 24 hours; realized profit >=10 USD after debt, venue and network costs. Deployment expense is reported separately. Unsupported or stale price evidence, depegs, insufficient balances, unknown receipts and changed revisions block execution.

Base includes L1 publication fees separately. Robinhood/Nitro estimates bundle data costs; do not add them again. Amounts are integer strings, USD prices use E8, and receipt costs come from RPC evidence. WETH, Base USDC and Robinhood USDG are the initial profit assets. Historical generic V4 calldata is distinct from the authenticated V4-route ABI.

## System Map

Public chain/profile + artifact + root manifest -> pinned source state -> exact integer sizing -> ABI-bound payload -> final head/simulation/fee checks -> durable nonce/budget intent -> local signing -> submission -> canonical receipt and finality -> repayment/custody and net profit.

## Threat model and edge proofs

EDGE-01 rejects malformed configuration and cross-chain identities. EDGE-02 verifies artifact ABI widths and integer route math. EDGE-03 rejects untrusted roots, code drift, owner mismatch and stale evidence. EDGE-04 proves exclusive nonce/budget leases, cancellation and restart recovery. EDGE-05 requires complete actual fee/profit evidence or durable halt.

Local mock proofs do not establish production liquidity or profitable execution. Real lender fork proofs demonstrate borrow/callback/repayment. Target executor fork proofs additionally run real V4 swaps, require rejection specifically at the unfunded-profit check, and prove rollback; the quoter proves state does not persist. Mainnet completion requires deployment readback and finalized profitable receipts on both chains.

## Verification commands

- npm run typecheck
- npm test
- npm run evm:test
- npm run evm:abi-check
- forge test --summary
- EVM_FORK_REQUIRED=true forge test --fork-url <target-rpc> --match-contract EvmRealLenderForkProof -vv
- node scripts/evm-local-e2e.mjs (requires documented local Anvil rehearsal)
- nim-skill deliver verify --map docs/features/evm-flashloan-map.md --json

## Acceptance criteria

Every configured executor must match its compiled artifact and owner, all protocol root mappings, and successful canonical receipts. Deployment verification and trading admission are separate. Required fork tests must explicitly fail without an intended target chain. Repeated invocation must not redeploy, resend unknown transactions or reset spending caps. No profitable opportunity leaves live acceptance incomplete rather than lowering the floor.

## Audience

The wallet owner and implementers operating the existing flashloan agent.

## Scope

Shared EVM capture, sizing, signing, deployment, discovery and receipt accounting
for Base and Robinhood, including the portable split revision and bounded acceptance.

## Non-goals

Cross-chain atomic loans, native ETH V4 legs, hook-enabled pools, MEV privacy,
or guaranteed market profit are outside this revision.

## Alternatives considered

Copying Arbitrum constants would preserve the wrong roots and identities. Separate
chain engines would duplicate critical signing and recovery logic. A bounded-age
head policy was considered; the owner selected exact latest-head matching.

## Selected approach and why

Use explicit EVM profiles and one authenticated adapter with chain-specific fee
models. Persist canonical signer budgets independently of report paths to prevent
restart resets. Separate deployment verification from trading admission.

## Risks

Exact-head matching can reject every opportunity on fast chains. Public submission
can be copied or reordered. Initialized pools can have zero or insufficient liquidity.
Proxy code pins do not authenticate future implementation upgrades. Live profitable finalized receipts remain required acceptance evidence.

## Rollout and rollback

Deploy artifact-matching executors, verify roots/ownership/receipts, then admit only
reviewed proof artifacts. Halt the runner to stop new submissions; reconcile saved
hashes first. Revoke root/lender configuration through owner transactions after
review when necessary. Deployed immutable bytecode cannot be rolled back.

## Post-delivery evidence

Local Node/Rust/Foundry results, live lender-only fork proof, deployment receipts and
root verification records are distinct evidence classes. Mainnet profitable receipt
acceptance remains incomplete until canonical finalized net profit passes the floor.

## Current deployment and validation

Public records: [Base executors](../deployments/base-executors.json) and
[Robinhood executors](../deployments/robinhood-executors.json). Base deployed four
contracts for 0.000069975982625293 ETH; Robinhood deployed three for
0.000192990300588 ETH. Costs include configuration and actual network fees.
All seven deployment/configuration sequences are finalized; finality is recorded separately from runtime/configuration verification.

The focused EVM suite passes 18 tests; the full suite passed 182 Node tests with
four explicit skips before the additional discovery boundary regression, plus
Rust workspace tests. Base real-protocol fork tests pass five; Robinhood passes
four with the excluded Aave variant explicitly skipped. No fork broadcasts occur.
The bounded live market probe sampled six pool pairs in both directions on each
chain and found no selected route. Coverage exhaustion is a rejection, not evidence
that the entire market is unprofitable. No live trading transaction was submitted.

## Data contract details

- Deployment inputs use `schemas/evm-deployment-manifest.schema.json`. Runtime
  receipts and readback hashes are recorded in the public deployment JSON.
- Acceptance inputs use `schemas/evm-acceptance-config.schema.json`; pool entries
  must also satisfy the existing analytics source and pool-state validators.
- Admission uses `schemas/evm-admission-evidence.schema.json`. Each proof reference
  names a real JSON file and SHA-256. Its body must include `schemaVersion: "1.0"`,
  matching `kind`, `chainId`, `executorCodeHash`, `artifactHash`, `capability`,
  `success: true`, a source description and `verifiedAtMs`; simulation/canary
  additionally bind a nonzero canonical `blockHash`. The owner supplies reviewed
  artifacts from explicit verification adapters. Proof text is never executed.
- Acceptance receipt entries use `schemas/evm-execution-receipt.schema.json`.
  `netProfitUsdE8`, `gasWei`, `blockNumber` and all token amounts are decimal strings.
  Net USD is realized profit after debt minus actual gas valued at the receipt block;
  executor-retained profit counts as custody, not a treasury transfer.

Remaining: review exact-route production admission artifacts, obtain a route above
the approved floor, submit under exact-head and shared budget checks, and reconcile
one finalized profitable receipt per chain. The System Map stays Draft while this
client acceptance condition is unmet; local EDGE proofs alone do not mark it Done.


Gstack targeted security, maintainability and testing reviews found and drove fixes
for proof-reference validation, receipt-block valuation pins, restart transitions,
head invalidation, strict numeric identities and schema coverage. Final targeted
security review found no further concrete blocker; this is a code review result,
not profitable live-route acceptance. No separate external model review is claimed.
