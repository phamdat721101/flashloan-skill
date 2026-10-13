# Sui terminal-profit guard deployment

The Move package at `move/terminal-profit-guard` is the only contract this
repository deploys. It holds an admin capability, an operator capability, and
the terminal `assert_min_profit_and_transfer` action. It is not a flash-loan
lender or a generic DeFi adapter.

## Current mainnet deployment

The guard was published and then upgraded on Sui mainnet. These are public
identities, recorded so an operator can independently verify its active code
and capability custody before admitting it to a route:

| Item | Value |
| --- | --- |
| Original package | `0x1c89f1442b2dcebcfbbf226263c6f4228f4397edff700a0af0a31cef41677713` |
| Publish transaction | `9B5GKGTHSX1mztKoZmZeKLmGuQKfufnEATtFQs3VgwX6` |
| Active upgraded package | `0x96859191011298474c3e9944d52237083ce2b5a7065797036543fb8be9ed0c81` |
| Upgrade transaction | `2yi723GHkgiT3Tcg5JTkQZ7PrZPFjvKyuMwtUy9XboXp` |
| UpgradeCap | `0x955767b0cdec5fcd5677616cbb375a77ac17e221d44cc879087a952e502d9950` |
| AdminCap | `0xf76c8a06c4573ef287e003f80721c6f6b07e002299f32450bea5a43d16c21681` |
| OperatorCap | `0xff9bd93b0e58bc791764e8e6f285cd79528b28215207a759e83acc014de289fb` |
| PauseCap | `0x6de1de89863df57345b4fbfc8f936cd4773d983dfbc48468d6fe30dfc31a9a27` |
| Pause-cap setup transaction | `FeUaNk6MXioSL9qvJCfZqt6qsJfHcwjs2WqPuXxrZFix` |
| Deployer | `0xf6005efc186b6a4821375eff7d4f7f927132f5528e67421c1821d4917c70c30a` |

Capability object IDs are custody evidence, not secrets. Do not transfer,
share, or replace them during normal canary operation. A route must reference
the reviewed package and an operator-held `OperatorCap`; no unchecked package
ID should be inferred from a quote or an environment variable.

The active package adds an admin-controlled `PauseCap` without changing the
existing `OperatorCap` layout. New route builders must call
`assert_min_profit_and_transfer_with_pause`, not the legacy unpaused function.

## Wallet setup

Keep the deployer's Sui CLI keystore outside this repository. Select the
network and wallet with the Sui CLI, then copy only the public active address
into a local `.env` file:

```sh
sui client switch --env testnet
sui client active-address
```

Set these values in `.env` from `.env.example`:

```env
SUI_NETWORK=testnet
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
SUI_EXECUTION_MODE=testnet-canary
SUI_GUARD_PACKAGE_DIR=move/terminal-profit-guard
SUI_GAS_BUDGET_MIST=100000000
SUI_DEPLOYER_ADDRESS=0x... # must match `sui client active-address`
SUI_DEPLOY_CONFIRM=publish
```

`SUI_OPERATOR_PRIVATE_KEY` is optional and is used only by TypeScript paths
that need an in-memory signer. It must be a Bech32 `suiprivkey...` value and
is never passed to the Sui CLI or written to receipts.

To verify that optional signer without printing its secret, run:

```sh
npm run sui:wallet-address
```

## Mainnet canary setup

Mainnet publishing is supported only as an explicit canary. The publishing
utility compiles Move bytecode with the local Sui CLI, then uses the supported
Sui gRPC transport for chain-identifier verification, simulation, signing, and
submission. It independently compares the in-memory signer's public address
and the gRPC chain identifier with the local environment file.

Use the reviewed Sui mainnet chain identifier in a local `.env` file:

```env
SUI_NETWORK=mainnet
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
SUI_EXECUTION_MODE=mainnet-canary
SUI_GUARD_PACKAGE_DIR=move/terminal-profit-guard
SUI_GAS_BUDGET_MIST=...
SUI_DEPLOYER_ADDRESS=0x... # must match the active CLI address
SUI_CHAIN_IDENTIFIER=4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S
SUI_DEPLOY_CONFIRM=upgrade
SUI_MAINNET_DEPLOY_CONFIRM=I_UNDERSTAND_MAINNET_DEPLOYMENT
SUI_GUARD_PACKAGE_ID=0x... # current package held by UpgradeCap
SUI_GUARD_UPGRADE_CAP_ID=0x...
SUI_GUARD_ACTIVE_PACKAGE_ID=0x... # latest upgraded package for Move targets
SUI_GUARD_ADMIN_CAP_ID=0x...
SUI_GUARD_OPERATOR_CAP_ID=0x...
SUI_GUARD_PAUSE_CAP_ID=0x...
```

Set `SUI_OPERATOR_PRIVATE_KEY` only in the local environment used to publish;
it must decode to `SUI_DEPLOYER_ADDRESS`. The deploy command simulates first
and rejects a mismatched signer or chain identifier. Do not republish simply
to configure a route: use the recorded package above unless a reviewed upgrade
has explicitly been approved.

## Verify, build, publish, or upgrade

```sh
npm run sui:validate-config
sui move build --path move/terminal-profit-guard
npm run sui:deploy-guard
# For a reviewed existing package, set SUI_DEPLOY_CONFIRM=upgrade and the
# retained package/cap IDs, then use:
npm run sui:upgrade-guard
```

Each write command refuses an incorrect canary mode, a missing deployment
confirmation, a mismatched local signer/address, or, on mainnet, a mismatched
gRPC chain identifier. An upgrade additionally requires the exact retained
`UpgradeCap`, compiles the new package digest into its authorization ticket,
and simulates before signing. Capture the active package ID, `AdminCap`,
`OperatorCap`, and `PauseCap` in a reviewed manifest before connecting any
lender or venue adapter.

## Read-only venue admission

With fresh public pins in local `.env`, these commands collect no key material
and submit no transaction:

```sh
npm run sui:deepbook-flashloan-canary
npm run sui:cetus-pool-canary
```

The DeepBook canary only simulates `borrow_flashloan_base` followed by exact
repayment. The Cetus canary reads and validates the selected shared pool. A
cross-venue PTB remains deliberately disabled until a new route includes
freshly reviewed quotes, exact repayment and minimum-output bounds, an owned
DeepBook `DEEP` fee coin, and a positive terminal SUI-profit check.
