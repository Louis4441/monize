# Horizontal Scaling: Agent Task List

> Companion to [`horizontal-scaling.md`](./horizontal-scaling.md) (the design).
> This file breaks the plan into tasks sized for one AI-agent session each. Do
> the tasks in dependency order; never start a task whose dependencies are
> unmerged. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files
  outside the task's scope is a scope violation -- stop and leave a note
  instead.
- **Every task lands behind `CLUSTER_MODE=single`** (the default; unset env is
  `single`) and must leave observable behaviour there unchanged except where
  the task's acceptance says otherwise (the `neutral` tasks make state durable
  across a restart, which is a deliberate, named change).
- **Definition of done for every task** (in addition to per-task acceptance):
  - `cd backend && npm run build && npm run lint` clean.
  - `npm run test:unit` green; new code covered.
  - Where the task claims a PostgreSQL property (one winner, atomic increment),
    a two-connection spec under `backend/test/integration/` and
    `npm run test:integration` green. A unit test with a mocked manager does not
    discharge this.
  - Migrations mirrored into `database/schema.sql` in the same PR; any new SQL
    function registered in `backend/src/common/db/required-db-functions.ts`.
  - New env vars in `.env.example`; new `@Cron` rows in `docs/cron-jobs.md`.
  - No new user-facing strings. If one is unavoidable it goes through `tr()`
    and the English catalogs, then `npm run i18n:pseudo`.
- **Terminology:** "the design doc" = `horizontal-scaling.md`. Work-package
  references (WP1, WP5) point there.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | CI, tests, lint, docs, or code nothing calls yet. The running app is behaviourally identical. |
| **neutral** | Rewrites a live path so that state which used to live in process memory lives in PostgreSQL. Same limits, same outcomes, now durable across restarts and shared across replicas. Normal regression risk; full suites are the gate. |
| **multi-only** | Code that runs only when `CLUSTER_MODE=multi`. A `single` deployment cannot reach it. |

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| F1 | `CLUSTER_MODE` parsing (`backend/src/common/cluster/cluster-mode.ts`), boot-matrix check as a pure function, `main.ts` refusal/warning wiring, `JWT_SECRET` fatal in every mode, `.env.example` | -- | none (`single` unchanged; the `JWT_SECRET` refusal is the one deliberate exception, called out in the release note) | [ ] |
| F2 | `ClusterModule` (global): mode provider; in `multi`, one `ioredis` client and one subscriber connection with `REDIS_URL` / `REDIS_KEY_PREFIX`; `PING` at boot; readiness probe extension in `backend/src/health/health.controller.ts` | F1 | multi-only | [ ] |
| F3 | Doc corrections: `docs/concurrency-and-idempotency.md` section 8 (auto-posting and demo reset are claimed), `docs/external-side-effects.md` (reminders dedupe, backup uses `writeFileAtomic`), `docs/cron-jobs.md` note on `CLUSTER_MODE` | -- | none | [ ] |
| F4 | ADR `0005` (cluster mode and optional Redis; alternatives: PostgreSQL `LISTEN`/`NOTIFY`, sticky routing, always-on Redis), index row in `docs/adr/README.md` | F1 | none | [ ] |
| A1 | Migration + `schema.sql`: `auth_attempt_counters`, `single_use_tokens`; RLS exemption with reason in `docs/row-level-security-contract.md` and `RLS_EXEMPT_TABLES`; daily sweep cron | -- | none (tables nothing reads yet) | [ ] |
| A2 | `AuthAttemptCounterService` (atomic upsert `RETURNING count`); `two-factor.service.ts` attempt maps replaced; two-connection spec proves both concurrent increments count | A1 | neutral | [ ] |
| A3 | `usedTotpCodes` replaced by a `single_use_tokens` claim (purpose `totp`); two-connection spec proves one winner for one code | A1 | neutral | [ ] |
| A4 | `step-up.service.ts` and `auth-email.service.ts` counters onto `AuthAttemptCounterService`; the `setInterval` prune in `auth-email.service.ts` removed | A2 | neutral | [ ] |
| A5 | `users.failed_login_attempts` atomic increment; counter write in its own `withScopedDb` after the login decision; CONC register entry closed | -- | neutral | [ ] |
| K1 | `oauth_instance_config` migration + `OauthSigningKeysService` (insert-as-arbiter, `ENCRYPTION_KEY`-encrypted JWKS); `oauth-provider.service.ts` passes `jwks`; spec: two instances, one key id; OAuth E2E verifies an ID token after restart | -- | neutral | [ ] |
| X1 | AI action anti-replay: `consumed` map to `single_use_tokens` (purpose `ai-action`) inside the applying transaction; MCP confirmation path routed through the same claim; two-connection spec | A1 | neutral | [ ] |
| R1 | `EVENT_BUS` token + interface + `MemoryEventBus`, wired as the default; no consumers yet | -- | none | [ ] |
| R2 | `ai_relay_prompts` and `ai_relay_agents` migrations + `schema.sql`; RLS policy by `user_id` | -- | none | [ ] |
| R3 | Relay queue on rows: browser insert + subscribe, agent claim via `FOR UPDATE SKIP LOCKED ... RETURNING`, conditional answer update; `pending`/`inFlight`/`waiters` removed; two-connection spec (two agent polls, one claim) | R1, R2 | neutral | [ ] |
| R4 | Late answers and buffered action cards as rows with TTL sweep; `buffered`/`awaitingLate`/`bufferedActions` removed; liveness columns on `ai_relay_agents` via `runOutsideActiveScopedManager` | R3 | neutral | [ ] |
| R5 | Relay attachments through `ATTACHMENT_STORAGE_PROVIDER` with a `relay/` prefix and TTL row; `relay-attachment.store.ts` reduced to a facade or deleted | R3 | neutral | [ ] |
| R6 | `RedisEventBus` on the `ClusterModule` subscriber connection; selected in `multi`; two-instance integration spec (subscribe on A, publish on B) against the CI Redis service | F2, R1, D3 | multi-only | [ ] |
| T1 | `RedisThrottlerStorage` implementing `ThrottlerStorage` (Lua or `MULTI`), fail-open with rate-limited log; `ThrottlerModule.forRootAsync` selects by mode; integration spec: limit holds across two storage instances | F2, D3 | multi-only | [ ] |
| M1 | MCP 2025-era sessions: read the SDK and decide persisted `mcp_sessions` vs documented sticky routing; implement the chosen one; two-instance spec if persisted | F1 | neutral | [ ] |
| S1 | Boot refusals in `multi` for `local` attachments without `ATTACHMENT_SHARED_VOLUME=true` and backups without `BACKUP_SHARED_VOLUME=true`; table-driven boot-matrix spec | F1 | multi-only | [ ] |
| S2 | S3 backup target for automatic backups (write, list, retention, promotion) reusing the S3 client and deadline from `s3-storage.provider.ts`; `BACKUP_STORAGE_PROVIDER` env; keeps the `shardedSegments(userId)` prefix layout | -- | none until selected | [ ] |
| C1 | `claimLease` around budget period rollover (`JobClaimType` member, doc row, two-connection spec: one runner) | -- | neutral | [ ] |
| C2 | `claimLease` around exchange-rate startup sweep and 17:05 fetch, security price fetch, market index fetch; cooldown pattern from `market-index.service.ts` for the startup sweep | -- | neutral | [ ] |
| C3 | `updates.service.ts` release cache to a one-row table; every replica answers the same | -- | neutral | [ ] |
| C4 | Demo seed step under the lifecycle advisory lock (`db-demo-check`, `seed` take `DB_LIFECYCLE_LOCK_KEY`); `PRE_BOOT_SCRIPTS` in `startup-logging.spec.ts` updated | -- | neutral (demo only) | [ ] |
| G1 | `process-local-state.guard.spec.ts`: whole-tree `Map`/`Set` field scan with the allowlist from the design doc's "Per-replica state that stays" table; every remaining entry has a reason | A4, X1, R4 | none | [ ] |
| G2 | `INV-HA-001..005` entries in `docs/system-invariants.md` and rows in `docs/verification-contract.md`; parity guard green | A3, K1, R3, S1 | none | [ ] |
| D1 | Helm: StatefulSets to Deployments, `replicas`, `podDisruptionBudget`, `topologySpreadConstraints`, optional `autoscaling`, `clusterMode`, `redis.url` (Secret-backed), `NOTES.txt` guidance for ReadWriteMany; lint job renders both modes | F2 | none (defaults unchanged) | [ ] |
| D2 | `docker-compose.ha.yml` example: `deploy.replicas`, no `container_name`, `redis` service, reverse proxy | F2 | none | [ ] |
| D3 | CI: digest-pinned `redis` service and `REDIS_URL` in the `backend-integration-tests` job of `.github/workflows/ci.yml` | -- | none | [ ] |
| D4 | E2E: `redis` service in `docker-compose.e2e.yml`; one shard runs `CLUSTER_MODE=multi` with two backend replicas behind the frontend proxy; relay and login-lockout specs pass across replicas | R6, T1, D1 | none | [ ] |

## Suggested order

1. F1, F3, A1, R1, R2, D3 (no behaviour change, unblock everything).
2. A2, A3, A4, A5, X1, K1, C1, C2, C3, C4 (the `neutral` durability fixes; each
   improves a single-replica deployment on its own).
3. R3, R4, R5, M1 (relay and MCP on rows).
4. F2, T1, R6, S1, D1, D2 (the `multi` enablers), then G1, G2, F4.
5. D4 (the proof), then S2.
