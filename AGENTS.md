# AGENTS.md

Monize is a personal finance manager (a Microsoft Money replacement). Four layers, each with its own `package.json`: `backend/` (NestJS + TypeORM), `frontend/` (Next.js App Router + React, Tailwind v4, Zustand), `database/` (`schema.sql` plus `migrations/`, PostgreSQL 16), `e2e/` (Playwright). `docs/` holds the cross-layer contracts, `helm/` the chart, `scripts/` the repo-level CI checks. Everything runs in Docker: `docker compose -f docker-compose.dev.yml up`. Versions are in the `package.json` files; the supported locales are `frontend/src/i18n/config.ts` and `backend/src/i18n/config.ts`.

This file is tool-agnostic and short on purpose. The rules live in `CLAUDE.md` (repo-wide), `backend/CLAUDE.md` and `frontend/CLAUDE.md` (indexes over `docs/backend/` and `docs/frontend/`), `database/CLAUDE.md` and `e2e/CLAUDE.md`. Read the layer file for the layer you touch, then only the documents its table sends you to.

## Commands

Run from the layer directory.

```bash
# backend/
npm run lint && npx tsc --noEmit && npm run typecheck   # lint, src-only tsc, tsc over src AND test
npm run test:unit -- <pattern>                            # Jest, src/**/*.spec.ts, no database; npm test takes no args
TZ=UTC npm run test:unit -- --coverage                    # what CI runs (95/94/95/85 thresholds)
npm run test:integration                                  # test/integration/*.spec.ts, real PostgreSQL, one worker
npm run migration:lint:test && npm run migration:lint     # migrations touched
npm run push:client:test && npm run push:tls:test         # backend/scripts push tooling touched
npm run i18n:pseudo && npm run i18n:check                 # after editing en/*.json (not a CI gate for the backend)

# frontend/
npm run lint && npm run type-check && npm run i18n:check
npm run test -- <pattern>                                 # focused; CI runs test:cov (91/90/87/85 thresholds)
npm run test:cov && npm run build                         # the gate; bundle size is checked on every PR

# e2e/  (stack: docker compose -f docker-compose.e2e.yml up -d --wait)
npm test -- --workers=1                                   # whole suite; a single spec file is safe without the flag
npm run test:push                                         # push suite, playwright.push.config.ts, needs no stack

# repo root
node scripts/check-env-docs.mjs                           # a new process.env / configService.get must be in .env.example
node scripts/check-docs-manifests.mjs                     # a doc naming a path, an npm script or a Helm default
node scripts/check-migration-prefixes.mjs                 # needs the base ref (full clone), silently skips in a shallow one
scripts/verify-schema.sh                                  # migrations replay as a no-op on schema.sql; Docker only
```

## Required before you push

Mirrors `.github/workflows/ci.yml`. Run the focused test while developing; run the gate for each layer you touched once, before pushing, and quote the result.

- `backend/`: the three lint/typecheck commands, `TZ=UTC npm run test:unit -- --coverage`, plus `migration:lint` when a migration changed and `npm run build && npm run test:integration` when a query, an entity, a migration or an RLS context changed.
- `frontend/`: `lint`, `type-check`, `i18n:check`, `test:cov`, `build`.
- A migration or `database/schema.sql`: `migration:lint`, `scripts/verify-schema.sh`, `node scripts/check-migration-prefixes.mjs`.
- An env var, a documented path or a Helm default: the two `scripts/check-*.mjs` above.
- A control an E2E spec drives was renamed or removed: grep `e2e/` for its accessible name; no unit suite loads those specs.
- **Stage new files first.** The guards that walk the tree with `git ls-files` cannot see an untracked file (`git add -N` is enough); green before staging and red in CI is not a flake.
- CI runs in UTC with one worker. The backend's database-backed suites rebuild one shared `monize_test` and never run in parallel with anything, including each other. `docs/verification-contract.md` section 7 explains the rest.
- The pre-commit hook (husky + lint-staged) runs `eslint --max-warnings=0 --fix` and prettier on staged files, which is stricter than CI's `lint`: a warning blocks the commit.

## Conventions you cannot infer from the code

- **i18n is English-first.** While a change is in development edit only `en/*` and regenerate the pseudo-locale; translate every other locale in one pass as the final commit on the same PR. A WIP branch failing parity is expected. Never hand-edit `xx/*`. Grep for a key before adding it.
- **`database/schema.sql` changes in the same commit as every migration.** New migrations are `YYYYMMDDHHMMSS_description.sql`; the checklist is in `database/CLAUDE.md`.
- **One database door.** All access goes through `withScopedDb`; never `@InjectRepository`, `createQueryRunner()`, `dataSource.transaction()` or a bare `dataSource.query(...)`. `CLAUDE.md` has the rule and the identity contexts.
- **A guard test is met by fixing the code.** Baselines, allowlists and grandfather lists are shrink-only. If a guard fires and you believe it is wrong, stop and report what it names.
- **A green suite after a behaviour change is a finding**: the change is a no-op or the suite had no case for it. Say which, and add the case in the same commit.
- **A total carries a value only when every component is known**; an unknown is `null`, a partial sum has its own named field, and a missing price or rate is never `0` or `1`.
- **A defect a human points out in AI-written code is a missing rule.** Fix it with the existing helper, add a regression test that fails on the original mistake, and write the rule down where `CLAUDE.md` says.
- No emojis anywhere, including commit messages and PR bodies. No `console.log`; the NestJS `Logger`. Immutability always. Many small files (200-400 lines typical, 800 max), organized by feature.
- **Security, do not regress:** parameterized SQL only; controllers under `AuthGuard('jwt')`; `userId` from the JWT, never from the request; `ParseUUIDPipe` on `:id`; DTOs with `whitelist` + `forbidNonWhitelisted` and bounded fields; `escapeHtml()` on every user value in an email template; secrets encrypted (AES-256-GCM) and never returned to the client.

## Do not change these casually

Each needs its own agreement, not a drive-by edit:

- `database/migrations/*` already merged to `main` (the tracker keys on the filename), and `database/schema.sql` without a paired migration or vice versa.
- Guard baselines, allowlists and thresholds: `WITH_CONTEXT_ALLOWLIST` and `OAUTH_PAYLOAD_ALLOWLIST` in `backend/eslint.config.mjs`, `RLS_EXEMPT_TABLES`, the ceilings in `backend/src/common/instruction-files.spec.ts`, `frontend/src/store/persisted-storage.guard.test.ts`, coverage thresholds, the Bearer exceptions in `.github/workflows/ci.yml`.
- Generated pseudo-locales `frontend/src/i18n/messages/xx/*` and `backend/src/i18n/locales/xx/*`.
- `.github/workflows/*`, `helm/`, `docker-compose*.yml`, `.env.example` removals, any `package-lock.json` (only as the product of an agreed dependency change).
- `docs/release-notes/` and `docs/audits/` are shipped records; `docs/adr/` is superseded, never rewritten.

## Git and PR workflow

- Branch off `main`; never commit to `main`, never force-push a shared branch, rebase on the latest `main` before review.
- Commit subjects are imperative, no trailing period, Conventional Commits with a scope where one fits (`fix(transactions): ...`, `feat(push): ...`, `docs(backend): ...`, `test(i18n): ...`); one logical change per commit, with its regression test and its doc line. AI-assisted commits carry a `Co-Authored-By:` trailer.
- **Propose first** (`CONTRIBUTING.md`): open a Discussion, get the approach agreed, then implement exactly what was agreed, one concern per PR.
- The PR body is the template in `.github/pull_request_template.md` with every box ticked, a linked discussion or issue carrying the `approved-to-build` label, the invariant IDs touched, and the AI-assistance disclosure. `.github/workflows/pr-checklist.yml` fails a PR that misses any of the first three (maintainer-authored PRs bypass the label).

## Autonomous work

Do without asking: read and search anything; run lint, typecheck, unit tests, focused tests, formatters and the check scripts; create a feature branch; stage and commit on it; regenerate the pseudo-locale after editing `en/*`.

Ask first: any destructive git operation (force-push, `reset --hard`, deleting a branch, rebasing a pushed branch); deleting, skipping or quarantining a test; weakening a guard, allowlist, baseline or threshold; a schema or migration change beyond the agreed task; adding or upgrading a dependency; anything under `.github/`, `helm/` or the release path; opening a PR or pushing to a branch you did not create.

While working: change what was asked and the tests that prove it; report an unrelated defect instead of fixing it in passing. Run the focused test while developing and the gate once before pushing; do not re-run the same suite hoping for a different result. When a guard fails, stop and report what it names rather than routing around it. Keep output short: the diff and what you verified, not a transcript.

## Where the detailed rules live

| Subject | Read |
|---|---|
| Repo-wide critical rules: database door, transactions, financial math, i18n, how these files are organised | `CLAUDE.md` |
| Backend and frontend rules, per subject | `backend/CLAUDE.md`, `frontend/CLAUDE.md`, then `docs/backend/*.md`, `docs/frontend/*.md` |
| Migrations, RLS policy buckets, schema conventions | `database/CLAUDE.md`, `docs/database-migrations.md` |
| E2E suite conventions | `e2e/CLAUDE.md` |
| Invariant catalog and enforcement status | `docs/system-invariants.md` |
| Money, concurrency, side effects, verification, guard tests | `docs/financial-semantics.md`, `docs/financial-calculation-contract.md`, `docs/concurrency-and-idempotency.md`, `docs/external-side-effects.md`, `docs/verification-contract.md`, `docs/testing-contract.md`, `docs/guard-tests.md` |
| Why a decision was made; plans not yet built | `docs/adr/`, `docs/future-plans/` |
| Contribution process, vulnerability reports | `CONTRIBUTING.md`, `SECURITY.md` |
