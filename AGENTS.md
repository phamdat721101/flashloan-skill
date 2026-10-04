# Repository Guidelines

## Project Structure & Module Organization

This repository is currently a scaffold: it has no application source, tests, package manifest, or build configuration. Keep future code organized by responsibility. Recommended baseline:

- `src/` for production source code.
- `tests/` for automated tests that mirror `src/` paths.
- `assets/` for static, non-code resources.
- `scripts/` for repeatable developer and release tasks.
- `docs/` for design notes and operational documentation.

Do not commit generated output, local secrets, or dependency directories. Document new top-level directories here when they become part of the project contract.

## Build, Test, and Development Commands

No build, test, formatter, linter, or local-development commands are configured yet. When adding tooling, expose common workflows through the project’s task runner and document them here. For example:

```sh
npm run dev      # start local development
npm test         # run the full test suite
npm run lint     # check code style and static issues
npm run build    # produce a production build
```

Commands should run from the repository root and avoid unrecorded global dependencies.

## Coding Style & Naming Conventions

Follow the formatter and linter selected for the implementation language. Use two spaces for JSON, YAML, and Markdown unless the formatter says otherwise. Name files and directories descriptively in `kebab-case` (for example, `transaction-parser.ts`); use language-standard conventions for types, functions, and constants. Keep modules focused and avoid duplicate utility logic.

## Testing Guidelines

Add tests with every behavior change once a test framework is introduced. Place them under `tests/` or adjacent to the module if required by the framework. Use behavior-oriented names such as `rejects an expired rollover request`. Include failure and boundary cases, and run the relevant test command before a pull request.

## Commit & Pull Request Guidelines

No Git history is available in this scaffold. Until a convention is established, write short imperative subjects, such as `Add rollover validation`. Keep each commit focused. Pull requests should describe intent, tests, configuration changes, and follow-up work; link the issue and include screenshots for user-visible changes.

## Security & Configuration

Keep credentials in local environment files excluded from version control. Provide a checked-in `.env.example` with placeholders and document required configuration keys without exposing secrets.
