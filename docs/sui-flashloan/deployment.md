# Sui terminal-profit guard deployment

The Move package at `move/terminal-profit-guard` is the only contract this
repository deploys. It holds an admin capability, an operator capability, and
the terminal `assert_min_profit_and_transfer` action. It is not a flash-loan
lender or a generic DeFi adapter.

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

Mainnet publishing is supported only as an explicit canary. The CLI itself must
point at mainnet, and the utility independently compares its active network,
active address, and chain identifier with the local environment file.

```sh
sui client new-env --alias=mainnet --rpc https://fullnode.mainnet.sui.io:443
sui client switch --env mainnet
sui client active-address
sui client chain-identifier
```

Then use the returned chain identifier verbatim in a local `.env` file:

```env
SUI_NETWORK=mainnet
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
SUI_EXECUTION_MODE=mainnet-canary
SUI_GUARD_PACKAGE_DIR=move/terminal-profit-guard
SUI_GAS_BUDGET_MIST=...
SUI_DEPLOYER_ADDRESS=0x... # must match the active CLI address
SUI_CHAIN_IDENTIFIER=...  # must match `sui client chain-identifier`
SUI_DEPLOY_CONFIRM=publish
SUI_MAINNET_DEPLOY_CONFIRM=I_UNDERSTAND_MAINNET_DEPLOYMENT
```

## Verify, build, and publish

```sh
npm run sui:validate-config
sui move build --path move/terminal-profit-guard
npm run sui:deploy-guard
```

The last command refuses an incorrect canary mode, a missing deployment
confirmation, a mismatched Sui CLI active network/address, or, on mainnet, a
mismatched chain identifier. Capture the published package ID, `AdminCap`, and
`OperatorCap` object IDs in a reviewed manifest before connecting any lender
or venue adapter.
