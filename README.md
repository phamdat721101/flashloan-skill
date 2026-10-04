# Flashloan Agent Skill

Install a prompt-driven Arbitrum flashloan skill for Codex agents.

## Install

```sh
npm install
npm run build
node dist/agent-cli.js install
```

Restart the agent session, then use:

```text
Use $flashloan-agent to scan Aave, Morpho, Balancer, and Uniswap v4 using my scanner configuration without exposing secrets.
```

For a configured executor and dedicated wallet, ask the agent to execute a schema-valid opportunity file. The runtime verifies the chain and executor, simulates immediately before broadcast, enforces configured risk limits, persists realized losses, and prevents concurrent sends.

## Configuration

Copy `.env.example` to `.env`. Keep `OPERATOR_PRIVATE_KEY` only in your local environment; never put credentials in prompts, JSON input, or Git. Validate safely with:

```sh
node dist/cli.js validate-config
```

The runtime accepts exact executor-ready opportunities matching `schemas/opportunity.schema.json`.

## Read-only real-time scanning

Scanning is separate from execution. It needs a public Arbitrum RPC and no wallet, executor address, or private key. Create a secret-free configuration such as:

```json
{
  "chainId": 42161,
  "rpcUrl": "https://your-arbitrum-rpc.example",
  "startBlock": "123456789",
  "assetAllowlist": ["0x0000000000000000000000000000000000000001"],
  "protocols": {
    "aaveV3": { "pool": "0x0000000000000000000000000000000000000001" },
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

The scanner emits `schemas/scan-envelope.schema.json` records. Its intents describe protocol-specific requirements, including Balancer Vault callbacks and Uniswap v4 `unlock` delta settlement; they are not directly executable calldata.

To run the opt-in live E2E without credentials, point `E2E_ARBITRUM_SCANNER_CONFIG` at a bounded scanner configuration and run `npm test`. The test asserts a real finalized-block envelope and accepts zero opportunities; it never signs or broadcasts.
