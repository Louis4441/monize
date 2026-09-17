# Horizontal Scaling: Agent Task List

> Companion to [`horizontal-scaling.md`](./horizontal-scaling.md) (the design).
> This file breaks the plan into tasks sized for one AI-agent session each. Do
> the tasks in dependency order; never start a task whose dependencies are
> unmerged. Mark a task done by checking its box in the graph, and note the PR
> in the task's Status line.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files under **Scope**.
  Touching files outside that scope is a scope violation -- stop and leave a
  note in the task's **Notes** instead. If a task turns out to need a file it
  did not list, add the file to Scope in the same PR and say why.
- **Every task lands behind `CLUSTER_MODE=single`** (the default; unset env is
  `single`) and must leave observable behaviour there unchanged, except where
  the task's acceptance names a deliberate change (the `neutral` tasks make
  state durable across a restart).
- **Read before writing.** Every task names the file whose pattern it copies.
  Open that file first; the shape there is the rule.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `cd backend && npm run build && npm run lint` clean.
  - `TZ=UTC npm run test:unit` green (run from `backend/`); new code covered.
  - Where the task claims a PostgreSQL property (one winner, atomic
    increment), a two-connection spec under `backend/test/integration/` and
    `npm run test:integration` green. A unit test with a mocked manager does
    not discharge this (`docs/verification-contract.md`, VER-001).
  - Migrations: file named `date -u +%Y%m%d%H%M%S`_description.sql per
    `docs/database-migrations.md`, every statement idempotent (`IF NOT
    EXISTS`, `DROP ... IF EXISTS` before `CREATE POLICY`/`TRIGGER`), mirrored
    into `database/schema.sql` in the same PR, `npm run migration:lint` clean,
    and `scripts/verify-schema.sh` green (needs Docker).
  - Any new SQL function registered in
    `backend/src/common/db/required-db-functions.ts`.
  - New env vars in `.env.example` (the `Documentation vs Manifests` CI job
    scans for them); new `@Cron` rows in `docs/cron-jobs.md` (verbatim
    expression, `backend/src/common/cron-doc.spec.ts` checks it).
  - A new `withSystemContext` / `withUserContext` call site means adding the
    file to `WITH_CONTEXT_ALLOWLIST` in `backend/eslint.config.mjs` as a
    reviewed decision.
  - No new user-facing strings. If one is unavoidable it goes through `tr()`
    and the English catalogs, then `npm run i18n:pseudo`.
  - Stage new files (`git add -N`) before running the doc and tree guards;
    they list subjects with `git ls-files`.
- **Terminology:** "the design doc" = `horizontal-scaling.md`. Work-package
  references (WP1, WP5) point there. "Two-connection spec" means two real
  PostgreSQL connections interleaved in one test, the pattern in
  `backend/test/integration/mny-import-job.integration.spec.ts`.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | CI, tests, lint, docs, or code nothing calls yet. The running app is behaviourally identical. |
| **neutral** | Rewrites a live path so that state which used to live in process memory lives in PostgreSQL. Same limits, same outcomes, now durable across restarts and shared across replicas. Normal regression risk; full suites are the gate. |
| **multi-only** | Code that runs only when `CLUSTER_MODE=multi`. A `single` deployment cannot reach it. |

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| F1 | `CLUSTER_MODE` parsing, boot-matrix check, `main.ts` wiring, `JWT_SECRET` fatal, `.env.example` | -- | none (`JWT_SECRET` refusal is the one deliberate exception) | [x] |
| F2 | `ClusterModule`: mode provider, Redis client and subscriber in `multi`, `PING` at boot, readiness probe | F1 | multi-only | [ ] |
| F3 | Doc corrections in `concurrency-and-idempotency.md`, `external-side-effects.md`, `cron-jobs.md` | -- | none | [x] |
| F5 | Concurrency register: retire the stale `users.failed_login_attempts` gap row | -- | none | [x] |
| F4 | ADR 0005 and index row | F1 | none | [ ] |
| A1 | Migration: `auth_attempt_counters`, `single_use_tokens`; RLS exemption; sweep cron | -- | none | [x] |
| A2 | `AuthAttemptCounterService`; 2FA attempt maps replaced | A1 | neutral | [ ] |
| A3 | `usedTotpCodes` replaced by a `single_use_tokens` claim | A1 | neutral | [ ] |
| A4 | Step-up and auth-email counters onto the service; interval prune removed | A2 | neutral | [ ] |
| K1 | `oauth_instance_config` + `OauthSigningKeysService`; provider gets `jwks` | -- | neutral | [ ] |
| X1 | AI action anti-replay onto `single_use_tokens`, MCP path included | A1 | neutral | [ ] |
| R1 | `EVENT_BUS` token, interface, `MemoryEventBus` wired as default | -- | none | [x] |
| R2 | Migration: `ai_relay_prompts`, `ai_relay_agents` with RLS policies | -- | none | [x] |
| R3 | Relay queue on rows: insert, claim, answer; in-memory queue maps removed | R1, R2 | neutral | [ ] |
| R4 | Late answers, buffered actions and agent liveness on rows; remaining maps removed | R3 | neutral | [ ] |
| R5 | Relay attachments through the attachment storage provider | R3 | neutral | [ ] |
| R6 | `RedisEventBus`; selected in `multi`; two-instance spec | F2, R1, D3 | multi-only | [ ] |
| T1 | `RedisThrottlerStorage`; selected in `multi`; fail-open | F2, D3 | multi-only | [ ] |
| M1 | MCP 2025-era sessions: persisted rows or documented sticky routing | F1 | neutral | [ ] |
| S1 | Boot refusals in `multi` for per-pod attachments and backups | F1 | multi-only | [ ] |
| S2 | S3 backup target for automatic backups | -- | none until selected | [ ] |
| C1 | `claimOnce` per owner and month around budget period rollover | -- | neutral | [ ] |
| C2 | Deployment-wide `fetch_sync` lease around FX, security price and market index fetches | -- | neutral | [ ] |
| C3 | Release-check cache to a one-row table | -- | neutral | [ ] |
| C4 | Demo seed under the lifecycle advisory lock | -- | neutral (demo only) | [ ] |
| G1 | Whole-tree process-local-state guard with allowlist | A4, X1, R4 | none | [ ] |
| G2 | `INV-HA-001..005` in both contract docs | A3, K1, R3, S1 | none | [ ] |
| D1 | Helm: Deployments, PDB, spread, autoscaling, `clusterMode`, `redis.url` | F2 | none (defaults unchanged) | [ ] |
| D2 | `docker-compose.ha.yml` example | F2 | none | [ ] |
| D3 | CI: `redis` service in the integration job | -- | none | [x] |
| D4 | E2E: one shard on `CLUSTER_MODE=multi` with two backends | R6, T1, D1 | none | [ ] |

## Suggested order

1. F1 and F3 (done), F5, A1, R1, R2, D3 (no behaviour change, unblock
   everything).
2. A2, A3, A4, X1, K1, C1, C2, C3, C4 (the `neutral` durability fixes; each
   improves a single-replica deployment on its own).
3. R3, R4, R5, M1 (relay and MCP on rows).
4. F2, T1, R6, S1, D1, D2 (the `multi` enablers), then G1, G2, F4.
5. D4 (the proof), then S2.

---

## Task details

Each task has: **Scope** (the files it may touch), **Pattern** (the existing
file whose shape it copies), **Steps**, **Acceptance** (what proves it done),
**Tests** (what to write), and **Traps** (what has gone wrong before in this
codebase for this shape of change). **Status** and **Notes** are for the agent
doing the work.

### F1 -- `CLUSTER_MODE` parsing, boot-matrix check, `main.ts` wiring

- [x] Status: done (commits `9612aa78`, `8e40e06c`).

**What shipped** (read these before any task that depends on F1):

- `backend/src/common/cluster/cluster-mode.ts`: `CLUSTER_MODES`,
  `DEFAULT_CLUSTER_MODE`, `MIN_JWT_SECRET_LENGTH`,
  `parseClusterMode(raw)` (throws on an unrecognized value),
  `getClusterMode()`, and `checkClusterBoot(env: ClusterBootEnv): ClusterBootReport`
  where `ClusterBootEnv` is `{ CLUSTER_MODE?, REDIS_URL?, JWT_SECRET? }` and
  the report is `{ mode, refusals, warnings }`. Pure; reads no `process.env`.
- `backend/src/main.ts`: `assertClusterBootOrExit()` with
  `new Logger("ClusterMode")`, called before `app.listen`; it names each env
  var it passes one by one, so a new matrix input is added to that call as
  well as to `ClusterBootEnv`.
- `.env.example`: `CLUSTER_MODE` and `REDIS_URL` documented in the
  `Application` section. `REDIS_KEY_PREFIX` (F2), `ATTACHMENT_SHARED_VOLUME`
  and `BACKUP_SHARED_VOLUME` (S1) are **not** there yet.
- `backend/src/common/cluster/cluster-mode.spec.ts`: the table-driven matrix.

**Notes:** the storage refusals in the design doc's boot matrix were left to
S1; the compose files carry no explicit `CLUSTER_MODE` (unset is `single`).

### F2 -- `ClusterModule` and the Redis connection

- [ ] Status:

**Scope:** `backend/src/common/cluster/cluster.module.ts` (new),
`backend/src/common/cluster/cluster.module.spec.ts` (new),
`backend/src/common/cluster/redis-client.provider.ts` (new),
`backend/src/app.module.ts`, `backend/src/health/health.controller.ts`,
`backend/src/health/health.controller.spec.ts`, `backend/src/health/health.module.ts`,
`backend/package.json` (`ioredis`), `backend/src/main.ts` (the `PING`).

**Pattern:** `backend/src/common/demo-mode.module.ts` (a two-provider
`@Global()` module) for the module; `backend/src/notifications/email.service.ts`
`onModuleInit` for "configured or not, logged once".

**Steps:**

1. Add `ioredis` (pin an exact version; the `License Compliance` CI job
   checks its licence, there is no local script).
2. `redis-client.provider.ts` exports two tokens, `REDIS_CLIENT` and
   `REDIS_SUBSCRIBER`, and a factory that returns `null` for both in `single`
   and two `ioredis` instances in `multi` (`lazyConnect: false`,
   `keyPrefix: REDIS_KEY_PREFIX`, `maxRetriesPerRequest: 1`, `enableOfflineQueue: false`
   so a lost Redis fails fast rather than queueing). The subscriber is a
   separate connection because a connection in subscribe mode cannot run
   commands.
3. `cluster.module.ts`: `@Global()`, provides `CLUSTER_MODE` (the parsed
   value from `getClusterMode()` in `cluster-mode.ts`) and the two clients;
   `onModuleDestroy` quits both. Document `REDIS_KEY_PREFIX` in
   `.env.example` beside `REDIS_URL`.
4. `main.ts`: after the F1 check, in `multi` only, `await client.ping()` with a
   5 s timeout; failure refuses the boot with the URL's host (never the
   password) in the message.
5. `health.controller.ts`: `ready()` in `multi` also pings Redis; failure is
   `503` like the database. `check()` reports `checks.redis` in `multi` and
   omits it in `single`. `live()` is untouched.

**Acceptance:** in `single` the module registers nulls and Redis is never
dialled (assert with a spy that the factory returned `null`). In `multi`
readiness goes 503 when Redis stops and recovers when it returns.

**Tests:** module spec for both modes with the client factory mocked;
`health.controller.spec.ts` gains `ready()` rows for `multi` with Redis up and
down, and asserts `single` never calls the client.

**Traps:** `backend/src/module-graph.spec.ts` fails a new module edge that
creates a require cycle without `forwardRef`; a `@Global()` module imported
only by `AppModule` avoids it. `ioredis` logs to `console` on some errors;
attach an `error` listener that forwards to `Logger` so `no-console` and
`startup-logging.spec.ts` stay green. Never put the URL with credentials in
a log line.

**Notes:**

### F3 -- Doc corrections

- [x] Status: done (commit `dc361624`).

**What shipped:** scheduled auto-posting and the demo reset left the gap
register in `docs/concurrency-and-idempotency.md`; the budget-rollover row
was rewritten to the gap that actually remains (see C1); the bill and
mortgage reminder rows in `docs/external-side-effects.md` now describe the
lease and delivery record, with the mortgage key's per-user clock read as the
surviving gap; `docs/cron-jobs.md` says `CLUSTER_MODE` does not gate the
scheduler.

**Notes:** the `users.failed_login_attempts` row was not part of F3 and is
still stale on `main`; it is F5.

### F5 -- Retire the stale `users.failed_login_attempts` gap row

- [x] Status: done.

**Scope:** `docs/concurrency-and-idempotency.md` (section 8 only).

**Pattern:** the rows F3 moved out of the gap register in commit `dc361624`.

**Steps:** the gap row says the counter is read in one statement, incremented
in JavaScript and written back with no lock. `recordFailedAttempt` in
`backend/src/auth/auth.service.ts` is one `UPDATE users ... SET failed_login_attempts = u.failed_login_attempts + 1 ... RETURNING`
that also decides `locked_until` in the same statement. Move the row into the
table of mechanisms that exist, naming the statement and the file, and drop
the CONC-001/CONC-007 reference from it.

**Acceptance:** `npm run test:unit -- doc-paths` green from `backend/`; the
gap register no longer names `failed_login_attempts`.

**Traps:** confirm against the source at the time of the task, not against
this list; if the statement has changed shape, the row may be right.

**Notes:**

### F4 -- ADR 0005

- [ ] Status:

**Scope:** `docs/adr/0005-cluster-mode-and-optional-redis.md` (new),
`docs/adr/README.md` (index row).

**Pattern:** `docs/adr/0004-mcp-two-eras-request-identity-and-mrtr-confirmation.md`
for length and tone; the template in `docs/adr/README.md`.

**Steps:** Status `accepted`, today's date. Context: the survey in the design
doc's "current state" table. Decision: PostgreSQL for correctness-bearing
state in both modes; Redis only for throttler counters and wake-up pub/sub;
explicit `CLUSTER_MODE`. Consequences: `single` gains durability across
restarts; `multi` adds one dependency and one readiness check; the relay is
now a table. Alternatives considered: PostgreSQL `LISTEN`/`NOTIFY` as the bus
(rejected for now: a dedicated connection per replica and no transaction-mode
pooling), sticky routing (rejected: it does not fix the correctness rows and
it silently fails on a replica loss), always-on Redis (rejected: the user's
requirement is that single-replica deployments need nothing new).

**Acceptance:** index row present; `doc-paths` guard green.

**Notes:**

### A1 -- Migration: `auth_attempt_counters`, `single_use_tokens`

- [x] Status: done.

**Scope:** one new file under `database/migrations/`, `database/schema.sql`,
`backend/src/common/db/rls-exempt-tables.ts`,
`docs/row-level-security-contract.md`,
`backend/src/auth/entities/auth-attempt-counter.entity.ts` (new),
`backend/src/auth/entities/single-use-token.entity.ts` (new),
`backend/src/auth/auth-state-sweeper.service.ts` (new, the cron),
`backend/src/auth/auth.module.ts`, `docs/cron-jobs.md`.

**Pattern:** the `job_claims` table and entity under
`backend/src/common/jobs/entities/` for a keyed bookkeeping table with no
owner column; `backend/src/common/jobs/job-claim.service.ts`'s daily sweep for
the cron.

**Steps:**

1. Migration, all idempotent:
   `auth_attempt_counters (scope TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, window_expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (scope, key))`
   with an index on `window_expires_at` for the sweep;
   `single_use_tokens (purpose TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (purpose, token_hash))`
   with an index on `expires_at`. No `user_id` column on either: `key` and
   `token_hash` are opaque (an email hash, a temp-token hash, `hash(userId:code)`).
2. `schema.sql` mirrored beside `job_claims`.
3. `RLS_EXEMPT_TABLES`: two entries with the reason ("keyed by opaque
   scope/hash; no owner column; written on the failure path before any
   identity is established"). `docs/row-level-security-contract.md` gains the
   same two rows. `backend/src/common/db/rls-exempt-tables.spec.ts` will fail
   until both places agree.
4. Entities with `@Entity` matching the columns (no relations).
5. `auth-state-sweeper.service.ts`: `@Cron("0 4 * * *")` under
   `withSystemContext` deleting rows whose expiry passed. Idempotent by
   predicate. Row in `docs/cron-jobs.md`. Add the file to
   `WITH_CONTEXT_ALLOWLIST`.

**Acceptance:** `scripts/verify-schema.sh` green; `npm run migration:lint`
clean; `rls-exempt-tables.spec.ts` green; `cron-doc.spec.ts` green; nothing
reads the tables yet.

**Tests:** entity round-trip in the integration harness
(`backend/test/helpers/integration-setup.ts` builds the schema with
`synchronize`, so the entities must describe the columns exactly); sweeper
unit spec with a fake clock (`backend/src/backup/auto-backup.service.spec.ts`
is the clock pattern).

**Traps:** the integration harness applies real RLS migrations
(`backend/test/helpers/rls-setup.ts`); an exempt table must be exempt there
too or the harness's catalog check (`rls-catalog.ts`) fails. A cron file that
holds a `Map`/`Set` field fails `derived-state-writers.guard.spec.ts`; the
sweeper holds none.

**Notes:** the `rls-exempt:` marker goes **only** in the block at the foot of
`database/schema.sql`. `rls-exempt-tables.spec.ts` parses every such line in
the file and compares the sorted list without de-duplicating, so a second copy
above the table definition fails it. The migration may carry one (the
`push_chart_artifacts` migration does); nothing parses migrations.

The sweeper spec asserts the statements, not a fake clock: the predicate is the
stored expiry against the database's `CURRENT_TIMESTAMP`, so there is no
process clock to fake, and a spec that faked one would be asserting the defect.
`verify-schema.sh` needs Docker; where that is unavailable the same two
databases and the same double replay run against a local PostgreSQL 16 and the
normalized `pg_dump` diff is empty, with CI's `Schema vs Migrations Drift` job
as the gate.

### A2 -- `AuthAttemptCounterService`; 2FA attempt maps replaced

- [ ] Status:

**Scope:** `backend/src/auth/auth-attempt-counter.service.ts` (new),
`backend/src/auth/auth-attempt-counter.service.spec.ts` (new),
`backend/src/auth/two-factor.service.ts`, `backend/src/auth/two-factor.service.spec.ts`,
`backend/src/auth/auth.module.ts`,
`backend/test/integration/auth-attempt-counter.integration.spec.ts` (new).

**Pattern:** `recordFailedAttempt` in `backend/src/auth/auth.service.ts`
(increment and threshold decision in one statement, `RETURNING` the
result); `backend/test/integration/mny-import-job.integration.spec.ts` for
the two-connection test.

**Steps:**

1. Service API: `increment(scope, key, windowMs): Promise<{ count: number; windowExpiresAt: Date }>`,
   `reset(scope, key)`, `peek(scope, key): Promise<number>`. `increment` is one
   statement:
   `INSERT INTO auth_attempt_counters (scope, key, count, window_expires_at) VALUES ($1, $2, 1, now() + $3) ON CONFLICT (scope, key) DO UPDATE SET count = CASE WHEN auth_attempt_counters.window_expires_at < now() THEN 1 ELSE auth_attempt_counters.count + 1 END, window_expires_at = CASE WHEN auth_attempt_counters.window_expires_at < now() THEN now() + $3 ELSE auth_attempt_counters.window_expires_at END RETURNING count, window_expires_at`.
   Wrap in `withScopedDb`; the caller decides the transaction boundary.
2. `two-factor.service.ts`: `twoFactorAttempts` (scope `2fa-token`, key
   `sha256(tempToken)`, window `BASE_LOCKOUT_MS`) and `user2FAAttempts` (scope
   `2fa-user`, key `userId`) become service calls at the four sites (the two
   reads, the two increments, the two deletes on success). Thresholds
   `MAX_2FA_ATTEMPTS` and `MAX_USER_2FA_ATTEMPTS` stay. Remove the two `Map`
   fields and their prune loop.
3. **Transaction boundary.** The increment must commit when the 2FA check
   fails. If the verify path runs inside a caller's `withScopedDb` whose
   rejection rolls back, run the increment through
   `runOutsideActiveScopedManager` (`backend/src/common/db/scoped-db.ts`).
   Write the doc comment on `increment` saying which and why.

**Acceptance:** the same limits as today; a lockout survives a backend
restart (add this as a named behaviour change in the PR description).

**Tests:** unit spec of the service with a mocked manager for the SQL shape;
`two-factor.service.spec.ts` updated to the service double; the integration
spec opens two connections, runs `increment` concurrently on one key, and
asserts the returned counts are `{1, 2}` in some order and that a third call
after `windowExpiresAt` returns `1`.

**Traps:** `two-factor.service.ts:198` and `:335` also touch `usedTotpCodes`;
that is A3, leave it. Keys must not be the raw temp token (a JWT) -- hash it.
The backup-code path already takes a row lock; do not reroute it.

**Notes:**

### A3 -- `usedTotpCodes` replaced by a single-use claim

- [ ] Status:

**Scope:** `backend/src/auth/single-use-token.service.ts` (new),
`backend/src/auth/single-use-token.service.spec.ts` (new),
`backend/src/auth/two-factor.service.ts`, `backend/src/auth/two-factor.service.spec.ts`,
`backend/src/auth/auth.module.ts`,
`backend/test/integration/single-use-token.integration.spec.ts` (new).

**Pattern:** `claimJti` in `backend/src/auth/oidc/oidc-reauth.service.ts`
(`INSERT ... ON CONFLICT (jti) DO NOTHING`, winner decided by row count).

**Steps:**

1. Service API: `claim(purpose, token, ttlMs): Promise<boolean>` doing
   `INSERT INTO single_use_tokens (purpose, token_hash, expires_at) VALUES ($1, sha256($2), now() + $3) ON CONFLICT DO NOTHING RETURNING token_hash`;
   `true` when a row came back. Expired rows are not reused: the sweep
   deletes them, and a claim against an existing expired row is still a
   loss (a TOTP code is dead after its window anyway).
2. `two-factor.service.ts`: replace the `has` check and the `set` at the two
   TOTP paths (login verification and the second site near `:335`) with one
   `claim("totp", `${userId}:${code}`, TOTP_CODE_REUSE_WINDOW_MS)` performed
   **after** the code verifies and **before** the session is issued. Remove
   the `usedTotpCodes` field and its prune loop.

**Acceptance:** a valid code submitted twice within 90 s is refused the
second time on any replica; behaviour on one replica is unchanged.

**Tests:** integration spec, two connections, one code claimed concurrently,
exactly one `true`; unit spec of `two-factor.service.ts` asserting the claim
runs only after successful verification (a wrong code must not burn a
claim).

**Traps:** the claim must not run before verification, or an attacker can
exhaust valid codes by guessing. Hash the key; never store `userId:code` in
clear.

**Notes:**

### A4 -- Step-up and auth-email counters; interval prune removed

- [ ] Status:

**Scope:** `backend/src/auth/step-up/step-up.service.ts` and its spec,
`backend/src/auth/auth-email.service.ts` and its spec.

**Pattern:** A2's `AuthAttemptCounterService`.

**Steps:**

1. `step-up.service.ts`: `attempts` (keyed `userId:purpose`, `MAX_ATTEMPTS`,
   30-minute window) becomes scope `step-up`; the delete on success becomes
   `reset`. Remove the `Map` and the prune method.
2. `auth-email.service.ts`: `forgotPasswordAttempts` and
   `verificationEmailAttempts` (3 per hour per email) become scopes
   `forgot-password` and `verification-email` keyed by `sha256(lowercase email)`.
   Remove both `Map`s, `cleanupExpiredAttempts`, the `setInterval` in the
   constructor and the `onModuleDestroy` that clears it (keep
   `onModuleDestroy` if anything else uses it).

**Acceptance:** limits unchanged; no `setInterval` remains in
`auth-email.service.ts`.

**Tests:** both specs move to the service double; assert the scope and key
strings (they are the contract between replicas).

**Traps:** `auth-email.service.ts` throttles by email before the user is
known, so there is no `withUserContext`; the counter service runs under the
request's ambient context on the unauthenticated route. Confirm
`withScopedDb` has a context there (the forgot-password route seeds one; if
it does not, wrap with `withSystemContext` and add the file to the
allowlist).

**Notes:**

### K1 -- OIDC provider signing keys persisted

- [ ] Status:

**Scope:** one migration + `schema.sql` (`oauth_instance_config`),
`backend/src/oauth/entities/oauth-instance-config.entity.ts` (new),
`backend/src/oauth/oauth-signing-keys.service.ts` (new) + spec,
`backend/src/oauth/oauth-provider.service.ts` and its spec,
`backend/src/oauth/oauth.module.ts`, `backend/src/common/db/rls-exempt-tables.ts`,
`docs/row-level-security-contract.md`, `backend/src/main.ts` (warning text),
`e2e/tests/` (the OAuth spec, restart case).

**Pattern:** `ensureKeyPair` in `backend/src/push/push-config.service.ts`
(generate, `INSERT ... ON CONFLICT (id) DO NOTHING`, re-read in the same
transaction, never assemble from the values you tried to insert; encrypt with
`ENCRYPTION_KEY`; refuse to store when the key is absent).

**Steps:**

1. Table `oauth_instance_config (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), jwks_enc TEXT NOT NULL, generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`.
   Exempt from RLS with the `push_instance_config` reason.
2. `OauthSigningKeysService.ensureJwks(): Promise<JWKS | null>`: generate one
   RS256 and one ES256 key with `jose` (`generateKeyPair` + `exportJWK`, set
   `kid` and `use: "sig"`), encrypt the JSON with the existing encryption
   service, insert-as-arbiter, re-read, decrypt, return. Returns `null` with a
   warning when `ENCRYPTION_KEY` is absent.
3. `oauth-provider.service.ts` `onModuleInit`: `await ensureJwks()` and pass
   `jwks` to `new Provider(issuer, { ... })` when non-null. When null, keep
   today's behaviour and extend the existing encryption-key warning with
   "OIDC signing keys are per process".
4. `OAUTH_PAYLOAD_ALLOWLIST` in `backend/eslint.config.mjs` is for
   `oauth_payloads` only; this table is reached through `withScopedDb` under
   `withSystemContext` in a bootstrap hook (add the file to
   `WITH_CONTEXT_ALLOWLIST`).

**Acceptance:** `/oauth/jwks` returns the same `kid`s before and after a
backend restart; two backends over one database serve identical JWKS.

**Tests:** service spec: two instances over one (mocked, then real in an
integration spec) database, same `kid`; provider spec asserts `jwks` is
passed when available; E2E OAuth flow gains a case that verifies the ID token
signature against `/oauth/jwks` fetched after a `docker compose -f docker-compose.e2e.yml restart backend`.

**Traps:** `oidc-provider` is ESM and dynamically imported; `jose` is already
a transitive dependency but pin it directly. The provider's `NOTICE` about
development keys must disappear from the boot log in the configured case
(`backend/src/oauth/oidc-provider-log-bridge.ts` routes it; assert on it).
Rotation is out of scope; leave a `// rotation: see design doc WP4` marker.

**Notes:**

### X1 -- AI action anti-replay onto `single_use_tokens`

- [ ] Status:

**Scope:** `backend/src/ai/actions/ai-actions.service.ts` and its spec,
`backend/src/ai/ai.module.ts` (import of the auth single-use service or a
shared module), the MCP confirmation path under `backend/src/mcp/` that
accepts the same descriptor (grep `actionId` and the descriptor verifier),
`backend/test/integration/ai-action-replay.integration.spec.ts` (new).

**Pattern:** A3's `SingleUseTokenService`.

**Steps:**

1. Replace `consumed` (`Map<actionId, expiresAt>`): the `has` check at the
   confirmation entry becomes `claim("ai-action", actionId, expiresAt - now)`
   executed **inside** the `withScopedDb` that applies the action, so a
   refused claim and an applied write cannot both happen and a failed apply
   rolls the claim back (the descriptor may then be retried, which is the
   intended semantics today: the `delete` at `:190` on failure).
2. Remove the `Map`, the `set`, the `delete` on failure (the rollback does
   it) and the prune loop at `:1016`.
3. Route the MCP-side confirmation through the same call so both surfaces
   share one claim.

**Acceptance:** confirming one descriptor twice yields one applied action
and one refusal, across two replicas; a failed apply leaves the descriptor
confirmable again.

**Tests:** integration spec, two connections confirming one descriptor,
exactly one apply; unit spec for the rollback-releases-claim case.

**Traps:** `SingleUseTokenService` lives under `auth/`; if importing
`AuthModule` into `AiModule` creates a cycle (`module-graph.spec.ts`), move
the service to `backend/src/common/single-use/` in this task and update A3's
imports. Do not create a second single-use table.

**Notes:**

### R1 -- Event bus token, interface, memory implementation

- [x] Status: done.

**Scope:** `backend/src/common/events/event-bus.interface.ts` (new),
`backend/src/common/events/memory-event-bus.ts` (new) + spec,
`backend/src/common/events/event-bus.module.ts` (new), `backend/src/app.module.ts`.

**Pattern:** `backend/src/attachments/storage/attachment-storage.interface.ts`
(interface + `Symbol` token named like the env var) and the `useFactory`
selection in `backend/src/attachments/attachments.module.ts`.

**Steps:**

1. Interface: `publish(channel: string, payload: Record<string, unknown>): Promise<void>`,
   `subscribe(channel: string, handler: (payload) => void): () => void` (the
   return value unsubscribes), `readonly name: "memory" | "redis"`. Token
   `EVENT_BUS = Symbol("EVENT_BUS")`. Payloads are wake-ups only; document
   the "never the data" rule on the interface.
2. `MemoryEventBus`: a `Map<channel, Set<handler>>`, delivery on the next
   microtask so publish never re-enters the publisher's stack.
3. `EventBusModule` registers `MemoryEventBus` and a `useFactory` on the
   token that returns it unconditionally (R6 adds the `multi` branch).
   `@Global()`.

**Acceptance:** nothing consumes the bus yet; app boots unchanged.

**Tests:** memory bus spec: subscribe/publish/unsubscribe, ordering, a
throwing handler does not stop the others.

**Traps:** the `Map` in `MemoryEventBus` is process-local by design; when G1
lands, allowlist it with that reason.

**Notes:** `publish` snapshots the subscriber set before the `await`. A handler
that unsubscribes its neighbour is the ordinary SSE case (one request ending
closes the waiter it shares a user channel with), and iterating the live `Set`
would then skip a handler that was subscribed when the message was published.
The unsubscribe closure is idempotent for the same reason: a waiter that
unsubscribes on both the disconnect and the timeout path must not remove a
handler a later subscribe re-added. Both have a spec.

`activeChannels()` is on `MemoryEventBus` only, not on `EventBus`: an empty
`Set` left behind after the last unsubscribe is a slow leak in a process
serving many per-user channels, and this is how a spec sees it.

### R2 -- Migration: `ai_relay_prompts`, `ai_relay_agents`

- [x] Status: done.

**Scope:** one migration + `schema.sql`, two entities under
`backend/src/ai/relay/entities/` (new), `database/CLAUDE.md` only if it lists
tables.

**Pattern:** `scheduled_transaction_postings` for a claim table; any
`user_id`-owned table's RLS policy block in `database/schema.sql` (policies
are direct: `user_id = current user`).

**Steps:**

1. `ai_relay_prompts (id UUID PK DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK (status IN ('pending','claimed','answered','expired')), prompt JSONB NOT NULL, answer JSONB, created_at, claimed_at, answered_at, expires_at TIMESTAMPTZ NOT NULL)`,
   index `(user_id, status, created_at)`.
2. `ai_relay_agents (user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, last_poll_at TIMESTAMPTZ, idle_since TIMESTAMPTZ, idle_disconnected_at TIMESTAMPTZ)`.
3. `ai_relay_actions (id TEXT, user_id, card JSONB, created_at, expires_at, PRIMARY KEY (user_id, id))`
   for buffered write-confirmation cards (R4 reads it).
4. RLS policies for all three keyed on `user_id`, following the templated
   policy block; `DROP POLICY IF EXISTS` before each `CREATE POLICY`.

**Acceptance:** `verify-schema.sh` green; the RLS integration catalog
(`backend/test/helpers/rls-catalog.ts`) lists the three tables as
policy-covered.

**Tests:** entity round-trip in the integration harness; the RLS enforcement
spec picks the tables up from the catalog automatically.

**Traps:** `JSONB` columns come back as objects from `pg`; do not
`JSON.parse` them. Prompts may carry attachment references, not bytes (R5).

**Notes:** three entities, not the two the Scope names -- step 3's
`ai_relay_actions` needs one like the other two, and R4 reads it.

Two additions to the shape sketched above, each because the harness or the
current service demands it:

- `ai_relay_prompts.claimed_by TEXT`. `PendingPrompt.claimedBy` already carries
  the claiming MCP session, and a relay turn belongs to one session: liveness
  from another session the same user has open must not steer it. R4's late-answer
  path reads it. Adding it now costs a column; adding it in R3 costs a migration.
- `status` carries `DEFAULT 'pending'` and its CHECK is named
  `ck_ai_relay_prompts_status`. The RLS enforcement spec's generic seeder
  (`rls-catalog.ts`) generates a `t<n>` string for any NOT NULL text column with
  no default, which no CHECK-constrained column can accept; a default is how the
  other such columns in this schema (`security_documents.document_type`) stay
  seedable, and `pending` is the state a turn is born in rather than a
  convenience.

The `@Check` and the three `@ManyToOne(() => User, { onDelete: "CASCADE" })`
relations are on the entities for the same reason: the integration harness
builds its database from entity metadata, so a constraint or a delete rule that
only `schema.sql` carries is one no integration spec can observe, and a spec
that cannot observe it is not evidence about production.

`verify-schema.sh` is blind to a default that differs between a migration and
`schema.sql`: `CREATE TABLE IF NOT EXISTS` is skipped on the baseline, so the
two never disagree in its dump. `schema.sql` is the authority for a fresh
install -- change both by hand and check both.

### R3 -- Relay queue on rows

- [ ] Status:

**Scope:** `backend/src/ai/relay/ai-relay.service.ts` and its spec,
`backend/src/ai/relay/ai-relay.controller.ts` and its spec,
`backend/src/ai/relay/ai-relay.types.ts`, `backend/src/mcp/tools/relay.tool.ts`
and its spec, `backend/src/ai/relay/ai-relay.module.ts`,
`backend/test/integration/ai-relay-claim.integration.spec.ts` (new).

**Pattern:** the `FOR UPDATE SKIP LOCKED` CTE in
`backend/src/notifications/notification-reminder-cron.service.ts` for the
claim; `runOutsideActiveScopedManager` in `backend/src/common/db/scoped-db.ts`
for writes a concurrent reader must see.

**Steps:**

1. Browser side (`POST query/stream`): insert a `pending` row, subscribe to
   `relay:<userId>` on the `EVENT_BUS`, and hold the SSE open. On each
   wake-up, re-read the row; when `answered`, stream the answer and end. On
   client disconnect or the existing hard deadline, unsubscribe; the row
   stays for R4's late pickup.
2. Agent side (`get_next_prompt` in `relay.tool.ts`): claim with
   `UPDATE ai_relay_prompts SET status='claimed', claimed_at=now() WHERE id = (SELECT id FROM ai_relay_prompts WHERE user_id=$1 AND status='pending' AND expires_at > now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.
   No row: park on a bus subscription with the existing long-poll timeout,
   then retry the claim once on wake-up (a wake-up is a hint, never a
   payload).
3. `post_response`: `UPDATE ... SET status='answered', answer=$2, answered_at=now() WHERE id=$1 AND status='claimed' RETURNING id`;
   zero rows is a refusal (already answered, or expired). Publish
   `relay:<userId>` after commit.
4. Both transitions publish **after** the transaction commits, never inside
   it (a rollback must not wake a reader to a row that was never written).
5. Delete the `pending`, `inFlight` and `waiters` maps and every
   `resolve`/`reject` closure. `status` (`GET status`) reads the rows.

**Acceptance:** in `single`, the chat round trip behaves as today and a
prompt survives a backend restart mid-wait (named change). Two agents polling
one user claim each prompt exactly once.

**Tests:** integration spec: two connections run the claim statement
concurrently on one `pending` row, one gets it; a `post_response` after a
`post_response` returns zero rows. Controller and tool specs move to a
repository double plus the memory bus.

**Traps:** the SSE heartbeat `setInterval` in the controller stays (it
describes one socket). Wake-ups can be lost (Redis restart), so every waiter
also polls the row on a slow timer (the existing long-poll timeout is the
ceiling). Do not let the bus payload carry the prompt or the answer.

**Notes:**

### R4 -- Late answers, buffered actions and liveness on rows

- [ ] Status:

**Scope:** `backend/src/ai/relay/ai-relay.service.ts` and spec,
`backend/src/ai/relay/ai-relay.controller.ts` and spec (`GET response/:promptId`
and the action pickup endpoint), `backend/src/ai/relay/relay-sweeper.service.ts`
(new cron) and spec, `docs/cron-jobs.md`.

**Steps:**

1. `takeBufferedResponse` reads an `answered` row whose browser stream ended
   and marks it consumed (`status='expired'` after pickup, or a `picked_up_at`
   column added in this task's migration if a state is clearer).
2. Buffered action cards go to `ai_relay_actions`; the pickup endpoint drains
   by `user_id`.
3. `lastPollAt`, `idleSince`, `idleDisconnectedAt` become
   `ai_relay_agents` columns written through `runOutsideActiveScopedManager`
   (they are progress, not business data) with an upsert.
4. `relay-sweeper.service.ts`: `@Cron` every 5 minutes expiring
   `pending`/`claimed` rows past `expires_at` and deleting consumed rows
   older than `BUFFER_TTL_MS`. Row in `docs/cron-jobs.md`. Idempotent by
   predicate.
5. Delete `buffered`, `awaitingLate`, `bufferedActions`, `lastPollAt`,
   `idleSince`, `idleDisconnectedAt` and their `setTimeout` handles.

**Acceptance:** no `Map` field remains in `ai-relay.service.ts` (G1 will scan
for it); late answers and cards survive a restart.

**Tests:** service spec on the row double for each of the three pickup paths;
sweeper spec with a fake clock.

**Traps:** the tunnel status endpoint is polled by the browser; keep its
reads cheap (one query per call, indexed by `user_id`).

**Notes:**

### R5 -- Relay attachments through the storage provider

- [ ] Status:

**Scope:** `backend/src/ai/relay/relay-attachment.store.ts` and spec,
`backend/src/ai/relay/ai-relay.module.ts` (inject `ATTACHMENT_STORAGE_PROVIDER`),
a small migration + `schema.sql` for `ai_relay_attachments (id, user_id, storage_key, mime, size, expires_at)`,
`backend/src/attachments/storage/storage-key.util.ts` if the key grammar
needs a `relay/` prefix.

**Pattern:** `backend/src/attachments/storage/attachment-storage.interface.ts`
and how `BackupService` injects the token from outside `AttachmentsModule`.

**Steps:** save bytes under `relay/<attachmentId>` via the provider inside the
transaction that writes the metadata row (bytes before commit, clean up on
failure, per `docs/external-side-effects.md`); load by id from any replica;
the R4 sweeper deletes expired rows and their objects. `byUser` goes away.

**Acceptance:** an attachment uploaded on one backend is readable by the
agent through another.

**Tests:** provider round-trip with the database provider in the integration
harness; the sweeper's delete path with a provider double.

**Traps:** the `database` provider joins the ambient transaction; `local` and
`s3` do not (the external-side-effects ordering rule). The orphan sweeper in
`backend/src/attachments/attachment-orphan-sweeper.service.ts` must not see
relay keys as orphans: either register them in its intent table or namespace
them so its query excludes `relay/`.

**Notes:**

### R6 -- `RedisEventBus`

- [ ] Status:

**Scope:** `backend/src/common/events/redis-event-bus.ts` (new) + spec,
`backend/src/common/events/event-bus.module.ts`,
`backend/test/integration/redis-event-bus.integration.spec.ts` (new).

**Steps:**

1. `RedisEventBus` takes `REDIS_CLIENT` (publish) and `REDIS_SUBSCRIBER`
   (`psubscribe` on `<prefix>relay:*` and any other channel families as they
   appear) and fans messages to local handlers by exact channel.
2. `event-bus.module.ts`'s factory returns it in `multi`.
3. Serialize payloads as JSON; reject anything over 4 KB (a wake-up is
   small).

**Acceptance:** with `CLUSTER_MODE=multi` in the integration job, two bus
instances over one Redis deliver a publish on A to a subscriber on B.

**Tests:** unit spec with an `ioredis` double; the integration spec uses the
D3 service (`REDIS_URL` in the job env; skip with a clear message when it is
unset locally, following the `describe.skip` idiom in `doc-paths.spec.ts`).

**Traps:** `keyPrefix` on `ioredis` does not apply to pub/sub channel names;
prefix them explicitly. A subscriber connection reconnects silently; re-issue
`psubscribe` on `ready`.

**Notes:**

### T1 -- `RedisThrottlerStorage`

- [ ] Status:

**Scope:** `backend/src/common/throttler/redis-throttler-storage.ts` (new) +
spec, `backend/src/app.module.ts` (`ThrottlerModule.forRootAsync`),
`backend/test/integration/redis-throttler.integration.spec.ts` (new).

**Pattern:** `@nestjs/throttler` 6.x's `ThrottlerStorage` interface
(`increment(key, ttl, limit, blockDuration, throttlerName)` returning
`{ totalHits, timeToExpire, isBlocked, timeToBlockExpire }`); verify the exact
signature against the installed version in `backend/node_modules` before
writing.

**Steps:**

1. Implement `increment` as one Lua script (`INCR`, `PEXPIRE` on first hit,
   block-key logic) so two replicas cannot double-count; key names carry
   `REDIS_KEY_PREFIX` and `throttlerName`.
2. Fail open: on any Redis error return `{ totalHits: 0, ... }` and log at
   most once per minute with a process-local timestamp (allowlist it in G1
   with the reason: it is a log throttle).
3. `app.module.ts`: `ThrottlerModule.forRootAsync` with `inject: [CLUSTER_MODE, REDIS_CLIENT]`;
   `storage` is set only in `multi`, so `single` keeps the library default
   object untouched.

**Acceptance:** in `multi`, 100 requests spread over two backends trip the
default `limit(100)`; in `single`, the storage class is never constructed.

**Tests:** unit spec for the Lua path with a double; integration spec against
the D3 Redis with two storage instances sharing keys.

**Traps:** `RATE_LIMIT_MAX` via `rateLimit()` in
`backend/src/common/throttle.util.ts` is raise-only; do not change it. The
health controller is `@SkipThrottle()`; keep it so.

**Notes:**

### M1 -- MCP 2025-era sessions

- [ ] Status:

**Scope:** `backend/src/mcp/mcp-http.controller.ts` and spec,
`backend/src/mcp/CLAUDE.md`, possibly a migration for `mcp_sessions`, `helm/templates/ingress.yaml`
and `helm/templates/httproute.yaml` (only for the sticky fallback), `docs/adr/0004-mcp-two-eras-request-identity-and-mrtr-confirmation.md`
(an addendum, not a rewrite).

**Steps:**

1. Read the installed `@modelcontextprotocol/sdk` streamable-HTTP transport:
   can a transport be re-created for an existing session id on a different
   process (that is, is the session id the only state)? Record the answer in
   the task's Notes with the SDK version.
2. If yes: `mcp_sessions (session_id TEXT PK, user_id, created_at)`,
   `sessionUsers`/`sessionCreatedAt` become reads of that table, the transport
   and server are built per request and cached in a short-lived per-process
   map keyed by session id (allowlisted in G1 as a cache, not a guard); the
   5-minute `setInterval` becomes a `DELETE` in the A1 sweeper or its own
   cron row.
3. If no: document sticky routing on the `/mcp` path only, as a Helm value
   that adds the ingress annotation (`nginx.ingress.kubernetes.io/affinity`)
   or an HTTPRoute `sessionPersistence`, and say in `backend/src/mcp/CLAUDE.md`
   that 2025-era clients need it in `multi`.

**Acceptance:** the 2026-07-28 leg is byte-for-byte unchanged (its spec must
not change). For the persisted variant, a session created on one backend
answers on another.

**Tests:** two-instance integration spec for the persisted variant; for the
sticky variant, a Helm render test in D1 that the annotation appears only
when the value is set.

**Notes:**

### S1 -- Boot refusals for per-pod storage in `multi`

- [ ] Status:

**Scope:** `backend/src/common/cluster/cluster-mode.ts` and spec (the matrix
rows already exist from F1; this task wires the inputs), `backend/src/main.ts`,
`backend/src/backup/auto-backup.service.ts` only to expose "backups enabled"
if no cheap predicate exists.

**Steps:** add `ATTACHMENT_STORAGE_PROVIDER`, `ATTACHMENT_SHARED_VOLUME`,
`BACKUP_CONTAINER_DIR` (or whatever cheap predicate says backups are
configured) and `BACKUP_SHARED_VOLUME` to `ClusterBootEnv`, to
`checkClusterBoot`'s matrix, and to the named list `assertClusterBootOrExit`
passes in `main.ts`; the `database` provider warns (not refuses) in `multi`
with the sentence from the design doc's open questions. Document the two new
`*_SHARED_VOLUME` variables in `.env.example` beside `CLUSTER_MODE`.

**Acceptance:** `CLUSTER_MODE=multi ATTACHMENT_STORAGE_PROVIDER=local` exits 1
naming `ATTACHMENT_SHARED_VOLUME=true`, `database` and `s3`;
`ATTACHMENT_SHARED_VOLUME=true` boots.

**Tests:** `cluster-mode.spec.ts`'s table gains the rows.

**Traps:** `ATTACHMENT_LOCAL_DIR` is a deprecated alias for
`ATTACHMENT_CONTAINER_DIR`; treat both as `local`.

**Notes:**

### S2 -- S3 backup target

- [ ] Status:

**Scope:** `backend/src/backup/storage/` (new folder: interface, `local` and
`s3` targets, token `BACKUP_STORAGE_PROVIDER`), `backend/src/backup/auto-backup.service.ts`,
`backend/src/backup/backup-paths.ts`, `backend/src/backup/backup.module.ts`,
`.env.example`, `helm/values.yaml`, `docs/backup-restore-contract.md`,
`docs/external-side-effects.md` section 3.

**Pattern:** `backend/src/attachments/storage/s3-storage.provider.ts` (lazy
client, hard request deadline, `S3_MAX_ATTEMPTS`) and its `*.deadline.spec.ts`.

**Steps:** extract today's filesystem write/list/promote/delete into a
`local` target; add an `s3` target whose keys keep the
`<ab>/<cd>/<userId>/monize-backup-<tier>-<date>.json.gz` layout (so
`docs/adr/0003-filesystem-objects-use-id-sharding.md` still describes it);
retention and promotion become list + copy + delete on the prefix; the
writability probe becomes a `HeadBucket`. In `multi`, an `s3` target
satisfies the S1 backup check without `BACKUP_SHARED_VOLUME`.

**Acceptance:** an hourly run against MinIO in the integration harness writes,
promotes and prunes per the existing retention spec.

**Tests:** the existing `auto-backup.service.spec.ts` matrix runs against both
targets (the `local` one on a real `mkdtemp` per the CLAUDE.md rule); an
integration spec against a MinIO service (add it to D3's job if it is not
there).

**Traps:** `docs/external-side-effects.md` EXT-001: durable state before the
external write, or reconstructibility; a backup object with no record is a
storage cost, a record with no object is the failure. Keep the order the
filesystem target has.

**Notes:**

### C1 -- Budget period rollover under a per-owner `claimOnce`

- [ ] Status:

**Scope:** `backend/src/budgets/budget-period-cron.service.ts` and spec,
`backend/src/common/jobs/job-claim.service.ts` (a `BudgetPeriodRollover`
member on the `JobClaimType` const), `docs/cron-jobs.md`,
`backend/test/integration/budget-period-rollover.integration.spec.ts` (new
or extended).

**Pattern:** `backend/src/database/demo-reset.service.ts` (`claimOnce` per
window; the intraday cron's `DemoIntraday` claim keyed `<date>-<hour>`).

**Steps:** the rollover already fans out per budget owner; claim
`claimOnce(BudgetPeriodRollover, ownerUserId, "<YYYY-MM>")` inside each
owner's `withUserContext` body before creating that owner's periods. A losing
replica skips the owner. The claim is permanent (a month rolls over once) and
is never released on failure: a failed rollover is repaired by the request
path that creates a period on demand, not by a retry of the cron. Keep the
`ON CONFLICT (budget_id, period_start) DO NOTHING RETURNING` insert as the
second wall. The gap F3 recorded is the report, not the data: the loser of
`closePeriod`'s row lock finds no OPEN period, raises `BadRequestException`,
and the cron counts a normal two-replica tick as a failure. With the claim in
place that path is unreachable for a claimed owner; make the "no OPEN period"
outcome a logged skip rather than a counted error anyway, so a rollout that
overlaps two processes at one replica stays quiet. Update the cron doc row's
mechanism and the register row in `docs/concurrency-and-idempotency.md`.

**Acceptance:** two runners on one month produce one set of periods per owner
and zero counted errors.

**Tests:** two-connection spec: two `claimOnce` calls for one owner and
month, one winner; a unit spec that the loser does not create periods.

**Traps:** `job_claims.user_id` is a `NOT NULL` foreign key to `users`, so
there is no deployment-wide claim through `JobClaimService`; the claim is per
owner, which is also the unit the rollover works in. Confirm the request path
that creates a missing period on demand exists before relying on it for
repair; if it does not, use `claimLease` with a short TTL instead so a failed
run can retry next tick.

**Notes:**

### C2 -- Fetch crons behind a deployment-wide sync claim

- [ ] Status:

**Scope:** one migration + `schema.sql` (`fetch_sync`),
`backend/src/common/jobs/fetch-sync.service.ts` (new) + spec,
`backend/src/common/jobs/job-claim.module.ts`,
`backend/src/currencies/exchange-rate.service.ts` and spec (`onModuleInit`
sweep and the 17:05 cron), `backend/src/securities/security-price.service.ts`
and spec (17:00 cron), `backend/src/securities/market-index.service.ts` and
spec (17:10 cron), `backend/src/common/db/rls-exempt-tables.ts`,
`docs/row-level-security-contract.md`, `docs/cron-jobs.md`,
`backend/test/integration/fetch-sync.integration.spec.ts` (new).

**Pattern:** the `market_index_sync` table in `database/schema.sql`
(`index_code PRIMARY KEY, last_attempt_at, last_success_at, last_error`) and
the six-hour `respectCooldown` in `market-index.service.ts`; the single
conditional `UPDATE ... RETURNING` claim in
`backend/src/notifications/provider-outage-alert.service.ts`. Not
`JobClaimService`: `job_claims.user_id` is a foreign key to `users`, and these
fetches belong to no user.

**Steps:**

1. `fetch_sync (job TEXT PRIMARY KEY, lease_until TIMESTAMPTZ, lease_token UUID, last_success_at TIMESTAMPTZ, last_error TEXT)`,
   RLS-exempt with the `market_index_sync` reason.
2. `FetchSyncService.claim(job, leaseMs): Promise<string | null>` is one
   statement: `INSERT INTO fetch_sync (job, lease_until, lease_token) VALUES ($1, now() + $2, $3) ON CONFLICT (job) DO UPDATE SET lease_until = EXCLUDED.lease_until, lease_token = EXCLUDED.lease_token WHERE fetch_sync.lease_until IS NULL OR fetch_sync.lease_until < now() RETURNING lease_token`;
   a returned token is the win. `release(job, token)` and
   `markSuccess(job, token)` address the row by token, as `JobClaimService`
   does (a stalled worker must not release a lease another replica retook).
3. Each of the three crons claims `("exchange-rates" | "security-prices" | "market-indexes", <lease>)`
   before fetching; losers log at debug and return. The lease is shorter than
   the cron interval so a crashed holder never blocks the next tick.
4. The exchange-rate `onModuleInit` sweep claims the same job with the same
   lease, so a rollout of N pods fetches once; the per-user historical
   backfills it fans out stay `withUserContext` behind the claim.

**Acceptance:** provider calls per tick go from N to 1 with two replicas.

**Tests:** integration spec: two connections claim one job concurrently, one
token; a claim after `lease_until` passes wins; `release` with the wrong token
is a no-op. Service specs: two service instances, a real `FetchSyncService`
double that yields to one, one provider call.

**Traps:** the data writes are already idempotent upserts; the claim is for
cost, so a lost lease must never block a later tick. `market_index_sync`
keeps its per-index cooldown role; do not merge the two tables.
`derived-state-writers.guard.spec.ts` allowlists the `EmptyWindowMemory`
fields in these files; do not add new `Map`s. Add the new cron-adjacent
service to `WITH_CONTEXT_ALLOWLIST` only if it seeds its own context (it
should not; the callers already do).

**Notes:**

### C3 -- Release-check cache to a one-row table

- [ ] Status:

**Scope:** migration + `schema.sql` (`update_check_state (id BOOLEAN PK, checked_at, latest_version, release_url, error)`),
`backend/src/updates/updates.service.ts` and spec, an entity, `docs/cron-jobs.md`,
`backend/src/common/db/rls-exempt-tables.ts`.

**Pattern:** `push_instance_config` for a singleton row.

**Steps:** the 12-hour cron and the startup refresh first read the row; if
`checked_at` is within 12 hours, serve it and skip GitHub. The write is an
upsert. The in-memory `cache` field becomes a short read-through (or is
removed; the endpoint is not hot).

**Acceptance:** two replicas answer `/updates` identically; GitHub is called
once per 12 hours per deployment.

**Tests:** service spec with a clock; two instances, one fetch.

**Notes:**

### C4 -- Demo seed under the lifecycle advisory lock

- [ ] Status:

**Scope:** `backend/src/db-demo-check.ts`, `backend/src/database/seed.ts`,
`backend/docker-entrypoint.sh` (only if the step order changes),
`backend/src/startup-logging.spec.ts` (`PRE_BOOT_SCRIPTS` already lists both;
confirm).

**Pattern:** `backend/src/db-init.ts`'s use of `DB_LIFECYCLE_LOCK_KEY` from
`backend/src/common/db/advisory-locks.ts`: session-scoped blocking
`pg_advisory_lock`, re-read state after acquiring, direct connection (not
through a transaction-mode pooler).

**Steps:** both scripts take the lock, and `seed.ts` re-runs the demo-check
predicate after acquiring so the second pod finds the seed done and exits 0.

**Acceptance:** two demo containers started together seed once; the boot log
keeps one shape (named `Logger`, no `console`).

**Tests:** a two-connection integration spec that the lock serialises two
seed invocations (the `db-init` spec, if one exists, is the pattern; else a
small harness calling the exported function twice on two connections).

**Notes:**

### G1 -- Whole-tree process-local-state guard

- [ ] Status:

**Scope:** `backend/src/common/process-local-state.guard.spec.ts` (new).

**Pattern:** `backend/src/common/db/derived-state-writers.guard.spec.ts` (the
`private <name>: Set|Map|EmptyWindowMemory` regex, the `@Cron(` scoping, the
offender list with `file:line`, the vacuity anchor, the allowlist that "may
shrink, never grow without a reason").

**Steps:** widen the scan to every non-spec file under `backend/src`; match
`private (readonly )?<name> = new (Map|Set)(` and `private <name>: (Map|Set)<`
after stripping comments with `extractTsComments` from
`backend/src/common/repo-paths.util.ts`; seed the allowlist from the design
doc's "Per-replica state that stays" table, plus `MemoryEventBus` (R1), the
T1 log throttle, and M1's transport cache if that variant shipped, each with
its reason as the map value. Leave the cron-scoped guard in place (it has a
narrower, stronger claim).

**Acceptance:** the guard is green on the tree after A4, X1 and R4; removing
any allowlist entry reports its file and line.

**Traps:** function-scoped `new Map(` inside a method is fine and must not
match (the regex anchors on `private`). Blank comments while preserving line
numbers so the report points at the right line.

**Notes:**

### G2 -- Invariants in both contract docs

- [ ] Status:

**Scope:** `docs/system-invariants.md` (five entries in the field template
plus five index rows), `docs/verification-contract.md` (five section-3 rows
naming the test kind and the spec file each task wrote).

**Pattern:** `INV-CRON-001` and `INV-IMPORT-001` entries for the field
template; the parity guard `backend/src/common/invariant-catalog-parity.spec.ts`
(every `INV-` ID as the first table cell in both files, letters-only prefix).

**Steps:** copy the five rows from the design doc's "Invariants to add",
expand each into the nine-field block, and set `Status` honestly: `enforced`
only where the named spec exists and is green; otherwise `partial` with the
missing path listed.

**Acceptance:** `npm run test:unit -- invariant-catalog-parity` and
`doc-paths` green; every `Required tests` line names a spec that resolves.

**Notes:**

### D1 -- Helm

- [ ] Status:

**Scope:** `helm/values.yaml`, `helm/templates/statefulset-backend.yaml` and
`helm/templates/statefulset-frontend.yaml` (renamed to `deployment-*.yaml`),
new `helm/templates/pdb-backend.yaml`, `helm/templates/pdb-frontend.yaml`,
`helm/templates/hpa-backend.yaml` (optional), `helm/templates/configmap-backend.yaml`,
`helm/templates/secret-redis.yaml` (new, when `redis.url` carries a password),
`helm/templates/NOTES.txt`, `helm/README.md`, `.github/workflows/ci.yml` (the
`helm-chart` job renders a second values file), `helm/ci/multi-values.yaml`
(new).

**Steps:**

1. `Deployment` with `strategy: RollingUpdate`, `maxUnavailable: 0`,
   `maxSurge: 1`; keep `revisionHistoryLimit`, security context, probes,
   `readOnlyRootFilesystem` and the `/tmp` `emptyDir` as they are.
2. Values: `backend.replicas`, `backend.podDisruptionBudget.minAvailable`,
   `backend.topologySpreadConstraints`, `backend.autoscaling.{enabled,minReplicas,maxReplicas,targetCPU}`,
   `cluster.mode` (`single|multi`), `redis.url`, `redis.existingSecret`,
   `redis.keyPrefix`; the same replica/PDB/spread block for the frontend.
3. `NOTES.txt`: when `cluster.mode=multi` and `attachments` or `backups`
   persistence is enabled, print the ReadWriteMany requirement and the
   `*_SHARED_VOLUME` assertion values.
4. CI: `helm template` with `helm/ci/multi-values.yaml` as well as defaults;
   assert the rendered `Deployment` kind and that `CLUSTER_MODE` lands in
   the configmap.

**Acceptance:** default render is behaviourally identical (one replica, same
env); the multi render passes `helm lint`; the PVC guidance is printed only
when relevant.

**Traps:** the design doc says a StatefulSet-to-Deployment change is a
one-time recreate on upgrade (a StatefulSet cannot be converted in place);
say so in `NOTES.txt` and `helm/README.md` with the `kubectl delete sts`
step, and keep PVCs `helm.sh/resource-policy: keep`. The
`backend.persistence.*.accessMode` default stays `ReadWriteOnce`.

**Notes:**

### D2 -- Compose HA example

- [ ] Status:

**Scope:** `docker-compose.ha.yml` (new), `README.md` or `docs/` deployment
page that lists compose files, `.env.example` comments.

**Steps:** postgres, redis, two `backend` replicas via `deploy.replicas: 2`
(no `container_name`), two `frontend` replicas, one reverse proxy (Caddy or
nginx) in front of the frontend; `CLUSTER_MODE: multi`, `REDIS_URL: redis://redis:6379`;
attachments on the `database` provider; backups on a shared named volume
with `BACKUP_SHARED_VOLUME: "true"` (a single-host volume is shared by
definition). Every documented command carries `-f docker-compose.ha.yml`
(`scripts/check-docs-manifests.mjs` rejects a bare `docker compose`).

**Acceptance:** `docker compose -f docker-compose.ha.yml up -d --wait` boots
both backends green; killing one backend leaves the app usable.

**Notes:**

### D3 -- CI Redis service

- [x] Status: done.

**Scope:** `.github/workflows/ci.yml` (`backend-integration-tests` job).

**Pattern:** the existing `postgres` service block in that job (digest-pinned
image, `options: --health-cmd ...`, port mapping, job-level env).

**Steps:** add `redis:` with a digest-pinned `redis:7-alpine`,
`--health-cmd "redis-cli ping"`, port `6379:6379`, and `REDIS_URL: redis://localhost:6379`
in the job env. Do not set `CLUSTER_MODE` job-wide; the specs that need it set
it per test.

**Acceptance:** the `zizmor-scan` job stays green (the pin); the job runs
unchanged until R6/T1 add specs.

**Notes:** `redis:7-alpine` resolved to
`sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf`, a
multi-arch index. Resolve a refresh the same way rather than copying a
per-architecture manifest digest, which would pin CI to one runner
architecture.

`zizmor --offline .github/workflows/ci.yml` reports no findings. Note that the
`zizmor-scan` job runs the scan with `|| true` and only uploads SARIF, so it
cannot go red on a finding; the pin is for the finding's sake, not the job's.

### D4 -- E2E shard on `CLUSTER_MODE=multi`

- [ ] Status:

**Scope:** `docker-compose.e2e.yml`, `.github/workflows/ci.yml` (`e2e-tests`
matrix), `e2e/tests/` (a relay round trip and a login-lockout spec that
alternate backends), `e2e/playwright.config.ts` if a project needs the mode.

**Steps:** add `redis` and a second backend service to the compose file
behind the frontend's `INTERNAL_API_URL` (a tiny nginx `upstream` with two
backends, round-robin); one matrix entry sets `CLUSTER_MODE: multi`; the
other three stay `single`. The lockout spec fails login six times and asserts
the seventh is refused regardless of which backend served each attempt.

**Acceptance:** all four shards green; the `multi` shard's container logs
show both backends served requests.

**Traps:** `zz-danger-zone.spec.ts` deletes the shared account; keep
`workers: 1`. The Lighthouse job reuses the same compose file; keep its
default path on one backend so its budgets do not shift.

**Notes:**
