# AGENTS.md

## Purpose
Guidance for coding agents working in this repository. Prioritize ingestion reliability and keep schema/tool interfaces stable.

## Environment Defaults
- Runtime: Node.js 24
- Package manager: Yarn 4
- Install deps from repo root: `yarn install`
- Project uses Yarn workspaces (root-managed monorepo)
- Database container target: Postgres 18

## Repository Structure
- `collector/`: Home Assistant websocket collector package
- `collector/src/`: collector runtime code
- `collector/tests/`: collector unit/integration tests
- `tools/`: analytics/tool package
- `tools/src/`: tool/query interfaces and analytics job
- `tools/tests/`: tool integration tests
- `schema/`: additive SQL migrations
- `docker-compose.yml`: local stack

## Command Reference
Run from repo root:
- Build: `yarn build`
- Tests: `yarn test`
- Verify all checks: `yarn verify`
- Lint: `yarn lint`
- Format: `yarn format`
- Type check: `yarn lint:type`
- Run collector: `yarn start:collector`
- Run analytics: `yarn start:analytics`

Package-specific:
- Collector: `yarn workspace @ha-ai/collector <script>`
- Tools: `yarn workspace @ha-ai/tools <script>`

## Core Invariants
1. Collector must authenticate against HA websocket and subscribe by configured event type.
2. Collector must tolerate interleaved websocket frames and correlate `result` acks by `id`.
3. Collector must batch inserts and flush on shutdown.
4. Domain allowlist/excludelist filtering must be enforced before writes.
5. Event ingestion must remain idempotent via `dedupe_key`.

## Database Rules
- Keep `schema/001_init.sql` as baseline.
- Add only additive migration files for new schema/index changes.
- Avoid destructive changes unless explicitly requested.

## Tooling Rules
- `getDailySummary`, `getTopChanges`, and `traceContext` are implemented paths and must remain stable.
- Keep non-priority tools explicitly stubbed with typed `status: "stub"` payloads until requested.
- `publishReport` should persist to `analysis_results` when a DB client is provided.
- Prefer latest stable package versions when adding or updating dependencies.
- When asked to upgrade dependencies, upgrade to the latest available versions unless the user explicitly asks for pinned/older versions.
- Keep `biome.json` aligned with the installed Biome major version (run `yarn biome migrate --write` after major Biome upgrades).

## Testing Expectations
- Collector changes should include protocol tests plus ingest write-path validation.
- Tool query changes should include DB-backed integration tests (skip cleanly if `TEST_DATABASE_URL` missing).
- Golden output tests in `tools/tests/goldenOutputs.test.ts` should be updated when changing output contracts.

## CI Expectations
- GitHub Actions workflow is defined in `.github/workflows/ci.yml`.
- `verify` job must run `yarn verify` on push to `main` and pull requests.
- `integration-tests` job must run `yarn test` with `TEST_DATABASE_URL` against Postgres 18 so DB-backed suites execute in CI.

## Dependency Update Automation
- Dependabot configuration is defined in `.github/dependabot.yml`.
- Dependabot should monitor npm (Yarn workspaces), GitHub Actions, Docker Compose, and collector Dockerfile dependencies.
- Auto-merge workflow is defined in `.github/workflows/dependabot-automerge.yml`.
- Auto-merge must remain limited to Dependabot semver patch/minor updates and must rely on required CI checks before merge.

## Delivery Checklist
1. Update code + tests together.
2. Run relevant checks (`yarn build`, `yarn test`) when dependency resolution is available.
3. Update docs and compose/env docs for behavior/config changes.
4. Report any skipped checks and why.
5. After taking actions that change behavior, tooling, dependencies, or runtime versions, update both `README.md` and `AGENTS.md` in the same change.
