# Repository Guidelines

## Project Structure & Module Organization

This repository contains a TypeScript agent, Rust scanner, Solidity executors and Sui Move guard.

- `src/` contains production TypeScript; `src/test/` contains Node tests.
- `src/evm/` contains shared EVM deployment, budget, discovery and acceptance logic.
- `crates/` contains the Rust scanner and engine.
- `contracts/` and `test/` contain Solidity and Foundry tests.
- `schemas/` and `config/` hold versioned public contracts and configuration.
- `scripts/` holds repeatable local proof and root-verification adapters.
- `docs/` holds design and public deployment evidence. `.nim/` is local state.

Do not commit generated output, local secrets, or dependency directories.

## Build, Test, and Development Commands

```sh
npm run build      # TypeScript artifacts
npm run typecheck  # TypeScript static checks
npm test           # Forge build, Node tests and Rust workspace tests
npm run evm:test   # focused EVM tests and compiled ABI parity
forge test         # Solidity unit tests; real forks require explicit opt-in
```

Node 20+, Rust and Foundry are required. Live fork and deployment commands need
explicit RPC access; default local tests do not establish profitable live execution.

## Coding Style & Naming Conventions

Follow the formatter and linter selected for the implementation language. Use two spaces for JSON, YAML, and Markdown unless the formatter says otherwise. Name files and directories descriptively in `kebab-case` (for example, `transaction-parser.ts`); use language-standard conventions for types, functions, and constants. Keep modules focused and avoid duplicate utility logic.

## Testing Guidelines

Add tests with every behavior change once a test framework is introduced. Place them under `tests/` or adjacent to the module if required by the framework. Use behavior-oriented names such as `rejects an expired rollover request`. Include failure and boundary cases, and run the relevant test command before a pull request.

## Commit & Pull Request Guidelines

Write short imperative subjects, such as `Add rollover validation`. Keep each commit focused. Pull requests should describe intent, tests, configuration changes, and follow-up work; link the issue and include screenshots for user-visible changes.

## Security & Configuration

Keep credentials in local environment files excluded from version control. Provide a checked-in `.env.example` with placeholders and document required configuration keys without exposing secrets.
