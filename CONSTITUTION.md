# Constitution

## Tech stack and tooling

- Supported stack: Node.js 20+, TypeScript, and viem.
- Canonical checks: `npm test` and `npm run typecheck`.

## Architectural invariants

- Keep application behavior, infrastructure boundaries, and data ownership explicit in each feature brief.
- Do not introduce a new integration, persistence boundary, or generated artifact without documenting it in that feature brief.
- Data-model locations: `schemas/` for JSON Schema and `src/types.ts` for runtime TypeScript types.

## Agentic contract

- Do not write application code while preparing this workspace harness.
- Before ending, being interrupted, or switching tasks, append a structured handoff to `docs/state/active_session.md`.
- Read this constitution, the relevant feature brief, and the final handoff snapshot before starting work.
- Run the project test command before declaring a feature complete.

## Definition of done

- Feature acceptance criteria pass.
- Relevant tests and verification commands pass.
- The final handoff snapshot records outcome, blockers, attempted solutions, and next steps.

## Human review required

- Keep the dependency surface limited to `viem`; use Node's built-in test runner.
