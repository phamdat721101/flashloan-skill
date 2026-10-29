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

### 2026-10-29: v7 integration (v4 pool identity, single policy, native-v4 executor)

This release fixes the Robinhood MCP → local-skill blockers. Before it, all 23 discovered
Uniswap v4 pools were rejected before any RPC read, native ETH legs could not be quoted
or settled, and the acceptance lane ran its own hardcoded policy. Everything below
is behind a gate that defaults **off**. Existing commands, schemas and outputs
are byte-identical until you enable it.

| Area | What changed |
| --- | --- |
| Pool identity | v4 pools resolve to `PoolManager + poolId + PoolKey` from canonical `Initialize` logs. Each target gets exactly one disposition (resolved, unresolved key, reorg, uninitialized, hook/dynamic-fee unsupported, budget-deferred). |
| Policy | `compilePolicy` remains the only policy owner. Caller limits in `flash-intent/1` can only tighten the approved profile. A missing profile gives `INPUT_BLOCKED`, while research continues. |
| Costs | Route fee evidence is the cost; the gas budget only bounds the reservation. Native→repayment conversion rounds up. Net must be strictly greater than the floor. |
| Executor | New `NativeV4FlashExecutor` (`evm-native-v4/1`): unwrap → native v4 swaps → rewrap; flash debt stays ERC20. Settlement uses `sync(address(0))`, and forced ETH is reported, never profit. **Built and tested; not deployed.** |
| Codecs | The calldata codec follows the deployed capability (MultiVenue / portable split / native). An unsupported split or native route is refused, never downgraded. |
| Admission | Proofs are re-hashed from their bytes and bound to manifest, capability, payload, policy and state. Producers come from a hash-pinned list, and fixtures never admit. |
| Provenance | Executor artifacts are stored by content hash. `deployment-status --executor-manifest` verifies the live code against the stored artifact; a rebuilt `out/` file is only a diagnostic. |
| Reporting | `flash-round-result/1` has 13 statuses mapped to legacy outcomes. An unknown receipt halts without realized profit. |

Contract and docs: [implementation spec](docs/features/flashloan-v7-integration.md),
[System Map](docs/features/flashloan-v7-integration-map.md),
[ledger](docs/features/flashloan-v7-integration.spec.json), shared schema
`schemas/flashloan-integration-v1.schema.json` (sha256 `1de7fced…aaaf`), and agent
prompt [v7](skills/flashloan-agent/prompt-v7.md).

Update and verify:

```sh
cd ~/.flashloan-agent/flashloan-skill
git switch main
git pull --ff-only origin main
npm ci && forge build && npm run build
node dist/agent-cli.js install          # also bundles the v7 schema, examples and version manifests
node --test dist/test/flashloan-v7-integration.test.js dist/test/flashloan-v7-runtime.test.js
forge test --match-path test/NativeV4FlashExecutor.t.sol
npm run evm:abi-check
```

Run a read-only identity, policy and ledger round. It never loads signer secrets:

```sh
# 1. Owner: set features.integrationV7=true in config/flashloan-integration-versions.json.
#    Until then the command returns VERSION_UNSUPPORTED.
# 2. Provide a reviewed v4 manager mapping (v4-manager-mapping/1) and, for sizing, an approved profile file.
node --env-file=.env dist/evm/cli.js integration-run \
  --intent schemas/examples/flashloan-integration-v1/intent-valid.json \
  --inventory mcp-inventory.json --mapping config/v4-managers.json [--profile profile.json]
```

The result lists every target and the exact next dependency for each blocked one.

**Still required before any native trade:**
- A no-broadcast fork test on a pinned Robinhood block.
- A separately authorized deployment of `NativeV4FlashExecutor`.
- An owner-added trusted producer in `config/admission-producers.json`, which ships empty.
- A fresh unsigned simulation on that deployment.

None of these has happened. The latest **deployed** contract is unchanged: the
Arbitrum `PortableMultiSplitFlashExecutor` below.

### 2026-10-28: price-gap engine v5.2 for agents

The latest code adds dynamic borrow-asset/lender selection, owner-approved profit
floors below $10, coverage-aware concentrated-liquidity sizing, mixed-quote cycles,
and up to eight branches where the selected executor supports them. Exact fees,
repayment, opening-balance custody, native simulation and receipt reconciliation
remain required. Existing v5.0/v5.1 requests keep their prior policy semantics.

The [agent skill](skills/flashloan-agent/SKILL.md) includes the v5.2 request path,
current portable executor pin, and separate DexPair/portable ABI bindings. Update
the published implementation branch and reinstall the skill:

```sh
cd ~/.flashloan-agent/flashloan-skill
git switch aero-v2-routing
git pull --ff-only origin aero-v2-routing
npm ci
npm run build
node dist/agent-cli.js install
node --env-file=.env dist/cli.js validate-config
```

For agents, `evidence-gap-run` is the multi-funding research entrypoint:

```sh
# .env selects FLASHLOAN_EVIDENCE_HOST_FILE, a local non-executable funding snapshot.
node --env-file=.env dist/liquidity/cli.js evidence-gap-run gap-request.json
npm run gap:test
npm run gap:local-e2e
```

Use `GapRunRequest` in `schemas/flashloan-evidence-v5.2.schema.json`: supply the
nested 5.2 request, approved profile reference, allowed assets/lenders, explicit
per-option caps, and finite attempt/deadline budgets. Every cap tightens the
nested request ceiling. Results include the selected option, normalized net
profit, per-option outcomes and child evidence manifests. A candidate result
permits further verification; it does not grant execution authority. The full
[implementation guide](docs/features/price-gap-engine.md) describes inputs,
outputs, host adapters and remaining public-network acceptance gates.

**New Arbitrum deployment:** `PortableMultiSplitFlashExecutor` is deployed at
[`0x1df55df59413e823d2bbd926ee76c9a3fd63c478`](https://arbiscan.io/address/0x1df55df59413e823d2bbd926ee76c9a3fd63c478).

| Item | Verified value |
| --- | --- |
| Deployment transaction | [`0xc6fc…865a7`](https://arbiscan.io/tx/0xc6fcfadd9f7ec0b1ba86e7f40b22de539a66b5b7459d4782a549d17ce79865a7), block `519058877` |
| Runtime code hash | `0xa86825585912690c2d008410bf9315f8691ee0ffcad92f6e390b774ab05d89bb` |
| Owner | `0xc75aAeBD1F395cFc9e7c7f291Ea32d5C9d4c270a` |
| Split selector | `executeSplitArbitrage`: `0xec01ba1f` |
| Limits | Up to eight branches and six hops per branch; route-specified borrow asset |
| Funding | Morpho/Balancer for splits; inherited linear Morpho/Balancer/Aave entrypoints |
| Configuration | Ten code-hash-pinned lender/protocol roots; hooks disabled |
| Finality | All eleven receipts L1-finalized at readback; finalized L2 block `519061260` |
| Deployment + configuration gas | `98996676676000` wei (`0.000098996676676 ETH`), eleven successful transactions |
| Evidence | [Deployment and root readback](docs/deployments/arbitrum-price-gap-executor-20261028.json); [manifest](config/arbitrum-price-gap.json) |

This replacement adds split execution to the prior linear MultiVenue deployment
`0x2502539753df1182f015378f32fbdef0ec9c9de2`. The old immutable contract and its
funds remain intact for rollback. Base Aero v2 remains a separate deployment.
`FLASH_EXECUTOR_ADDRESS` must still identify the DexPair executor; its ABI is
different. For the new inherited MultiVenue entrypoints, explicitly select:

```sh
MULTI_VENUE_EXECUTOR_ADDRESS=0x1df55df59413e823d2bbd926ee76c9a3fd63c478
```

Split hosts must bind the new address, runtime hash and split selector to the
`PortableMultiSplitFlashExecutor` ABI. Keep principal allocation conservation,
exact external costs, native simulation and owner authorization checks. No live
arbitrage trade was sent and trading admission remains `not-admitted`; deployment
receipts do not establish profitable execution. The evidence record reports L1
finality separately from confirmed canonical L2 receipts.

To re-check from the deployment checkout, use its persisted public transaction
state and an explicit environment loader:

```sh
forge build
npm run build
node --env-file=.env scripts/price-gap-deployment-readback.mjs
node --env-file=.env dist/evm/cli.js deployment-status \
  --manifest config/arbitrum-price-gap.json \
  --state .nim/deployments/arbitrum-price-gap.json
```

The deployer now gives portable-only replacements a fixed `-portable-split`
authority ledger while retaining the existing shared signer lock and cumulative
gas budget. Preserve `.nim/deployment-ledger`, `.nim/deployments` and
`.nim/evm-budgets` when resuming; a fresh checkout without those ledgers must not
be mistaken for the recorded deployment's recovery state.

### 2026-10-28 (later): Chainlink gas pricing replaces `NATIVE_TOKEN_USD`

The orchestrator (`simulate`, `execute-auto`, `run`) no longer uses a hand-set ETH price. Gas is priced from **Chainlink ETH/USD at the block being valued**: the simulation block, then the receipt block. It is gated on the Arbitrum L2 sequencer being up. This pricing change did not alter contracts. The portable split replacement above is now the latest deployment; the earlier MultiVenue v2 remains available for rollback and DexPair `0x093e…d192` retains its separate ABI.

| Item | Value |
| --- | --- |
| ETH/USD feed | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` (8 decimals; max age 90000 s) |
| Sequencer uptime feed | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` (must be up for at least 3600 s) |
| Gas cost math | `ceil(gasWei × priceUsdE8 / 1e18)` in integer USD·1e8; never understated |
| Profit floor | `expectedNetProfitUsd = quotedNetProfitUsd − gasCostUsd`. It now subtracts live gas. |
| Receipt valuation | 3 bounded retries, then P&L `unknown` and a daily halt |
| Spec | [chainlink-native-price](docs/features/chainlink-native-price.md), [system map](docs/features/chainlink-native-price-map.md) |

**Upgrade an install and env:**

```sh
cd ~/.flashloan-agent/flashloan-skill && git pull --ff-only origin main && npm run build
# .env: delete NATIVE_TOKEN_USD (ignored now). Optional overrides, Arbitrum defaults shown:
# NATIVE_USD_FEED=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
# NATIVE_USD_MAX_AGE_SECONDS=90000
# SEQUENCER_UPTIME_FEED=0xFdB631F5EE196F0ed6FAa767959853A9F217697D   # or none
# SEQUENCER_GRACE_SECONDS=3600
set -a; . ./.env; set +a
node dist/cli.js validate-config      # prints nativePrice policy; warns if NATIVE_TOKEN_USD is still set
node dist/cli.js simulate opportunities.json
```

How to read the output:
- Each simulation result and receipt carries `nativePrice`: `{feed, priceUsdE8, updatedAt, blockNumber, blockTimestamp, sequencer}`, the exact price used.
- A plan is rejected with a stable reason when pricing is not safe:
  - `NATIVE_PRICE_STALE_OR_INVALID`
  - `NATIVE_FEED_UNREADABLE`
  - `SEQUENCER_DOWN`
  - `SEQUENCER_GRACE_PERIOD`
- There is no fallback to a fixed price.

### 2026-10-28: dynamic pool universe and Arbitrum MultiVenue executor v2

Price-gap analysis and pool scanning are no longer limited to WETH/USDC. The flashloan MCP discovers pools, and every pool is re-verified on-chain before any scanner uses it. The new Arbitrum executor can execute those verified pools by address.

| Item | Published reference |
| --- | --- |
| Network | Arbitrum One, chain ID `42161` |
| MultiVenue executor v2 | [`0x2502539753df1182f015378f32fbdef0ec9c9de2`](https://arbiscan.io/address/0x2502539753df1182f015378f32fbdef0ec9c9de2) |
| Deployment transaction | [`0x04b002863b16397c2f66d13dbd2357eab7709b7791aecef8dcbc85ccacc25a60`](https://arbiscan.io/tx/0x04b002863b16397c2f66d13dbd2357eab7709b7791aecef8dcbc85ccacc25a60), block `518949007`, L1-finalized |
| Runtime code hash | `0x4af4288976e9e54e3f57f954d463fa75b871a88eb9560aa36dc1afedd7c3efe8` |
| Pinned roots (10) | Uniswap V2/V3/V4, Sushi V2/V3, PancakeSwap V3, Camelot (Algebra) factories; Morpho, Balancer V2, Aave V3 lenders ([manifest](config/arbitrum-mainnet.json)) |
| Evidence | [deployment record](docs/deployments/arbitrum-one-multi-venue-executor-v2.json): root readback, fork venue proofs, positive fork trade, mainnet dry-run |
| DexPair executor | `0x093e98a6e2e278426adc7161b61bb2132e0ad192` (the only executor with `executeDexPairArbitrage`); venue ids proven by trace: `0` Camelot, `1` Uniswap V3, `2` PancakeSwap V3 |

Compared with the earlier liquidity executor `0xba46…5b0a`, v2 adds `pancakeV3SwapCallback` and pins several factories per venue type (Sushi, PancakeSwap and Camelot alongside Uniswap). Trading admission is still **not granted**: every live trade needs an approved canary.

**Update an existing install:**

```sh
cd ~/.flashloan-agent/flashloan-skill
git pull --ff-only origin main
npm ci && forge build --offline && npm run build && cargo build -p flashloan-scan --release
```

**Operator env** (`.env` is local only; see [`.env.example`](.env.example)):

```sh
FLASH_EXECUTOR_ADDRESS=0x093e98a6e2e278426adc7161b61bb2132e0ad192        # DexPair entrypoint (flashloan-scan arb, orchestrator)
MULTI_VENUE_EXECUTOR_ADDRESS=0x1df55df59413e823d2bbd926ee76c9a3fd63c478  # latest portable replacement; inherited MultiVenue entrypoint
# UNIVERSE_PATH / ASSET_POLICY_PATH / MAX_PAIRS: opt-in dynamic scanner mode
```

`flashloan-scan arb` now refuses an executor without the DexPair entrypoint (`EXECUTOR_LACKS_DEX_PAIR_ENTRYPOINT`). Previously, such an executor was silently reported as `no_edge`.

**Workflow (read-only by default):**

```sh
set -a; . ./.env; set +a
# 1. Agent: flashloan_discover_arbitrage_pools(network="arbitrum", tokens=[…]) → save the raw JSON unchanged
# 2. Verify pools on-chain → pool-universe/1 (expires after 6h; an inventory older than 1h is refused)
node dist/evm/cli.js universe --inventory .nim/universe/raw-arbitrum.json \
  --policy config/arbitrum-asset-policy.json --out .nim/universe/arbitrum.json
# 3. Per-pair spread signals (decimal- and fee-correct)
UNIVERSE_PATH=.nim/universe/arbitrum.json SIGNAL_ONCE=1 ./target/release/flashloan-scan 100000 10
# 4. Dry-run every verified pool cycle through MultiVenue v2 (eth_call from the owner; never signs)
node dist/evm/cli.js universe-probe --universe .nim/universe/arbitrum.json \
  --lender 0xBA12222222228d8Ba445958a75a0704d566BF2C8 --lender-kind 2 --size-usd 1000
# 5. DexPair dry-run over universe combos (no --live)
UNIVERSE_PATH=.nim/universe/arbitrum.json ASSET_POLICY_PATH=config/arbitrum-asset-policy.json ./target/release/flashloan-scan arb
```

How to read the results:
- In `universe-probe`, `Unprofitable` means both swaps, both callbacks and the lender repayment executed, and the cycle has no edge at that size.
- `SIMULATED_PROFITABLE` is a candidate only. Sending still requires the canary approval gates.
- Aero live on Base accepts `universePath` (plus optional `borrowAsset` and `valuation` for a stablecoin borrow). It plans only pools the V2 executor already trusts. New Base pools from factory `0x9cb2…7a76` are a new pool generation and are not configured.

### 2026-10-27: v5.1 evidence workflow

The **2026-10-27 v5.1 upgrade** implements local evidence-driven research and
trigger-first evaluation: exact integer sizing, bounded searches, canonical
trigger replay and head rechecks, semantic artifact validation, owner-approved
lesson gates, and typed reporting. The [implementation companion](docs/features/flashloan-evidence-driven-execution.md)
describes the host interfaces and remaining acceptance gates.

The latest recorded Base executor is **AeroSplitFlashExecutorV2**, deployed on
2026-10-24. This upgrade changes the agent/runtime; its Solidity bytecode is
unchanged. The deployed executor has no proxy or in-place bytecode upgrade
mechanism. A future Solidity revision needs a new deployment, configured roots,
verified artifact binding and fresh admission.

| Item | Published reference |
| --- | --- |
| Network | Base mainnet, chain ID `8453` |
| V2 executor | [`0x63bdcea3ce513317b5b8694978908a1e3d3a4e87`](https://basescan.org/address/0x63bdcea3ce513317b5b8694978908a1e3d3a4e87) |
| Deployment transaction | [`0x35e798309c80e5c26f5870d829bece86b74b6f9aaf1c6c5e611abe6cdbe22951`](https://basescan.org/tx/0x35e798309c80e5c26f5870d829bece86b74b6f9aaf1c6c5e611abe6cdbe22951), block `53029413` |
| Runtime code hash | `0x35c84dac168a1fa190940fac287d2d544bda45afdc3132d8daad2ce0eff721d1` |
| Selector | `0xc7c01977`; use the [V2 artifact binding](config/aero-base-executor-v2.json) |
| Deployment/configuration evidence | [Base Aero v2 record](docs/deployments/base-aero-v2-20261024.json), including 28 configured roots and `liveTradingAdmitted: false` |

[Read-only verification on 2026-10-27](docs/deployments/base-aero-v2-readback-20261027.json)
records the finalized block, executor runtime hash, owner, deployment receipt,
and readback of all 28 configured root entries. This evidence establishes the
recorded contract state at that block; trading admission remains separate.

Update an existing checkout on `aero-v2-routing`, then build and verify:

```sh
git pull --ff-only origin aero-v2-routing
npm ci
forge build --offline
npm run build
npm run evidence:spec
npm run evidence:test
node scripts/verify-flashloan-implementation.mjs
```

`evidence:spec` checks the original specification and file-specific dependency
pins. `evidence:test` tests the implemented local runtime and watcher.
The implementation verifier compiles all schemas strictly and executes five
local edge proofs. These commands require no wallet or public RPC.

For an agent using v5.1:

1. Follow [prompt v4](skills/flashloan-agent/prompt-v4.md). Build a strict
   [v5.1 RunRequest](schemas/flashloan-evidence-v5.1.schema.json) with a unique
   `runId`, network and asset locators, hash-bound risk profile, raw principal
   cap, and cost/valuation references. Monetary integers are decimal strings;
   asset decimals are explicit and must match captured pools.
2. Supply an explicit `EvidenceHost` for profile, inventory and canonical
   capture. Native simulation additionally needs compile/simulate adapters and
   caller/executor context. The CLI's optional `FLASHLOAN_EVIDENCE_HOST_FILE`
   accepts only an owner-configured `evidence-host/1.0` snapshot-file with
   `profile`, `inventory` and `market`; it cannot sign or run native simulation.
3. Run the evidence workflow and inspect its durable report:

   ```sh
   npm run liquidity -- evidence-run request.json
   npm run liquidity -- evidence-integrity .nim/evidence/rounds/YOUR_RUN_ID
   ```

   `FLASHLOAN_EVIDENCE_ROOT` can select another artifact root. Missing host
   capability produces an explicit handoff/inconclusive report. Integrity or
   approved lesson BLOCK refuses publication and returns a nonzero CLI status.
4. For continuous trigger evaluation, embed `runTriggerWatcher` with a
   `WatchHost`; `followEvmTriggerBlocks` supplies journal-backed V2/V3 Swap and
   liquidity events. One bounded worker replays the trigger block and rechecks
   canonical head state. Bandless shadow evaluation is supported. There is no
   standalone `evidence-watch` CLI or implicit native adapter; V4 watcher
   liquidity events remain unsupported.
5. Consume the report, manifest, integrity and recall records under
   `rounds/<runId>/` and content-addressed JSON under `objects/`. Records join
   by state/policy/plan/payload hashes. A model remains `SNAPSHOT_MODEL`;
   `NATIVE_SIM` requires bound native evidence, and `RECEIPT` requires a raw
   receipt and reconciled attempt journal. The standalone audit has no trusted
   journal adapter and cannot re-establish receipt authority. Report helpers
   project typed 26-column CSV/sheet data; unknown dollar metrics stay null.

`npm run evidence:local-e2e` deploys constructed localhost liquidity and the
existing executor, then verifies borrow → two swaps → repayment → preserved
opening funds → journal/receipt → report/CSV. It requires Anvil and permission
to bind localhost. It does not send to a public chain.

Original historical snapshot/CSV parity, pinned native forks, live-shadow
survival measurements, public tool integration and authorized canaries remain
acceptance gates. Procedures/rules from memory require owner approval; recalled
memory never replaces current evidence or execution authorization.

For the deployed V2 workflow, capture the configured pools without signing:

```sh
npm run aero -- capture \
  --registry config/aero-v2-base-pools.json \
  --output .nim/aero-v2-snapshot.json
```

Capture uses `BASE_RPC_URL` when configured and otherwise the public Base RPC.
Use the [V2 operating workflow](#aero-v2-aerodrome--uniswap-routing-with-live-sends)
for its separate fork rehearsal and explicitly authorized send path. Match V2
requests (`aero-split/1.1`) to the V2 artifact; evidence `5.0`/`5.1`
records are separate host data contracts. Deployment and local simulation do not establish
a profitable live trade or authorize one.

For the full design and verified dependencies, read the [original v5 PRD](docs/PRD-flashloan-evidence-driven-execution-upgrade-2026-10-26.md),
[trigger-first addendum](docs/PRD-flashloan-trigger-first-execution-upgrade-2026-10-27.md),
[implementation companion](docs/features/flashloan-evidence-driven-execution.md),
[v5.1 additions](schemas/flashloan-evidence-v5.1-additions.schema.json), and
[requirement/test manifest](docs/features/flashloan-evidence-driven-execution.spec.json).
The [delivery maps](docs/features/flashloan-evidence-driven-execution-map.md)
keep full public runtime acceptance Draft until its remaining evidence passes.

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

Gas in `simulate`, `execute-auto` and `run` is priced from **Chainlink ETH/USD at the valued block** (simulation block, then receipt block), with an Arbitrum L2 sequencer-uptime gate. `NATIVE_TOKEN_USD` is deprecated and ignored; `validate-config` warns if it is still set. Configuration:
- Overrides: `NATIVE_USD_FEED`, `NATIVE_USD_MAX_AGE_SECONDS` (default 90000), `SEQUENCER_UPTIME_FEED` (`none` disables the gate) and `SEQUENCER_GRACE_SECONDS` (default 3600).

Behaviour:
- A stale or invalid price, or a sequencer that is down or inside its grace period, fails the simulation closed (`NATIVE_PRICE_*`, `SEQUENCER_*`).
- Receipt valuation retries 3 times before marking P&L `unknown` and halting.
- The $10 profit floor now subtracts the live gas cost from the quoted profit.
- Spec: [chainlink-native-price](docs/features/chainlink-native-price.md).

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

`NativeV4FlashExecutor` (v7, capability `evm-native-v4/1`) has no recorded address:
it is implemented and tested locally but not deployed on any chain.

| Network / contract | Recorded address | Scope |
| --- | --- | --- |
| Arbitrum One / PortableMultiSplitFlashExecutor (latest, 2026-10-28) | [`0x1df55df59413e823d2bbd926ee76c9a3fd63c478`](https://arbiscan.io/address/0x1df55df59413e823d2bbd926ee76c9a3fd63c478) | `executeSplitArbitrage` (≤8 branches) plus inherited `executeLenderArbitrage`; ten roots pinned; hooks disabled; L1-finalized; `not-admitted`. [Record](docs/deployments/arbitrum-price-gap-executor-20261028.json) |
| Arbitrum One / MultiVenue executor v2 (universe routing) | [`0x2502539753df1182f015378f32fbdef0ec9c9de2`](https://arbiscan.io/address/0x2502539753df1182f015378f32fbdef0ec9c9de2) | Pool-address legs; Uniswap/Sushi/PancakeSwap/Camelot roots; Morpho, Balancer, Aave lenders; L1-finalized; trading admission required |
| Arbitrum One / DexPair executor | `0x093e98a6e2e278426adc7161b61bb2132e0ad192` | `executeDexPairArbitrage` (router venues 0 Camelot, 1 Uniswap V3, 2 PancakeSwap V3); `FLASH_EXECUTOR_ADDRESS` target |
| Arbitrum One / previous liquidity executor | [`0xba4681b7cae1a67c703f43f1476b25fef2635b0a`](https://arbiscan.io/address/0xba4681b7cae1a67c703f43f1476b25fef2635b0a) | Corrected multi-lender/multi-venue ABI without the PancakeSwap V3 callback; trading admission required |
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
the existing execution risk checks. This historical address has no DexPair entrypoint. Point `FLASH_EXECUTOR_ADDRESS` at the DexPair executor `0x093e…d192`, and use `MULTI_VENUE_EXECUTOR_ADDRESS` for MultiVenue v2. Do not send a public-mempool canary.

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

Price-gap analysis and pool scanning now run over a **verified pool universe** instead of hardcoded WETH/USDC pools. The flashloan MCP (`flashloan_discover_arbitrage_pools`) only does discovery. Its output is never used for execution until every pool has been re-verified on-chain at one pinned block. That check covers the factory allowlist, `token0`/`token1` versus the provider's `asset_ids`, decimals, live state and code hash. Provider `price_usd`/`liquidity_usd` are used only to rank pools.

```sh
# 1. Agent: call flashloan_discover_arbitrage_pools(network, tokens) and save the raw JSON response unchanged.
# 2. Verify it into pool-universe/1 (read-only; RPC from ARBITRUM_RPC_URL or the public default):
node dist/evm/cli.js universe --inventory .nim/universe/raw-arbitrum.json \
  --policy config/arbitrum-asset-policy.json --out .nim/universe/arbitrum.json
# 3. Per-pair spread signal over every verified pair (decimal/orientation-correct, fee floor per pool):
UNIVERSE_PATH=.nim/universe/arbitrum.json SIGNAL_ONCE=1 ARBITRUM_RPC_URL=… flashloan-scan 100000 10
# 4. Dynamic DexPair dry-run (flash assets = universe assets with feed + lender):
UNIVERSE_PATH=… ASSET_POLICY_PATH=config/arbitrum-asset-policy.json FLASH_EXECUTOR_ADDRESS=… flashloan-scan arb
```

- The universe records every dropped pool in `rejected` with a reason (`FACTORY_UNKNOWN`, `TOKEN_MISMATCH`, `SINGLE_POOL_PAIR`, …) and expires after `universeTtlSeconds`. Consumers fail closed on expiry or a chain mismatch.
- `arb` dynamic mode refuses to run (`VENUE_MAP_UNVERIFIED`) until the owner records `executorVenues.verifiedBlock` in the policy, after a dry-run proves the deployed executor's venue ids.
- Aero live: set `universePath` (and optionally `borrowAsset` + `valuation` for a stablecoin borrow) in the live config. Pairs come from the universe and pools come from `discoverAeroPools`. Only pools the executor already trusts are planned; the run reports the rest as needing an owner `configurePool` transaction.
- Without `UNIVERSE_PATH`/`universePath`, behaviour is unchanged.
- Arbitrum execution path: see [the 2026-10-28 upgrade](#2026-10-28-dynamic-pool-universe-and-arbitrum-multivenue-executor-v2) for the MultiVenue v2 executor and `universe-probe`.

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

### Price-gap engine (evidence 5.2)

Version 5.2 enables owner-approved small-profit floors, exact serial CPMM seeds,
coverage-aware CLMM sizing, mixed-quote cycles, and up to eight policy-bounded
branches. Versions 5.0/5.1 retain their existing policy semantics. Enable singleton
cycle edges with `npm run evm -- universe ... --cycles`.

`npm run liquidity -- evidence-gap-run <request.json>` accepts the `GapRunRequest`
definition in `schemas/flashloan-evidence-v5.2.schema.json`. Configure the existing
`FLASHLOAN_EVIDENCE_HOST_FILE` with `schemaVersion: "gap-host/1.0"`,
`kind: "funding-snapshot-file"`, `inventory`, and `options` entries containing
`option`, `market`, and `profile`. This file adapter performs research only.
Every option has an explicit principal cap; it cannot exceed the embedded request
cap or change its approved profile. Costs and valuation belong to that option's
asset. No implicit stablecoin price or fee is supplied.

Embedding hosts use `runGapEvidence()` with explicit `funding`, `captureFunding`,
`compileFunding`, and `simulateFunding` methods. The latter methods receive the
selected option; its complete evidence is retained and bound into the execution
context. Native admission and actual execution remain the existing executor path.
`gapStreamWatchHost()` bridges verified source adapters to the existing watcher;
transaction hints require canonical capture, and cursor gaps require resync.
No unverified Flashblocks storage layout, sequencer format, hook or tax model is
admitted automatically.

Run `npm run gap:test` and `npm run gap:local-e2e`. The local E2E deploys synthetic
liquidity to Anvil, simulates, signs, mines and reconciles a receipt. It does not
establish public-market profitability. See [implementation specification](docs/features/price-gap-engine.md).
