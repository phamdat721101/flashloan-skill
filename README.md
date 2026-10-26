# Flashloan Agent Skill

Install a prompt-driven Arbitrum, Base, Robinhood and Sui flashloan skill for Codex agents. Its Rust/Alloy live-state engine is source-built and deliberately wallet-free until a reviewed executor capability and private relay are configured.

## Install

```sh
npm install
npm run build
cargo build --locked --release -p flashloan-daemon
node dist/agent-cli.js install
```

Restart the agent session, then use:

```text
Use $flashloan-agent to scan Aave, Morpho, Balancer, and Uniswap v4 using my scanner configuration without exposing secrets.
```

For a configured executor, private relay, and dedicated wallet, ask the agent to simulate or autonomously execute a schema-valid opportunity file. The runtime verifies chain, executor bytecode, owner signer, capability selector, proposal freshness, private relay, and final simulation before broadcast; it persists realized P&L and halts if P&L cannot be valued.

For the liquid-pattern workflow, start with [capture, size and prepare](#use-a-liquid-pattern-to-prepare-a-flashloan), then add [Level 2 agent context](#level-2-market-context-for-agents). Current public contracts are listed in [deployment addresses](#recorded-deployment-addresses).

## Latest upgrade and how to use it

The latest recorded Base executor is **AeroSplitFlashExecutorV2**, deployed on
2026-10-24. The 2026-10-26 **evidence-driven v5 upgrade is an implementation
specification**, with executable offline checks. It does not deploy a new
contract or add the proposed `evidence-run` command.

| Item | Published reference |
| --- | --- |
| Network | Base mainnet, chain ID `8453` |
| V2 executor | [`0x63bdcea3ce513317b5b8694978908a1e3d3a4e87`](https://basescan.org/address/0x63bdcea3ce513317b5b8694978908a1e3d3a4e87) |
| Deployment transaction | [`0x35e798309c80e5c26f5870d829bece86b74b6f9aaf1c6c5e611abe6cdbe22951`](https://basescan.org/tx/0x35e798309c80e5c26f5870d829bece86b74b6f9aaf1c6c5e611abe6cdbe22951), block `53029413` |
| Runtime code hash | `0x35c84dac168a1fa190940fac287d2d544bda45afdc3132d8daad2ce0eff721d1` |
| Selector | `0xc7c01977`; use the [V2 artifact binding](config/aero-base-executor-v2.json) |
| Deployment/configuration evidence | [Base Aero v2 record](docs/deployments/base-aero-v2-20261024.json), including 28 configured roots and `liveTradingAdmitted: false` |

[Read-only verification on 2026-10-26](docs/deployments/base-aero-v2-readback-20261026.json)
matched the runtime code hash and owner at Base block `53121789` and confirmed
the successful deployment receipt. Configuration roots were not re-read in
that check; their evidence remains the dated deployment record.

Update an existing checkout on `aero-v2-routing`, then build and verify the
specification without a wallet or RPC:

```sh
git pull --ff-only origin aero-v2-routing
npm ci
forge build
npm run build
npm run evidence:spec
```

`evidence:spec` verifies all five specification edges, corrected v5 record
examples, source/dependency hashes, exact ledger/hurdle arithmetic and the
R01–R16/T01–T42 implementation map. It also reproduces the known legacy sizing
budget defect under a finite host guard. Passing this command verifies the
specification package; the sizing fix and runtime acceptance tests remain pending.

For the deployed V2 workflow, capture the configured pools without signing:

```sh
npm run aero -- capture \
  --registry config/aero-v2-base-pools.json \
  --output .nim/aero-v2-snapshot.json
```

Capture uses `BASE_RPC_URL` when configured and otherwise the public Base RPC.
Use the [V2 operating workflow](#aero-v2-aerodrome--uniswap-routing-with-live-sends)
for its separate fork rehearsal and explicitly authorized send path. Match V2
requests (`aero-split/1.1`) to the V2 artifact; the proposed evidence `5.0`
records are a separate contract. Deployment and local simulation do not establish
a profitable live trade or authorize one.

For implementing the evidence upgrade, read the [original PRD](docs/PRD-flashloan-evidence-driven-execution-upgrade-2026-10-26.md),
[implementation companion](docs/features/flashloan-evidence-driven-execution.md),
[corrected v5 schema](schemas/flashloan-evidence-v5.schema.json), and
[requirement/test manifest](docs/features/flashloan-evidence-driven-execution.spec.json).
The [delivery maps](docs/features/flashloan-evidence-driven-execution-map.md)
separate completed specification verification from Draft runtime work. The
companion defines policy, canonical state, bounded exact search, native proof,
receipt accounting and cited knowledge, with full local trading E2E and per-lane
fork/canary gates required before runtime completion.

## Base and Robinhood execution

The shared EVM pipeline supports Base (8453) and Robinhood (4663), with separate
chain/signer budgets, artifact-verified deployment, exact-head simulation and
durable receipt recovery. See [the implementation and operating contract](docs/features/evm-flashloan.md)
for schemas, approved limits, exclusions and current live acceptance status.
Install Foundry as well as Node and Rust; `npm test` builds Solidity artifacts
before checking ABI parity. Run `npm run evm:test` for focused EVM coverage.

```sh
npm run build
node dist/evm/cli.js profiles
node dist/evm/cli.js deployment-status --manifest config/base-mainnet.json --state .nim/deployments/base.json
node dist/evm/cli.js deployment-status --manifest config/robinhood-mainnet.json --state .nim/deployments/robinhood.json
```

Deployment requires an explicit local `--env-file` holding `OPERATOR_PRIVATE_KEY`;
it never sources that file as shell code. Public submission is supported under
the approved policy. A verified deployment alone does not admit a live trade.
Use the matching manifest and RPC variable (`BASE_RPC_URL` or
`ROBINHOOD_RPC_URL`) for discovery, deployment-status, and acceptance. The
skill reads pinned V4 state, sizes a bounded two-to-six-hop return cycle, and
only signs after fresh exact-head simulation, artifact-bound proof evidence,
and the per-chain/signer budget checks pass.

## Aerodrome split routing on Base

The Base deployment now includes a separate, owner-gated Aerodrome executor
for classic volatile/stable pools and three pinned Slipstream generations. It
captures a single block, applies integer quote math, searches split allocations,
simulates the complete flashloan, and binds calldata to the executor artifact
and verified pool/factory implementations.

The deployed contract is
[`0xdfafd892dca6a2f9dadc43a38b81c7d53473ff10`](https://basescan.org/address/0xdfafd892dca6a2f9dadc43a38b81c7d53473ff10).
It has Morpho, four Aerodrome factories, and five reviewed pool pins enabled.
Deployment does not authorize a live trade: every candidate still needs a fresh
snapshot, cost evidence, whole-loan simulation, and the existing owner/policy
admission checks.

Capture first, then assemble a request matching
[`aero-split-request.schema.json`](schemas/aero-split-request.schema.json):

```sh
npm run aero -- capture \
  --registry config/aero-base-pools.json \
  --output .nim/aero-snapshot.json

npm run aero -- plan \
  --request .nim/aero-request.json \
  --output .nim/aero-plan.json

npm run aero -- simulate \
  --request .nim/aero-request.json \
  --artifact config/aero-base-executor.json \
  --output .nim/aero-simulation.json
```

For a dynamic fee module, run simulation through an explicitly selected
localhost fork with `--evm-rpc http://127.0.0.1:8545`. Non-WETH settlement
requires fresh pinned price-feed evidence through `--valuation`. The `capture`,
`plan` and `simulate` commands never broadcast; the only send path is `aero run`
for the V2 executor (below).

Run the focused checks with `npm run aero:test` and `npm run aero:local-e2e`.
The [Aero implementation brief](docs/features/aero-split-routing.md),
[formula notes](docs/ratio.md), and
[deployment evidence](docs/deployments/base-aero-20261022.json) describe the
accepted profiles, limits, receipts, and fork proof. The fork’s counter-venue
is constructed, so it proves execution behavior rather than a live profit.

## Aero v2: Aerodrome + Uniswap routing with live sends

`AeroSplitFlashExecutorV2` is a new Base executor deployed at
[`0x63bdcea3ce513317b5b8694978908a1e3d3a4e87`](https://basescan.org/address/0x63bdcea3ce513317b5b8694978908a1e3d3a4e87).
The V1 executor above is unchanged. V2 changes how opportunities are scanned and traded:

| Area | V1 | V2 |
|---|---|---|
| Venues | Aerodrome classic and Slipstream | Also Uniswap V2 (on-chain output), V3 (100/500/3000/10000) and hookless static-fee V4 |
| Lenders | Morpho | Morpho, Balancer V2 (fee-capped), Uniswap V4 PoolManager (`unlock`/`take`/`settle`, zero fee) |
| Scan | Serial reads, exact-head freshness | Multicall3-batched concurrent capture; `bounds.maxBlockLag` admits a canonical snapshot up to 5 blocks old |
| Dynamic fees | One `debug_traceCall` per candidate on a local fork | Model search at the block fee, then `quoteAeroSplit` re-quotes the top K candidates on any RPC (it borrows, swaps and always reverts with the outputs) |
| Sizing | Sampled sizes | Optional golden-section refinement (`limits.refine`) |
| Trade | Simulate only | `aero run` sends through the shared runtime: final simulation at the head, priority-fee bid, receipt proof, halt on first revert |
| Gas | Each leg validated twice | Validated once before the loan |

Discover venues (read-only), then rehearse on a pinned fork, then trade:

```sh
npm run build && node scripts/aero-v2-manifest.mjs        # writes config/aero-v2-*.json
AERO_RUN_FORK=1 AERO_FORK_BLOCK=<n> node scripts/aero-v2-fork-e2e.mjs
BASE_SUBMISSION_URL=https://mainnet.base.org npm run aero -- run \
  --config config/aero-v2-live.json --env-file <owner env> --output .nim/aero-live/run.json
```

`aero run` requires an explicit `--env-file` signer and `BASE_SUBMISSION_URL`;
it never falls back to the read RPC. It stays inside the shared budget: three
trades and 0.002 ETH of gas per signer. After a reverted receipt it stops until
`--resume`. Only plans verified by the on-chain quoter can be sent.

Evidence:
- Pinned Base fork:
  - the real deploy flow configured all 28 roots;
  - 15 of 16 real pools matched the model to the wei;
  - the remaining pool, a dynamic-fee Slipstream pool, differed by 0.0175%. This is why quoter verification is required.
- Locally, a quoter-verified plan was signed and sent, with repayment and custody proven. A front-run revert was accounted as a gas loss.
- No liquid hookless WETH/USDC V4 pool exists on Base yet, so V4 is proven with a strict Foundry mock.

Limits:
- The first 27 live rounds found no profitable WETH/USDC cycle.
- On the public RPC each round takes about 55 seconds, longer than the freshness window. A low-latency `BASE_RPC_URL` is needed before natural opportunities can be sent.

Checks: `npm run aero:test`, `npm run aero:v2-local-e2e`,
`node scripts/verify-aero-implementation.mjs --feature v2 --deployment docs/deployments/base-aero-v2-20261024.json`.
Design and data contracts are in the [Aero v2 brief](docs/features/aero-v2-routing.md).

## Configuration

Copy `.env.example` to `.env`. Keep `OPERATOR_PRIVATE_KEY` only in your local environment; never put credentials in prompts, JSON input, or Git. Validate safely with:

```sh
node dist/cli.js validate-config
```

The runtime accepts exact executor-ready opportunities matching `schemas/opportunity.schema.json`. `FLASH_EXECUTOR_ADDRESS`, `PRIVATE_RELAY_URL`, and `OPERATOR_PRIVATE_KEY` are explicit local configuration; no executor address or secret is implied.

## Sui mainnet flashloan service

The Sui service has a deployed terminal-profit guard and two read-only mainnet
canaries. The guard is a final-custody invariant: it can receive a terminal
profit only after an atomic route has repaid its lender. It is not a lender,
DEX adapter, or permission to submit an arbitrage transaction.

The active guard package is
[`0x96859191011298474c3e9944d52237083ce2b5a7065797036543fb8be9ed0c81`](https://suiscan.xyz/mainnet/object/0x96859191011298474c3e9944d52237083ce2b5a7065797036543fb8be9ed0c81),
upgraded in transaction
[`2yi723GHkgiT3Tcg5JTkQZ7PrZPFjvKyuMwtUy9XboXp`](https://suiscan.xyz/mainnet/tx/2yi723GHkgiT3Tcg5JTkQZ7PrZPFjvKyuMwtUy9XboXp).
The retained `UpgradeCap`, `AdminCap`, `OperatorCap`, and `PauseCap` are documented in the
[Sui deployment record](docs/sui-flashloan/deployment.md); treat them as
operator-controlled objects, never configuration values to copy into a public
route request.

Start with public-only configuration. Copy `.env.example` to a local `.env`,
set `SUI_NETWORK=mainnet`, set
`SUI_RPC_URL=https://fullnode.mainnet.sui.io:443`, and add the reviewed public
DeepBook and Cetus canary pins. Do not put `SUI_OPERATOR_PRIVATE_KEY` in a
repository, prompt, receipt, or shell history. Validate the non-secret
deployment inputs and, if needed, confirm that the optional local signer
matches the configured public address:

```sh
npm run sui:validate-config
npm run sui:wallet-address
```

### Current mainnet guard workflow

Use the public identifiers from the [deployment record](docs/sui-flashloan/deployment.md)
in a local, untracked environment file. `SUI_GUARD_PACKAGE_ID` and
`SUI_GUARD_ACTIVE_PACKAGE_ID` must both be the active package above; the
`UpgradeCap`, `AdminCap`, `OperatorCap`, and `PauseCap` stay under operator
custody. Verify the configuration and the admission policy before enabling a
route compiler:

```sh
npm run sui:validate-config
npm run sui:validate-adapter-registry -- ./config/sui-adapters.example.json
```

For an incident stop, the `AdminCap` holder sets the `PauseCap` to paused. A
route PTB must use `assert_min_profit_and_transfer_with_pause`; a paused guard,
an unreviewed adapter revision, missing exact repayment, or insufficient
terminal profit reverts the entire transaction. This repository has no command
that sends a live flashloan trade yet—only the guard upgrade path can sign.

The two canaries below use the supported Sui gRPC transport. They never sign
or submit: the DeepBook command simulates borrow and exact repayment; the
Cetus command checks the admitted pool's package digest, object identity,
asset types, pause state, fee tier, and liquidity.

```sh
npm run sui:deepbook-flashloan-canary
npm run sui:cetus-pool-canary
```

Do not construct or submit a cross-venue route until fresh quotes, exact
minimum outputs, repayment amounts, and the admitted DeepBook package's
fee mode have been reviewed. Do not assume an operator-owned `DEEP` fee coin
is required: supported revisions can charge the swap input token when the
DEEP input is zero. The service currently fails closed before that
stage; it does not claim a live profitable flashloan execution. See
[`docs/sui-flashloan/`](docs/sui-flashloan/) for the route, schema, and E2E
requirements.

### Multi-lender route admission

The route registry now models NAVI, Suilend, Scallop, Cetus, and Turbos as
separate revision-pinned adapters. Validate a reviewed registry before any
future send path is enabled:

```sh
npm run sui:validate-adapter-registry -- ./config/sui-adapters.example.json
```

Only an owned SUI gas coin may be an external fungible PTB input. Each lender
and venue fee must be sourced from a borrowed or route-produced SUI/USDC coin;
registries that require an operator-owned fee token are rejected. `auto` mode
only authorizes a fully identified mainnet runtime. It does not enable an
unverified protocol package or bypass the per-route simulation and receipt
checks. The checked-in example is intentionally disabled and contains no live
package or pool identifiers.

## Recorded deployment addresses

Select an address by ABI, not by deployment recency. These records do not
authorize sending or establish liquidity-pattern production admission.

| Network / contract | Recorded address | Scope |
| --- | --- | --- |
| Arbitrum One / current liquidity executor | [`0xba4681b7cae1a67c703f43f1476b25fef2635b0a`](https://arbiscan.io/address/0xba4681b7cae1a67c703f43f1476b25fef2635b0a) | Corrected multi-lender/multi-venue ABI; trading admission required |
| Arbitrum One / current V4 state quoter | [`0x552d73e6b424b98a9d74fb335e62ee198d0601ad`](https://arbiscan.io/address/0x552d73e6b424b98a9d74fb335e62ee198d0601ad) | Rollback-only quotation; no flashloan execution |
| Arbitrum One / multi-split | `0xb1aac2079c52fd31e038ec348505a0f55859d60f` | Separate `executeMultiSplitPairArbitrage` ABI; not the repaired multi-lender ABI |
| Arbitrum One / historical multi-venue | `0xd130b45b7e7d08fb7dbb1c79fa5d9b95ea8e27b2` | V4 revoked; V2/V3 require their existing gates |
| Arbitrum One / historical V4-only | `0xfcd8f1257d8f37f4c51b4e6ac923137e5b6a2a16` | Execution revoked |
| Base 8453 / MultiVenueArbitrageExecutor | `0xa27873424e74037d93dcf05d3a40556d07c2cfa8` | Finalized; Morpho, V4 manager, and Aave provider configured |
| Base 8453 / PortableMultiSplitFlashExecutor | `0x0cd3a077aec94f51d32e8d55120cf90d5db7841c` | Finalized portable split executor; Morpho, V4 manager, and Aave provider configured |
| Base 8453 / V4StateQuoter | `0x84f9615db5a1c6ac87acb686a3cb3fcb44ec1825` | Finalized read-only V4 state quoter |
| Base 8453 / ImmutableArbitrageExecutor | `0x00cba652a1b4cf21063d443c5c1b0d495f477999` | Finalized immutable executor; V4 manager and Aave provider configured |
| Base 8453 / AeroSplitFlashExecutor | [`0xdfafd892dca6a2f9dadc43a38b81c7d53473ff10`](https://basescan.org/address/0xdfafd892dca6a2f9dadc43a38b81c7d53473ff10) | Aerodrome classic/Slipstream executor; Morpho, four factories, and five pools pinned; fresh admission required |
| Base 8453 / AeroSplitFlashExecutorV2 | [`0x63bdcea3ce513317b5b8694978908a1e3d3a4e87`](https://basescan.org/address/0x63bdcea3ce513317b5b8694978908a1e3d3a4e87) | Aerodrome + Uniswap V2/V3/V4 executor; Morpho, Balancer V2 and V4 lenders; 28 roots pinned; quoter-verified live sends |
| Robinhood 4663 / MultiVenueArbitrageExecutor | `0xa27873424e74037d93dcf05d3a40556d07c2cfa8` | Finalized; Morpho and V4 manager configured |
| Robinhood 4663 / PortableMultiSplitFlashExecutor | `0xba1bb00447cd75b941b14aecd09e37f9ab461e38` | Finalized portable split executor; Morpho and V4 manager configured |
| Robinhood 4663 / V4StateQuoter | `0x0caefeaa418d65ef03a19646d128ced8f3e4977f` | Finalized read-only V4 state quoter |
| Sui mainnet / active guard | `0x96859191011298474c3e9944d52237083ce2b5a7065797036543fb8be9ed0c81` | Terminal profit guard only; not a lender or route executor |

The Base and Robinhood addresses, deployment transactions, runtime hashes,
owner checks, and finality evidence are in the [Base record](docs/deployments/base-executors.json)
and [Robinhood record](docs/deployments/robinhood-executors.json). Robinhood has
no admitted Aave provider, so its immutable Aave executor is deliberately excluded.
The Aero artifact, root pins, receipts, and current finality observation are in
the [Base Aero record](docs/deployments/base-aero-20261022.json); V2 is in the
[Base Aero v2 record](docs/deployments/base-aero-v2-20261024.json).

The multi-split record references deployment transaction
[`0x0996…0f5ef`](https://arbiscan.io/tx/0x0996d0328a43ae3f23cb5d0297c76292d910f59a88a1276c928578a52010f5ef).
Its code was reread at Arbitrum block `514628150`, with runtime hash
`0xa3f091893cee71a89509cf51c1ef49828a5a1850e72b88691924c824c80dd81e`.
This is a code-identity observation, not verification of every capability or
of the recorded historical deployment receipt. The corrected liquidity executor and quoter are recorded in the
[deployment receipt record](docs/deployments/arbitrum-one-liquidity-upgrade.json).
Both deployment receipts succeeded and both runtime hashes matched public RPC
readback at Arbitrum block `514959818` on 2026-10-15. These are deployed addresses;
production strategy admission still requires fresh route evidence. Sui Move call targets use the active package, while guard type/event
origins retain the original package from the deployment record.

## Deployed Arbitrum multi-venue executor

The reviewed multi-venue executor is deployed on Arbitrum One at
`0xd130b45b7e7d08fb7dbb1c79fa5d9b95ea8e27b2` (deployment transaction
[`0x566b…d6568`](https://arbiscan.io/tx/0x566b9d729cefe4af9f11a2673f15ab7cee8ae8c9c449276890c49d41391d6568)).
`MULTI_VENUE_EXECUTOR_DEPLOYMENT` pins that address, its runtime hash
`0xb9e2738a3643a2b8dc566f475df658f610a9f6d587d5d2ebea072104a4fccbed`,
the Aave V3 provider, and the V2, V3, and V4 roots. Its V4 configuration
explicitly disallows hooks. The deployed owner is the configured operator
wallet; no private key is stored in this repository.

V4 execution on this immutable deployment is revoked: its deployed bytecode
retains the reversed BalanceDelta decoder. Plan validation rejects V4 legs
on this address and rejects the recorded V4-only executor. V2/V3 multi-venue
routes remain subject to the existing gates. Do not treat deployment/root
proofs as admission of the broken V4 path.

The state-adapter layer reads block-pinned V3, Algebra Integral, and no-hook
V4 pool state for simulation. It verifies code hashes and rereads the pinned
head to reject reorged data. V3 and V4 have read-only Arbitrum fork coverage;
Algebra remains admission-gated until a production pool and exact expected
code hash are configured. These adapters produce observations only: they do
not sign or broadcast transactions.

The executor deployment and its root pins are proven read-only with:

```sh
forge test --fork-url "$ARBITRUM_RPC_URL" \
  --match-contract MultiVenueArbitrageExecutorArbitrumForkProof -vv
E2E_ARBITRUM_RPC_URL="$ARBITRUM_RPC_URL" npm test
```

This is deployment and simulation evidence, not a claim of a completed
profitable flash-loan trade. A live execution remains gated on a
schema-valid, profitable route, final relay simulation, a fresh estimate, and
the existing execution risk checks. Start in private-relay canary mode with
the configured executor address in local `FLASH_EXECUTOR_ADDRESS`; do not
send a public-mempool canary.

## Liquidity-pattern foundation

### How flashloans use a liquidity pattern

A liquidity pattern is a validated, versioned view of pool state, not a signal
to borrow automatically. Ingest pinned observations, construct a complete
protocol snapshot, quote circular routes in integer token units, and simulate
the exact transaction. Within one atomic transaction, borrow, swap, repay the
principal plus the lender's actual fee, and prove remaining profit custody.
Failure to repay or meet minimum output/profit bounds reverts the route;
transaction gas can still be lost.

The liquidity upgrade is deployed on Arbitrum One: executor
`0xba4681b7cae1a67c703f43f1476b25fef2635b0a` and V4 state quoter
`0x552d73e6b424b98a9d74fb335e62ee198d0601ad`. Both runtime artifacts,
owner and Aave/V2/V3/V4/Morpho/Balancer pins passed on-chain readback.
`LIQUIDITY_UPGRADE_DEPLOYMENT` exports the public addresses and code hashes;
historical revoked deployments remain separate. Deployment does not grant trading
admission. V4 hooks and unverified Algebra factories remain disabled.

Start without a wallet:

```sh
npm install
npm run build
npm run liquidity -- sources
npm run liquidity:test
```

The v4 analytics commands run without a wallet:

```sh
npm run liquidity -- project schemas/examples/liquidity-project-v4.json
npm run liquidity -- size schemas/examples/liquidity-sizing-v4.json
npm run liquidity -- compare schemas/examples/liquidity-sizing-v4.json
npm run liquidity -- prepare-arbitrum schemas/examples/liquidity-prepare-v4.json
npm run liquidity:benchmark
```

The examples use synthetic, unadmitted pools. `project` returns exact native
output, rational price and a separately labelled projected state; `size` reports
the best exactly quoted amount found within at most 512 evaluations. It reports
`certified` only when every quantum in the declared domain was evaluated.
`inspect` exposes actual V2 reserves or CLMM virtual liquidity/covered ranges;
`target-price` finds the smallest V2 input reaching a raw price fraction.
`compare` evaluates both circular directions, at most 512 quotes per direction.
`prepare-arbitrum` produces unsigned Morpho/Balancer calldata and a bound runtime
candidate for V2/V3/static V4, including exact leg output floors and covered price
limits. It uses no RPC or wallet; adapter admission and fresh simulation remain
mandatory before execution. The example deliberately has expired fixture timestamps.
Inputs/results follow [the v4 JSON Schema](schemas/liquidity-analytics.schema.json).
Existing v3 source/runtime contracts remain compatible.

### Use a liquid pattern to prepare a flashloan

A liquid pattern is a conditional change to a pool's reserves, tick liquidity or
price range. Project that change to screen a circular route, then prepare execution
from a fresh canonical snapshot. Projected state is not executable evidence, and
already-executed feed events must not be applied twice.

1. Capture the pools at one block with `snapshot-analytics-arbitrum`. Its v4 source
   configuration supplies `rpcUrl`, `sourceId`, `cursor`, and `pools`; each pool
   pins `address`, `expectedCodeHash`, `adapterRevision`, and its protocol-specific
   fee or tick coverage. Keep the returned `{snapshot,pools}` together.
2. Use `project` to inspect a hypothetical swap and its resulting price/range.
   Use `compare` on canonical pools to size both circular directions. Supply the
   borrow asset, 2–6 route legs, amount bounds/quantum, lender liquidity, actual
   lender fee, conservative gas/cost evidence, and minimum net profit in native units.
3. Assemble a prepare input using the checked-in fixture's structure:
   `{schemaVersion:"4.0",pools,request,snapshot,binding}`. Match
   `request.snapshotDigest` to `snapshot.stateDigest`. The binding supplies the
   real lender, verified roots/revisions, adapter identity, fresh deadline/expiry,
   and gas ceiling. `deadline * 1000` must not exceed `expiresAtMs`.
4. Run `prepare-arbitrum`. Read `comparison`, `unsignedPayload` and `candidate`.
   A null payload/candidate means no eligible trade was selected. Successful
   preparation includes exact swap output floors and a repayment/profit guard.
5. Pass the exact payload/candidate to the execution adapter and durable runtime.
   Begin in `shadow` mode. Live execution requires admitted evidence, a fresh
   executor-context simulation, signer/resource custody and explicit loss budgets.

These commands demonstrate the offline flow; the fixtures contain synthetic pools
and expired timestamps, so they cannot be used for live execution:

```sh
node dist/liquidity/cli.js project schemas/examples/liquidity-project-v4.json
node dist/liquidity/cli.js compare schemas/examples/liquidity-sizing-v4.json
node dist/liquidity/cli.js prepare-arbitrum schemas/examples/liquidity-prepare-v4.json
```

For real capture and preparation, provide reviewed source pins and freshly assembled
inputs instead of the fixtures:

```sh
node dist/liquidity/cli.js snapshot-analytics-arbitrum ./capture-config.json > ./captured-state.json
node dist/liquidity/cli.js prepare-arbitrum ./fresh-prepare-input.json > ./prepared-trade.json
```

The deployed lender pins are Morpho Blue
`0x6c247b1F6182318877311737BaC0844bAa518F5e` and Balancer V2
`0xBA12222222228d8Ba445958a75a0704d566BF2C8`. Morpho preparation requires
a zero flashloan fee; Balancer preparation requires the current verified fee.
`ArbitrumLiquidityExecutionAdapter` currently accounts gas/profit in WETH, so
its circular route must start and finish in WETH. A quoted gross profit must
cover exact debt, conservative gas/costs and the configured net profit floor.

An application can bind the prepared payload to the deployed executor as follows.
`admission`, `operatorAccount`, endpoints, policy and pool code pins are supplied
by the reviewed operator integration; no signer or admission is fabricated here:

```js
import { LIQUIDITY_UPGRADE_DEPLOYMENT as deployment } from './dist/contracts/flash-executor.js';
import { prepareArbitrumTrade } from './dist/liquidity/arbitrum.js';
import { ArbitrumLiquidityExecutionAdapter } from './dist/liquidity/arbitrum-execution.js';
import { SnapshotStore } from './dist/liquidity/state.js';
import { AttemptJournal } from './dist/liquidity/journal.js';
import { LiquidityRuntime } from './dist/liquidity/runtime.js';

export async function simulateLiquidPattern(input, admission, operatorAccount,
  endpoints, poolCodePins, policy) {
  const prepared = prepareArbitrumTrade(input.pools, input.request,
    input.snapshot, input.binding);
  if (!prepared.candidate) return prepared;
  const codePins = Object.fromEntries(Object.values(deployment.rootPins)
    .map(pin => [pin.address.toLowerCase(), pin.runtimeCodeHash]));
  const adapter = new ArbitrumLiquidityExecutionAdapter({
    rpcUrl: endpoints.rpcUrl, submissionUrl: endpoints.submissionUrl,
    executor: deployment.executor.address,
    executorCodeHash: deployment.executor.runtimeCodeHash,
    codePins: { ...codePins, ...poolCodePins }, admission, confirmations: 1
  }, operatorAccount, [{ candidate: prepared.candidate,
    calldata: prepared.unsignedPayload }]);
  const snapshots = new SnapshotStore(60000);
  snapshots.apply(input.snapshot);
  const runtime = new LiquidityRuntime(snapshots,
    new AttemptJournal('.flashloan-agent/liquidity-attempts.jsonl'),
    new Map([[prepared.candidate.adapterId, adapter]]));
  return runtime.run([prepared.candidate], { ...policy, mode: 'shadow' });
}
```

The runtime requires matching, unexpired schema/math/simulation/canary admission
evidence even in shadow mode. It rejects changed heads, missing coverage/pins,
stale payloads and insufficient net profit. After actual canary admission, an
authorized host integration can use `mode: 'auto'`; there is no liquidity auto-send
CLI. See the [deployment receipt record](docs/deployments/arbitrum-one-liquidity-upgrade.json)
and [detailed formula spec](docs/liquid-formula.md) for the exact supported profiles.

`snapshot-analytics-arbitrum` captures V2/V3/V4 envelopes at one reconciled block.
V2 fee profiles still require independent revision admission.
`snapshot-algebra-arbitrum` captures Integral linked ticks; `simulate-v4` returns
rollback-only hook-aware quotes with pinned manager/quoter/hook revisions.
`snapshot-analytics-sui` verifies Cetus BCS, object digests and table coverage;
`stream-sui` reconciles checkpoint gaps with cancellation. `prepare-sui` builds
unsigned Cetus lender PTBs. `size-conditional` sizes supported Algebra/DeepBook
profiles; DeepBook currently supports input-token fees only.
Analytics does not grant permission to sign or send: the runtime re-quotes the
selected amount and retains its deployment, simulation, custody and budget gates.
Hook quotes require fresh executor-context simulation; Algebra plugins require
input-bound fee evidence. New contracts require reviewed deployment pins.
Production admission remains disabled; local PTB construction is not live Move proof.
Default verification uses recorded fixtures and loopback RPC servers only;
public fork tests require explicit opt-in environment configuration.

Independent Cetus SDK reference fixtures run in the offline test suite. To
regenerate all 10,000 vectors, install pinned SDK5.1.8 with its compatible Sui1.21.2
and tslib2.8.1 in a separate temporary directory, then run
`npm run liquidity:cetus-reference -- <SDK-directory>`. That SDK is not a runtime
dependency. Detailed local specification: `docs/liquid-formula.md`.

For an Arbitrum V2 observation, create a secret-free local `source-config.json`
using this template. Replace both placeholders with a reviewed V2 pool and
its independently verified runtime code hash; this template is not runnable
until those pins are supplied. `cursor` is your source sequence; optional
`blockNumber` selects an exact archive block instead of the current head.

```json
{
  "schemaVersion": "3.0",
  "rpcUrl": "https://arbitrum-one-rpc.publicnode.com",
  "sourceId": "arbitrum-reviewed-v2",
  "cursor": "1",
  "pools": [{
    "address": "<reviewed-v2-pool-address>",
    "expectedCodeHash": "<verified-runtime-code-hash>"
  }]
}
```

```sh
npm run liquidity -- snapshot-arbitrum ./source-config.json
```

The output is `{snapshot,pools,parentHash}`. Snapshot amounts are integer
strings in native token units; identity, provenance and state digest bind
them to their source. For continuous capture, use the follower variant of the
[source configuration schema](schemas/liquidity-source-config.schema.json):
add `network: "42161"`, `journalPath`, `start`, `maxFrames`, `maxGap`,
`pollIntervalMs`, and `maxIdlePolls`, and remove `cursor`/`blockNumber`.
Store the journal in a local ignored directory such as `.flashloan-agent/`.

```sh
npm run liquidity -- follow-arbitrum ./follow-config.json
```

For Sui, `checkpoint-sui` accepts `schemaVersion`, a gRPC `rpcUrl`, `network`,
the full `expectedChainIdentifier`, and a decimal-string `checkpoint`.
Use `ingest-sui`/`follow-sui` for journal capture and `state-sui` for declared
object recovery. Effects do not by themselves supply complete CLMM tick state.
Never put private keys or authenticated RPC credentials in shareable inputs.

Execution integration is currently library-only: see
[`runtime.ts`](src/liquidity/runtime.ts),
[`arbitrum-execution.ts`](src/liquidity/arbitrum-execution.ts), and
[`sui-execution.ts`](src/liquidity/sui-execution.ts), with executable examples
in their [Arbitrum](src/test/liquidity-arbitrum-execution.test.ts) and
[Sui](src/test/liquidity-sui-execution.test.ts) tests. Feed a frozen snapshot
and registered exact payload into bounded simulations, enforce admission and
gas/loss budgets, reserve nonce/gas-object custody, sign only after fresh
checks, then reconcile confirmed receipts before releasing the attempt.
Simulation can overlap across candidates and independent chain lanes;
exclusive custody prevents conflicting sends. There is no liquidity `run`
or `auto` CLI. Do not connect a signer until the deployment, protocol revision,
complete state coverage and operator-approved canary have been admitted.

Local validation is `npm test` and
`forge test --no-match-contract Fork`. Real lender callback/debt proofs require
an archive fork explicitly:

```sh
forge test --fork-url "$ARBITRUM_RPC_URL" \
  --match-contract MultiVenueRealLenderDebtForkProof -vv
```

Those tests use real Aave/Morpho/Balancer lenders with synthetic venues, not
a profitable live trade. Full E2E production admission remains incomplete.

The new liquidity pipeline is a local foundation, not a production trading
command. It provides block-pinned V2 observations, chain-pinned Sui checkpoint
effects, parent-linked durable source backfill, checkpoint-bound object references,
snapshot validation, bounded simulation, independent chain lanes, durable attempt
exclusion, and gas-loss accounting. Protocol-wide math,
additional protocol revisions, complete per-protocol compilers, and canary admission remain
release gates.

```sh
npm run liquidity -- sources
npm run liquidity -- snapshot-arbitrum ./source-config.json
npm run liquidity -- checkpoint-sui ./source-config.json
npm run liquidity -- ingest-arbitrum ./source-config.json
npm run liquidity -- ingest-sui ./source-config.json
npm run liquidity -- follow-arbitrum ./source-config.json
npm run liquidity -- follow-sui ./source-config.json
npm run liquidity -- state-sui ./source-config.json
npm run liquidity -- replay ./snapshots.jsonl
npm run liquidity:test
```

Source configurations require `schemaVersion: "3.0"` and follow
[`liquidity-source-config.schema.json`](schemas/liquidity-source-config.schema.json).
Arbitrum output wraps `{snapshot,pools}`; extract the flat `snapshot` records
for replay. Sui configuration must pin `expectedChainIdentifier` to the
endpoint's full Base58 genesis digest, not its legacy shortened hex identifier.
Checkpoint effects alone are not complete liquidity-state evidence. These CLI
commands never sign or submit transactions.

Range ingestion uses a configured `journalPath` and `maxFrames` (1–1000),
then resumes after the last complete fsynced observation. Source/genesis pins,
consecutive heights, parent links and record hashes are checked on recovery.
Torn records and stale writer locks fail closed; they are never silently
truncated or unlocked. `state-sui` replays committed checkpoint effects without
an RPC URL. Its `completeForDeclaredObjectSet` flag covers only configured
object IDs, not every tick/dynamic-field dependency of a liquidity protocol.
Exact-version object reads never substitute latest objects when history is
unavailable. See the [source record schema](schemas/liquidity-source-record.schema.json)
and [Sui object-reference schema](schemas/liquidity-sui-object-state.schema.json).

`follow-arbitrum` and `follow-sui` poll pinned network heads and capture every
height from `start` (or the recovered cursor). Configure `maxFrames`, `maxGap`,
and `maxIdlePolls` in 1–1000, and `pollIntervalMs` in 100–60000. A missing range
larger than `maxGap`, a regressed head, or divergent parents stops the follower.
Each `source-frame-committed` notification follows journal fsync. SIGINT/SIGTERM
stop between bounded reads; an active RPC may take its 15-second timeout.
These are read-only polling connectors, not sequencer or native gRPC streams.
Consumers must replay the durable journal after a crash between commit and
notification; stdout is not an exactly-once downstream delivery queue.

The corrected liquidity executor and V4 quoter are deployed at the addresses
above. Historical immutable V4 deployments remain revoked. Fresh execution
admission is still required before production use.

Exact V3 bitmap/tick-crossing quotes and static no-hook ERC-20 V4 quotes are
available in `src/liquidity/clmm.ts`. Quotes fail when the proven tick horizon
is exhausted; Algebra, hooks and dynamic V4 fees are not silently treated as V3.
The module retains the upstream TickMath GPL-2.0-or-later notice.
Its versioned output follows the [CLMM quote schema](schemas/liquidity-clmm-quote.schema.json).

`ArbitrumLiquidityExecutionAdapter` and `SuiLiquidityExecutionAdapter` implement
separate exact-payload simulation, final local signing, raw submission and
receipt/effects reconciliation for the durable runtime. These library exports
are not a CLI auto-send feature and are not production-admitted. Arbitrum
requires a corrected pinned multi-lender executor and accounts gas in WETH;
Sui requires fully resolved review-admitted native-SUI PTBs, package/state pins,
an exclusive gas-object version, a matched opaque loan receipt and a terminal
guard. Unsupported profit assets require a separate pinned oracle adapter.
Tests use real EIP-1559/BCS signatures but synthetic protocol responses, not
live canary transactions. Signed transaction bytes are never written to the
attempt journal. Registered exact payloads support receipt recovery without
resigning or resubmission.

## Read-only real-time scanning

## Rust/Alloy live route engine

`flashloan-daemon` consumes validated sequencer and canonical-head events, keeps only current live pool state in memory, and emits versioned JSONL decisions. It refuses to route until both sources agree on a live canonical/tentative epoch; a hash, parent, or sequence conflict halts route eligibility. V2 pools are executable, V3 quotes are executable only within a supplied known tick interval, and V4 remains discovery-only.

The current executor ABI can submit a two-leg DEX pair arbitrage only. The daemon analyzes 2–6-hop affected-subgraph cycles but marks routes longer than two hops `EXECUTOR_CAPABILITY_UNAVAILABLE` until a separately reviewed ABI supports them.

```sh
cargo run --locked --release -p flashloan-daemon -- validate-config engine.json
cargo run --locked --release -p flashloan-daemon -- replay engine.json live-events.jsonl
```

`engine.json` uses `schemaVersion: "2.0"`, `chainId: 42161`, explicit factory addresses, risk limits in decimal-string USD E8 units, an executor address/code hash/current selector, and an `rpc-send-raw-transaction` relay URL environment-variable name. `live-events.jsonl` accepts `head`, `poolUpsert`, and `scan` records; it is the deterministic replay contract for dual-ingress E2E tests and adapter integration.

The legacy TypeScript scanner below remains available for liquidation and protocol-observation compatibility while its feed adapters migrate. It is not the production boundary for new DEX route calculation.

Scanning is separate from execution. It needs a public Arbitrum RPC and no wallet, executor address, or private key. Create a secret-free configuration such as:

```json
{
  "chainId": 42161,
  "rpcUrl": "https://your-arbitrum-rpc.example",
  "startBlock": "123456789",
  "assetAllowlist": ["0x0000000000000000000000000000000000000001"],
  "protocols": {
    "aaveV3": { "pool": "0x0000000000000000000000000000000000000001", "multicall3": "0x0000000000000000000000000000000000000001", "healthBatchSize": 200 },
    "morphoBlue": { "blue": "0x0000000000000000000000000000000000000001" },
    "balancerV2": { "vault": "0x0000000000000000000000000000000000000001" },
    "uniswapV4": { "poolManager": "0x0000000000000000000000000000000000000001" }
  }
}
```

Run once or continuously:

```sh
node dist/cli.js scan --config scanner.json --once
node dist/cli.js scan --config scanner.json --watch
```

The scanner emits `schemas/scan-envelope.schema.json` records with typed candidates. Its intents describe protocol-specific requirements, including Balancer Vault callbacks and Uniswap v4 `unlock` delta settlement; they are not directly executable calldata.

When `protocols.aaveV3.multicall3` is configured, Aave account health is queried in bounded account batches (default 200) through that verified address. Legacy scanner configurations retain sequential reads for compatibility.

## Dynamic proposal bridge

`solve <solver-input.json> --config <solver-config.json>` turns a typed Aave or Morpho candidate and block-bound route quotes into an executor proposal. The solver configuration declares the executor and which capabilities are both enabled and fork-verified. A proposal is rejected if its evidence is stale, its quote exceeds the configured impact, its capability is unproven, or it cannot meet minimum net profit. Balancer v2 and Uniswap v4 observations remain non-broadcastable until their callback semantics are proven against an executor fork.

Every solve run appends a sanitized event to `.nim/memory.jsonl`; repeated reusable failure codes are promoted once to `.nim/lessons.jsonl`. Keys, endpoint credentials, signatures, raw calldata, and signed transactions are never recorded.

To run the opt-in live E2E without credentials, point `E2E_ARBITRUM_SCANNER_CONFIG` at a bounded scanner configuration and run `npm test`. The test asserts a real finalized-block envelope and accepts zero opportunities; it never signs or broadcasts.

## Level 2 market context for agents

The Level 2 extension ingests Arbitrum/Sui evidence and optional market feeds into
hash-linked journals, computes protocol-native executable depth and flow metrics,
and exposes canonical context through CLI or local stdio MCP. Fast Feed data stays
provisional. Approvals describe permission, never proof of a future sale.

Use Level 2 alongside the liquid-pattern preparation flow:

1. Capture canonical pool state and swaps with `l2-follow`. Start with public RPC;
   optional Binance/Hyperliquid books add market context. No Twitter, Discord or
   news source is required. Arbitrum capture processes one explicit block per call;
   the host schedules successive blocks and handles resynchronization.
2. Run `l2-replay` to materialize frames, then `l2-inspect` or `l2-serve` to expose
   executable depth, buy/sell flow, coverage, freshness and evidence to the agent.
3. Use those facts to choose pools for canonical route comparison and unsigned
   `prepare-arbitrum` preparation. A descriptive label or tentative feed event
   does not replace fresh canonical state or exact transaction simulation.
4. An admitted host integration passes bound frames and candidates through
   `runL2Candidates`, beginning in shadow mode. CLI/MCP tools can request expiring
   shadow evaluation; the worker must consume that request under operator policy.
   Prediction-based ranking additionally needs a validated, operator-pinned report.

For example, save this non-secret JSON as `follow.json` to ingest an existing
file of versioned observations matching `schemas/level-2.schema.json`:

```json
{
  "schemaVersion": "1.0",
  "journalPath": ".flashloan-agent/l2/raw.jsonl",
  "outputPath": ".flashloan-agent/l2/frames.jsonl",
  "source": { "kind": "jsonl", "path": "observations.jsonl" }
}
```

For `serve.json`, use `{ "schemaVersion": "1.0", "journalPath":
".flashloan-agent/l2/raw.jsonl" }`. Configure the MCP client to launch
`node dist/liquidity/cli.js l2-serve /absolute/path/to/serve.json` from this
repository root. The inspect tool is `l2_inspect_pool_microstructure` with
`{ "pool_id": "<captured pool ID>" }`; stale or incomplete coverage stays explicit.
Use `l2-sources` and the specification below for pinned RPC/stream configurations.

```sh
npm run l2 -- l2-sources
npm run l2 -- l2-follow follow.json
npm run l2 -- l2-replay replay.json
npm run l2 -- l2-inspect inspect.json
npm run l2 -- l2-serve serve.json
npm run l2 -- l2-evaluate evaluate.json
npm run l2:test
npm run l2:proof
```

[The Level 2 specification](docs/features/level-2.md) defines exact input/output
contracts, configuration, source capabilities, rotation/retention, MCP resources,
chronological evaluation and execution integration. Public schemas are in
`schemas/level-2.schema.json`. Offline/RPC/MCP workflows retain Node 20 support;
optional native WebSocket streaming needs Node 22+.

Predictions start as research-only. An explicitly pinned report must establish
holdout improvement and paired shadow net benefit before predictive prioritization.
`runL2Candidates` retains existing simulation, custody, fees and profit gates and
rechecks reflection state before signing/submission. The CLI and MCP server never
construct a signer. Local E2E proof does not admit a production strategy or adapter.
