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
Use $flashloan-agent to validate my configuration and simulate an opportunity file without exposing secrets.
```

For a configured executor and dedicated wallet, ask the agent to execute a schema-valid opportunity file. The runtime verifies the chain and executor, simulates immediately before broadcast, enforces configured risk limits, persists realized losses, and prevents concurrent sends.

## Configuration

Copy `.env.example` to `.env`. Keep `OPERATOR_PRIVATE_KEY` only in your local environment; never put credentials in prompts, JSON input, or Git. Validate safely with:

```sh
node dist/cli.js validate-config
```

The runtime accepts exact executor-ready opportunities matching `schemas/opportunity.schema.json`.
