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
  - **A new table is classified in the backup** in the same PR:
    `INTENTIONALLY_EXCLUDED_TABLES` in
    `backend/src/backup/export-table-queries.ts`, or an export query. The
    coverage guard in
    `backend/test/integration/backup-restore.integration.spec.ts` fails a table
    in neither, and it needs a live PostgreSQL, so `npm run test:unit` will not
    tell you. Every table these tasks add is coordination state for one
    deployment and belongs in the excluded set with its reason.
  - **`IF NOT EXISTS` belongs in the migration, not in `schema.sql`.** Do not
    paste the migration's body across unchanged: `db-init` applies `schema.sql`
    once, gated on whether `users` exists, so the guard buys nothing there and
    the plain `CREATE TABLE` / `CREATE INDEX` is a tripwire -- it errors loudly
    if `schema.sql` ever meets a non-empty database instead of skipping and
    leaving a table nobody checked. The file is 80 plain `CREATE TABLE` to one
    guarded (`schema_migrations`, which the migrator bootstraps too).
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
| F2 | `ClusterModule`: mode provider, the `LISTEN` connection in `multi`, connect at boot, readiness probe | F1, F6 | multi-only | [x] |
| F3 | Doc corrections in `concurrency-and-idempotency.md`, `external-side-effects.md`, `cron-jobs.md` | -- | none | [x] |
| F5 | Concurrency register: retire the stale `users.failed_login_attempts` gap row | -- | none | [x] |
| F6 | Retire `REDIS_URL` from F1's boot matrix, `main.ts` and `.env.example` | -- | none | [x] |
| F4 | ADR 0005 and index row | F1 | none | [x] |
| A1 | Migration: `auth_attempt_counters`, `single_use_tokens`; RLS exemption; sweep cron | -- | none | [x] |
| A2 | `AuthAttemptCounterService`; 2FA attempt maps replaced | A1 | neutral | [x] |
| A3 | `usedTotpCodes` replaced by a `single_use_tokens` claim | A1 | neutral | [x] |
| A4 | Step-up and auth-email counters onto the service; interval prune removed | A2 | neutral | [x] |
| K1 | `oauth_instance_config` + `OauthSigningKeysService`; provider gets `jwks` | -- | neutral | [x] |
| X1 | AI action anti-replay onto `single_use_tokens`, MCP path included | A1 | neutral | [x] |
| R1 | `EVENT_BUS` token, interface, `MemoryEventBus` wired as default | -- | none | [x] |
| R2 | Migration: `ai_relay_prompts`, `ai_relay_agents` with RLS policies | -- | none | [x] |
| R3 | Relay queue on rows: insert, claim, answer; in-memory queue maps removed | R1, R2 | neutral | [x] |
| R4 | Late answers, buffered actions and agent liveness on rows; remaining maps removed | R3 | neutral | [x] |
| R5 | Relay attachments on rows (not the storage provider -- see its Notes) | R3 | neutral | [x] |
| R6 | `PostgresEventBus`; selected in `multi`; two-instance spec | F2, R1 | multi-only | [x] |
| T1 | Migration `http_throttle_counters`; `PostgresThrottlerStorage`; selected in `multi`; fail-open | F2 | multi-only | [x] |
| M1 | MCP 2025-era sessions: persisted rows or documented sticky routing | F1 | none | [x] |
| S1 | Boot refusals in `multi` for per-pod attachments and backups | F1 | multi-only | [x] |
| S2 | S3 backup target for automatic backups | -- | none until selected | [ ] |
| C1 | `claimOnce` per owner and month around budget period rollover | -- | neutral | [x] |
| C2 | Deployment-wide `fetch_sync` lease around FX, security price and market index fetches | -- | neutral | [x] |
| C3 | Release-check cache to a one-row table | -- | neutral | [x] |
| C4 | Demo seed under the lifecycle advisory lock | -- | neutral (demo only) | [x] |
| G1 | Whole-tree process-local-state guard with allowlist | A4, X1, R4 | none | [x] |
| G2 | `INV-HA-001..005` in both contract docs | A3, K1, R3, S1 | none | [x] |
| D1 | Helm: Deployments, PDB, spread, autoscaling, `clusterMode` | F2 | none (defaults unchanged) | [x] |
| D2 | `docker-compose.ha.yml` example | F2 | none | [x] |
| D3 | CI: retire the `redis` service and `REDIS_URL` from the integration job | -- | none | [x] |
| D4 | E2E: one shard on `CLUSTER_MODE=multi` with two backends | R6, T1, D1 | none | [x] |

## Suggested order

1. F1 and F3 (done), F5, A1, R1, R2 (no behaviour change, unblock
   everything), then F6 and D3 (done: the two Redis-shaped pieces that shipped
   against the earlier draft, undone before anything built on them).
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

The `REDIS_URL` input (its `multi` refusal, its `single` warning, the spec
rows and the `.env.example` entry) shipped against the earlier draft, which
reserved an optional Redis. The design no longer asks for it, and task F6 has
retired it: `ClusterBootEnv` is `{ CLUSTER_MODE?, JWT_SECRET? }`, and the
`multi` arm of the matrix now checks only what a pure function of the
environment can.

### F2 -- `ClusterModule` and the `LISTEN` connection

- [x] Status: done.

**Scope:** `backend/src/common/cluster/cluster.module.ts` (new),
`backend/src/common/cluster/cluster.module.spec.ts` (new),
`backend/src/common/cluster/pg-listener.provider.ts` (new) + spec,
`backend/src/app.module.ts`, `backend/src/health/health.controller.ts`,
`backend/src/health/health.controller.spec.ts`, `backend/src/health/health.module.ts`,
`backend/src/main.ts` (the connect-at-boot check),
`docs/row-level-security-contract.md` (the sanctioned direct-connection
entry). No dependency: `pg` is already the driver.

**Pattern:** `backend/src/common/demo-mode.module.ts` (a two-provider
`@Global()` module) for the module; `backend/src/db-init.ts` for a dedicated
`pg.Client` built from `DATABASE_*`, except that this one takes the runtime
role from `resolveRlsDatabaseAuth` in `backend/src/common/db/rls-config.ts`,
the same resolution `app.module.ts` gives the pool, because `LISTEN` and
`pg_notify()` need nothing the runtime role lacks;
`backend/src/notifications/email.service.ts` `onModuleInit` for "configured
or not, logged once".

**Steps:**

1. `pg-listener.provider.ts` exports the token `PG_LISTENER` and a small
   class `PgListener` over one `pg.Client`: `connect()` (with `keepAlive`),
   `listen(channel)`, `notify(channel, payload)` (`SELECT pg_notify($1, $2)`),
   an `onNotification` hook, `isConnected()`, and `close()`. On `error` or
   `end` it builds a new client, reconnects with capped exponential backoff
   (1 s to 30 s) and re-issues every `LISTEN` it held, logging through
   `Logger`, never `console`. The factory returns `null` in `single` and a
   connected instance in `multi`.
2. `cluster.module.ts`: `@Global()`, provides `CLUSTER_MODE` (the parsed value
   from `getClusterMode()` in `cluster-mode.ts`) and `PG_LISTENER`;
   `onModuleDestroy` closes it.
3. `main.ts`: after the F1 check, in `multi` only, open the listener and issue
   its first `LISTEN` with a 5 s timeout; failure refuses the boot naming the
   host (never the password) and saying that a transaction-mode pooler cannot
   carry `LISTEN`.
4. `health.controller.ts`: `ready()` in `multi` also requires
   `isConnected()`; failure is `503` like the database. `check()` reports
   `checks.eventBus` in `multi` and omits it in `single`. `live()` is untouched.
5. `docs/row-level-security-contract.md`: a second direct-connection decision
   beside the OAuth adapter's, in the same shape (what it touches: no table;
   why it is outside the door: no tenant and no transaction; what it does not
   authorize: anything else). The adapter's entry says a second exception is a
   separate decision documented there, and this is it.

**Acceptance:** in `single` the module registers `null` and no second
connection is opened (assert with a spy that the factory returned `null`). In
`multi` readiness goes 503 while the listener is disconnected and recovers when
it reconnects, with `LISTEN` re-issued.

**Tests:** module spec for both modes with the client factory mocked;
`pg-listener.provider.spec.ts` with a `pg.Client` double for connect, listen,
notify, and the reconnect-and-relisten path; `health.controller.spec.ts` gains
`ready()` rows for `multi` with the listener up and down, and asserts `single`
never consults it.

**Traps:** `backend/src/module-graph.spec.ts` fails a new module edge that
creates a require cycle without `forwardRef`; a `@Global()` module imported
only by `AppModule` avoids it. A `pg.Client` that has emitted `error` is
unusable afterwards; reconnect means a new `Client`, never `connect()` again
on the old one. The connection must be the runtime role: the owner's
credentials belong to the startup scripts, not to a long-lived connection in
the serving process. Never put a connection string with credentials in a log
line.

**Notes:**

**Scope additions**, each with its reason:
`backend/src/common/cluster/cluster-mode.ts` (the `CLUSTER_MODE` DI token went
there, not in the module file: `ATTACHMENT_STORAGE_PROVIDER` sits in its
interface file for the reason that a consumer needing a token should not have
to import a module file to get it, which is how a require cycle starts);
`backend/src/common/db/direct-connection.guard.spec.ts` (new -- see below);
this task list.

**A guard, because nothing else could see this.** ESLint's database bans are on
imports of `@nestjs/typeorm` and the with-context module, and `pg` is a
legitimate import (type parsers in `main.ts`, the pre-boot scripts), so a
hand-built `new Client(...)` anywhere under `src/` was invisible to every
existing check. `direct-connection.guard.spec.ts` scans for one and holds a
four-entry allowlist with a reason per entry: the three pre-boot scripts and
this listener. It has the shrink-only rule, a stale-entry check and a vacuity
anchor, per `docs/guard-tests.md`. Without it, section 4 of the contract would
be a paragraph asking to be believed.

**The connection is the runtime role's, through the same resolution the pool
uses.** `resolveListenerClientConfig` calls `resolveRlsDatabaseAuth`, so under
`RLS_MODE=enforce` the listener is `monize_app` exactly as TypeORM is. Neither
`LISTEN` nor `pg_notify()` needs a privilege that role lacks. Two connections
to one database that disagree about which role they are is a difference nobody
would look for, and the spec asserts they cannot drift.

**The factory opens no socket.** Connecting is `main.ts`'s, after
`assertRequiredDbFunctionsOrExit` and before `app.listen`, which is what makes
a database host that cannot hold a `LISTEN` one line in the log instead of a
bootstrap rejection with the cause buried -- the reasoning the two database
checks beside it already state. The refusal names the host and says a
transaction-mode pooler cannot carry `LISTEN`.

**The error and end handlers are armed only after a successful connect.** A
`pg.Client` whose connect fails rejects the promise; arming them first would
make that same failure schedule a reconnect, so the boot check would
`process.exit(1)` while a retry loop it does not know about kept running. A
spec asserts the listener counts on a failed client are zero rather than
emitting `error` at it -- an `EventEmitter` with no `error` listener throws on
emit, which would fail for the right reason but report as an unhandled error
rather than as a claim.

**`PG_WAKEUP_CHANNEL` is defined here, which R6 will use.** The boot check has
to `LISTEN` on something to prove the connection can hold one, and a throwaway
channel left subscribed would be untidier than the real one. One fixed channel
per deployment with the recipient named inside each payload, rather than one
channel per subscriber: a subscribe happens on every SSE open and every agent
long-poll, so `LISTEN`/`UNLISTEN` churn would be on the hot path. R6 does the
routing.

**A channel name is validated, not quoted.** `LISTEN` takes no bind parameter,
so the name is interpolated; rather than quote arbitrary input the grammar is
narrowed to `[a-z_][a-z0-9_]*` at most 63 characters. The length bound is not
cosmetic -- PostgreSQL truncates a longer identifier, so the notifier and the
listener would agree on a string and disagree on a channel.

**Readiness has three states, not two.** `checkNotificationChannel()` returns
`null` in `single` (nothing to check), so `checks.eventBus` is absent there
rather than permanently `"healthy"` -- a key that is always healthy invites a
dashboard to watch a constant. In `multi` a missing listener counts as down,
not as absent: that combination is a wiring defect, and serving traffic on it
is the silent-wake-up failure the mode exists to prevent. The reason is logged;
the response body keeps the existing generic refusal, so no new user-facing
string was added.

**For G1:** `PgListener.channels` and `PgListener.handlers` are process-local by
construction -- they describe this replica's own connection and its own
subscribers, and there is nothing for a second replica to share. Add both to
the allowlist with that reason.

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

### F6 -- Retire `REDIS_URL` from F1

- [x] Status: done, in the follow-up to PR
  [#1407](https://github.com/kenlasko/monize/pull/1407) (that PR revised the
  plan; this task and D3 carry the revision into the code and the workflow).

**Scope:** `backend/src/common/cluster/cluster-mode.ts` and its spec,
`backend/src/main.ts` (the `assertClusterBootOrExit` call), `.env.example`
(the `REDIS_URL` entry, and the sentence in the `CLUSTER_MODE` entry that
names it).

**Pattern:** the F1 commits, run backwards; the header comment in
`cluster-mode.ts` ("a row or a Redis key") becomes "a row".

**Steps:** remove `REDIS_URL` from `ClusterBootEnv`, its `multi` refusal and
its `single` warning from `checkClusterBoot`, the four matrix rows and the two
assertions that name it from `cluster-mode.spec.ts`, the argument from the
call in `main.ts`, and the entry from `.env.example`; reword the `multi` line
there to what `multi` now requires (a session-capable `DATABASE_HOST`, and the
storage assertions S1 adds). `node scripts/check-env-docs.mjs` stays green
only if nothing still reads `process.env.REDIS_URL` when its `.env.example`
entry goes.

**Acceptance:** `grep -ri redis backend/src/common/cluster .env.example` is
empty; `CLUSTER_MODE=multi` with a valid `JWT_SECRET` and no `REDIS_URL`
passes the matrix (F2 then adds the connection check).

**Tests:** the spec's matrix loses the four rows and gains one: `multi` with
only `JWT_SECRET` set reports no refusal.

**Traps:** this task lands **before** F2, so between the two nothing checks
at boot that a second replica can be woken. That is acceptable only because
nothing selects a multi-replica bus until R6; say so in the PR.

**Notes:** `checkClusterBoot` now emits no warning on any input. The
`warnings` field stays on `ClusterBootReport` rather than being removed with
its only producer: S1 adds the first of the next ones (the `database`
attachment provider in `multi`), and the matrix's nine rows each assert an
empty `warnings`, so the field is pinned rather than unobserved. `main.ts` is
unchanged apart from the dropped argument -- it already loops over whatever
warnings it is handed.

Two specs needed more than a deletion.

1. **"reports every problem at once"** paired a missing `JWT_SECRET` with the
   missing `REDIS_URL`, and `multi` no longer has a second refusal to pair
   with. It now pairs an unparsable `CLUSTER_MODE` with the missing secret,
   which is the same property (an operator restarting a crash-looping
   container reads every reason at once) over the inputs that remain, and it
   covers the more interesting path: a mode that did not parse must not stop
   the secret being judged.
2. **"does not warn about an unused `REDIS_URL` when the mode did not parse"**
   was deleted rather than rewritten. Its subject was the one warning that
   existed; with no warning to suppress there is nothing left to assert, and a
   rewritten version would have asserted that an empty list is empty. The
   matrix rows carry that claim already.

The `multi` matrix row keeps a comment naming what `multi` does still require
-- a database host that can hold `LISTEN`, and cluster-safe attachment and
backup storage -- and which task adds each check, so the row does not read as
"multi needs nothing".

### F4 -- ADR 0005

- [x] Status: done.

**Scope:** `docs/adr/0005-cluster-mode-on-postgresql-alone.md` (new),
`docs/adr/README.md` (index row).

**Pattern:** `docs/adr/0004-mcp-two-eras-request-identity-and-mrtr-confirmation.md`
for length and tone; the template in `docs/adr/README.md`.

**Steps:** Status `accepted`, today's date. Context: the survey in the design
doc's "current state" table, and that the plan's first draft reserved an
optional Redis for the throttler's counters and the wake-up channel.
Decision: PostgreSQL for every piece of replica-shared state in both modes:
correctness-bearing rows under the mechanisms of
`docs/concurrency-and-idempotency.md`, the throttler's counters on an
`UNLOGGED` table, the wake-up channel on `LISTEN`/`NOTIFY` over one dedicated
connection per replica; explicit `CLUSTER_MODE`. Consequences: `single` gains
durability across restarts; `multi` adds no dependency, one session-level
connection per replica and one readiness check; the relay is now a table; the
throttler path costs one write per request in `multi`. Alternatives
considered: an optional Redis (rejected: a second stateful service to run,
back up, secure and probe, for two concerns whose PostgreSQL shapes cost less
than the operations of a second store, and whose one real advantage, a
hot-path counter without a write, `UNLOGGED` answers); sticky routing
(rejected: it does not fix the correctness rows and it silently fails on a
replica loss); `LISTEN` on the pooled connections (rejected: session state on
the runtime pool is what the RLS design forbids, and a transaction-mode pooler
drops it); always-on clustering (rejected: the requirement is that
single-replica deployments need nothing new).

**Acceptance:** index row present; `doc-paths` guard green.

**Notes:** marked retrospective on the `Date` line, per `docs/adr/README.md`:
the decision was taken with the plan and most of it has shipped, so a bare
date would read as a decision taken on 2026-09-19. The README's sentence
listing the retrospective ADRs was updated with it.

Two consequences recorded that the task's outline did not name, because they
are decisions a future reader would otherwise have to re-derive: the throttler's
deliberate fail-open as an exception to INV-HA-001, and G1's guard as the thing
that now makes per-replica state a written decision. One extra alternative is
recorded for the same reason -- leader election for the duplicated provider
fetches, rejected in favour of C2's `fetch_sync` lease.

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

- [x] Status: done.

**Scope:** `backend/src/auth/auth-attempt-counter.service.ts` (new),
`backend/src/auth/auth-attempt-counter.service.spec.ts` (new),
`backend/src/auth/two-factor.service.ts`, `backend/src/auth/two-factor.service.spec.ts`,
`backend/src/auth/auth.module.ts`,
`backend/test/integration/auth-attempt-counter.integration.spec.ts` (new),
`backend/src/test-helpers/auth-attempt-counter-testing.ts` (new, added to scope:
the limiter thresholds are asserted by more than one spec, so the double that
reproduces the statement's semantics belongs beside the other service doubles
rather than copied per spec), `backend/src/auth/auth.service.spec.ts` (added to
scope: it constructs a real `TwoFactorService`, so the new constructor argument
has to be provided there or the module cannot compile).

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

**Notes:** the window is **5 minutes**, not `BASE_LOCKOUT_MS`, which this task's
step 2 named. The `Map` entries carried `Date.now() + 5 * 60 * 1000`, and the
acceptance is "the same limits as today", so the constant moved across as
`ATTEMPT_WINDOW_MS`. `BASE_LOCKOUT_MS` is the separate, longer clock the tenth
per-user failure writes to `users.locked_until`; conflating the two would have
made a lockout six times longer than it is now.

`increment` always runs through `runOutsideActiveScopedManager`, not only when a
caller happens to hold a transaction: a failure counter written inside the
transaction that then refuses the request rolls back with the refusal, and the
limiter counts nothing. `verify2FA` holds no ambient transaction today, so the
call is a no-op there, but the property is the service's, not the call site's.
`peek` and `reset` join the caller's transaction as usual.

Scopes are exported from `two-factor.service.ts` as `TWO_FACTOR_TOKEN_SCOPE`
(`2fa-token`) and `TWO_FACTOR_USER_SCOPE` (`2fa-user`) so the specs assert the
strings rather than re-spell them.

### A3 -- `usedTotpCodes` replaced by a single-use claim

- [x] Status: done.

**Scope:** `backend/src/auth/single-use-token.service.ts` (new),
`backend/src/auth/single-use-token.service.spec.ts` (new),
`backend/src/auth/two-factor.service.ts`, `backend/src/auth/two-factor.service.spec.ts`,
`backend/src/auth/auth.module.ts`,
`backend/test/integration/single-use-token.integration.spec.ts` (new),
`backend/src/test-helpers/single-use-token-testing.ts` (new, added to scope: the
double has to *lose* the second claim or the replay assertions assert nothing,
and two specs need it), `backend/src/auth/auth.service.spec.ts` (added to scope:
it builds a real `TwoFactorService`, so the new constructor argument is provided
there too).

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

**Notes:** the hash is taken in Node (`hashToken`, the helper the trusted-device
path already uses) rather than as `sha256($2)` in SQL, so the code never leaves
the process -- not as a bind parameter, not in a statement log. It also keeps the
service off `pgcrypto`, which would otherwise need a
`required-db-functions.ts` entry.

On the login path the lost claim folds into `isValid` rather than throwing after
it. The previous code treated a replayed code as an invalid one -- counters
incremented, account lockable, same message -- and a separate refusal after the
counter reset would have quietly let a replayer clear a victim's failure count.
The claim still runs after `otplib.verifySync` and before any token is issued.

`TOTP_CLAIM_PURPOSE` is exported and both TOTP paths (`verify2FA` and
`verifyTotpForUser`) call one private `claimTotpCode`, so the login and step-up
surfaces cannot drift into two purposes and stop protecting each other.

`claim` joins the caller's transaction, which is the opposite of A2's
`increment` and deliberate: a claim guards work, so a failed apply must give it
back. X1 depends on that.

### A4 -- Step-up and auth-email counters; interval prune removed

- [x] Status: done.

**Scope:** `backend/src/auth/step-up/step-up.service.ts` and its spec,
`backend/src/auth/auth-email.service.ts` and its spec,
`backend/src/auth/auth.service.ts` and `backend/src/auth/auth.controller.ts`
(added to scope: the two limit checks are asynchronous now, so the controller
awaits them and `auth.service.ts` -- already on `WITH_CONTEXT_ALLOWLIST` --
seeds the system context its sibling public-path methods already seed),
`backend/src/auth/auth.service.spec.ts` (it drives both limits end to end).

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

**Notes:** the forgot-password route does **not** seed a usable context. The
`RequestContextInterceptor` runs `requestContextStorage.run` with `userId`
undefined on an unauthenticated request, and `withScopedDb` throws on a context
that carries neither a user nor `system`. The `withSystemContext` wrap therefore
went on `auth.service.ts`, beside `resetPassword`, `generateVerificationToken`
and `verifyEmail`, which each already wrap the same service for the same reason
-- so `WITH_CONTEXT_ALLOWLIST` did not have to grow.

Both checks return `Promise<boolean>` now, so the two controller call sites
await them. The semantics are unchanged: `increment` keeps `window_expires_at`
where the first attempt set it, which is what the old `windowStart` field did,
and the limit is `count <= 3`.

Keys are `sha256(lowercased, trimmed email)`. The plaintext address would have
made an RLS-exempt, owner-less table a directory of who has asked for a password
reset -- exactly the enumeration both endpoints answer generically to prevent.
The step-up key stays plaintext `userId:purpose`: neither half is a secret.

Scopes are exported (`FORGOT_PASSWORD_SCOPE`, `VERIFICATION_EMAIL_SCOPE`,
`STEP_UP_ATTEMPT_SCOPE`) and asserted in the specs.

### K1 -- OIDC provider signing keys persisted

- [x] Status: done.

**Scope:** one migration + `schema.sql` (`oauth_instance_config`),
`backend/src/oauth/entities/oauth-instance-config.entity.ts` (new),
`backend/src/oauth/oauth-signing-keys.service.ts` (new) + spec,
`backend/src/oauth/oauth-provider.service.ts` and its spec,
`backend/src/oauth/oauth.module.ts`, `backend/src/common/db/rls-exempt-tables.ts`,
`docs/row-level-security-contract.md`,
`backend/src/common/encryption/encryption-key.ts` (the warning text -- it lives
there, not in `main.ts`, which only calls `logEncryptionKeyStatus`),
`backend/eslint.config.mjs` (`WITH_CONTEXT_ALLOWLIST`),
`backend/src/backup/export-table-queries.ts` (the new table's backup
classification, which the definition of done requires),
`backend/test/integration/oauth-signing-keys.integration.spec.ts` (new, in place
of the E2E restart case -- see the notes). **No file under `e2e/` changed.**

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

**Notes:** three deviations, each deliberate.

1. **`node:crypto`, not `jose`.** `generateKeyPairSync` plus
   `KeyObject.export({ format: "jwk" })` is the whole of what this needed, and
   the `kid` is a hand-written RFC 7638 thumbprint (nine lines). `jose` is
   ESM-only, so reaching it from this CommonJS build means a dynamic import, and
   pinning it directly is a dependency change -- which `AGENTS.md` puts under
   "ask first" -- for something the platform already does synchronously.
2. **An integration spec instead of the E2E restart case.** The property is "a
   second process over the same row serves the same `kid`s", and a fresh service
   over the same database is exactly that, with a real `EncryptionService` and a
   real key. A `docker compose restart backend` inside the E2E suite would say
   the same thing at far higher cost, and the spec that says it is where the
   race between two starting replicas is also tested.
3. **The warning text is in `encryption-key.ts`.** `main.ts` only calls
   `logEncryptionKeyStatus`; the words are `MISSING_ENCRYPTION_KEY_WARNING_LINES`,
   and that is the line that now also names the per-process JWKS. The service
   logs its own, more specific warning at the point it declines to store keys.

The provider's development-key `NOTICE` was not asserted on: it is emitted by
`oidc-provider` itself, which the provider spec replaces with a mock (it is ESM
and never loaded there), so an assertion would be about the mock. What the spec
asserts instead is the input that decides it -- `jwks` present in the
constructor config when there are stored keys, and the option absent entirely
when there are not.

An unreadable row (a database restored onto an instance with a different
`ENCRYPTION_KEY`) logs and falls back to per-process keys rather than throwing:
refusing to start the OAuth provider would take the whole MCP surface down over
something an operator fixes by deleting one row.

### X1 -- AI action anti-replay onto `single_use_tokens`

- [x] Status: done.

**Scope:** `backend/src/ai/actions/ai-actions.service.ts` and its spec,
`backend/src/ai/ai.module.ts` (import of the auth single-use service or a
shared module), the MCP confirmation path under `backend/src/mcp/` that
accepts the same descriptor (grep `actionId` and the descriptor verifier),
`backend/test/integration/ai-action-replay.integration.spec.ts` (new),
`backend/src/auth/single-use-token.module.ts` (new) and
`backend/src/auth/single-use-token.service.ts` (`release`),
`backend/src/auth/auth.module.ts`,
`backend/src/test-helpers/single-use-token-testing.ts` (`release` on the
double). **No file under `backend/src/mcp/` changed** -- see the notes.

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

**Notes:** three things this task assumed turned out not to hold. Each is
recorded here because the next task that reasons about these paths will assume
them too.

1. **There is no `withScopedDb` that applies the action.** `execute` dispatches
   to `TransactionsService`, `PayeesService`, `SecuritiesService` and the rest,
   and each opens its own. Wrapping `execute` in one transaction so the claim
   could roll back with it would make every nested call join that transaction,
   which moves the post-commit cache invalidation (INV-CACHE-001) and the
   action-history write inside it -- both of which are documented to happen
   after the commit, and one of which has its own guard spec. The claim is
   therefore taken before `execute` and released in the `catch`, which is
   exactly the `Map`'s old lifecycle, now durable and shared. The task's
   acceptance is met either way: one apply and one refusal across two replicas,
   and a failed apply leaves the descriptor confirmable.
2. **The claim is taken after the write-limit check**, where the `Map`'s
   reservation was. A refused limit must not burn a descriptor the user can
   confirm tomorrow.
3. **The MCP surface already shares the claim, and has no second entry point.**
   `AiActionsService.confirm` is the only place that verifies a descriptor
   returned by a client. The MCP write tools mint and commit their own pending
   action in-process (`commitCard`) and never accept one back, and a relayed
   card is committed through `/ai/actions/confirm` -- the same method, the same
   `actionId`, the same claim. Nothing under `src/mcp/` needed changing.

`AiModule` imports a new one-provider `SingleUseTokenModule` rather than
`AuthModule`: the service's only dependency is `DataSource`, and the
`AuthModule` edge would have pulled users, notifications and delegation into
`AiModule` to reach it. `AuthModule` imports and re-exports the same module, so
there is still one service and one table.

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

The `name` literal shipped as `"memory" | "redis"`, and the header comments of
the interface, the memory bus and `wake-signal.ts` describe a Redis restart as
the way a wake-up is lost. R6 renames the literal to `"postgres"` and rewrites
the three comments with the implementation they name.

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

- [x] Status: done.

**Scope:** `backend/src/ai/relay/ai-relay.service.ts` and its spec,
`backend/src/ai/relay/ai-relay.controller.ts` and its spec,
`backend/src/ai/relay/ai-relay.types.ts`, `backend/src/mcp/tools/relay.tool.ts`
and its spec, `backend/src/ai/relay/ai-relay.module.ts`,
`backend/test/integration/ai-relay-claim.integration.spec.ts` (new).

Added to Scope while doing the work, each with its reason:
`backend/src/common/events/wake-signal.ts` + spec (the park-and-re-read latch
both waiters need), `backend/src/ai/relay/relay-stream.registry.ts` + spec (the
open SSE sockets, which cannot become rows),
`backend/src/ai/relay/relay-rows.harness.ts` (a table that answers the
service's statements, so the behavioural spec stays behavioural),
`backend/src/mcp/mcp-relay-confirm.ts` + spec and
`backend/src/mcp/mcp-relay-tool-activity.ts` and the three tool files
(`investments`, `transactions`, `payees`) plus `backend/src/ai/ai.service.ts`:
the relay's answers now come from a row, so `emitPendingAction`,
`reportToolActivity` and `getStatus` are async and every call site awaits.

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
describes one socket). Wake-ups can be lost (a listener reconnecting), so
every waiter also polls the row on a slow timer (the existing long-poll timeout is the
ceiling). Do not let the bus payload carry the prompt or the answer.

**Notes:**

`expires_at` carries the whole deadline, so no column was added: the insert sets
it to now + `QUEUE_WAIT_MS`, the claim resets it to now + `IDLE_TIMEOUT_MS`, and
every liveness signal pushes it out to
`LEAST(now + IDLE_TIMEOUT_MS, claimed_at + HARD_WAIT_MS)`. That is one statement
per signal instead of a rescheduled `setTimeout`, and it is what makes the
browser's deadline something a second replica can move.

`buffered` and `awaitingLate` went in this task rather than in R4. The row model
subsumes them: an answer posted after the browser gave up is the same
`status='answered'` row, so `post_response` needs no separate late path and
`takeBufferedResponse` is a conditional `UPDATE ... WHERE status='answered'`
that hands it over once. What R4 still owns is the agent-liveness row, the
action cards and the sweeper.

Three deliberate behaviour changes, each visible in `single`:
- A second `post_response` for one prompt now returns `delivered:false` (the
  `UPDATE` matched nothing) where the in-memory version returned an idempotent
  `true` for a buffered answer. The tool's own description already said
  `delivered:false` means "unknown or already answered".
- A closed browser socket ends the waiter at once (`RelayStreamClosedError`)
  instead of leaving the promise parked for the rest of the deadline. The row is
  untouched, so the agent may still answer it and the pickup endpoint serves it.
- A prompt survives a backend restart mid-wait, which is the named change.

The late-answer window is `expires_at + BUFFER_TTL_MS`, checked in the
`post_response` statement, so the grace no longer depends on a sweeper having
not yet run.

### R4 -- Late answers, buffered actions and liveness on rows

- [x] Status: done.

**Scope:** `backend/src/ai/relay/ai-relay.service.ts` and spec,
`backend/src/ai/relay/ai-relay.controller.ts` and spec (`GET response/:promptId`
and the action pickup endpoint), `backend/src/ai/relay/relay-sweeper.service.ts`
(new cron) and spec, `docs/cron-jobs.md`.

Added to Scope: `backend/src/ai/relay/ai-relay.module.ts` (declares the cron),
`backend/eslint.config.mjs` (`WITH_CONTEXT_ALLOWLIST` -- the sweep is a
cross-user cron with no request to inherit an identity from),
`backend/src/mcp/tools/relay.tool.ts` (`shouldStopForIdle` reads a row now) and
`backend/src/ai/relay/relay-rows.harness.ts` plus
`backend/test/integration/ai-relay-claim.integration.spec.ts` (the two new
tables).

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

Step 1 landed in R3: the row model subsumed the late-answer buffer, so
`takeBufferedResponse` is a conditional `UPDATE ... WHERE status='answered'`
that returns the answer and sets `expired`. `expired` is the consumed state
rather than a `picked_up_at` column, so no migration was needed and the pickup
endpoint stays single-use by the same rule every other transition uses.

`shouldStopForIdle` is one upsert, not a read and a write: start, elapse and
disconnect are all `ON CONFLICT DO UPDATE ... CASE`, because two replicas
serving the same agent's polls would otherwise each start the clock and neither
finish it.

The per-user cap on buffered cards (`MAX_BUFFERED_PER_USER`) is gone. It bounded
*memory*; a row costs nothing to hold, only an agent that already holds a
claimed turn can write one, and `expires_at` plus the sweeper bound the table.
The card id keeps its meaning instead: the insert is
`ON CONFLICT (user_id, id) DO NOTHING`, so a repeat of one card is one card.

`getStatus` stays one query -- a `LEFT JOIN LATERAL` over the prompts beside the
agent row -- because the browser polls it.

### R5 -- Relay attachments through the storage provider

- [x] Status: done, but **not through the storage provider** -- see Notes.

**Scope:** `backend/src/ai/relay/relay-attachment.store.ts` and spec,
`backend/src/ai/relay/ai-relay.module.ts` (inject `ATTACHMENT_STORAGE_PROVIDER`),
a small migration + `schema.sql` for `ai_relay_attachments (id, user_id, storage_key, mime, size, expires_at)`,
`backend/src/attachments/storage/storage-key.util.ts` if the key grammar
needs a `relay/` prefix.

Actually touched: the store and its spec, the migration and `schema.sql` (two
tables, not one), two new entities, `relay-sweeper.service.ts` (it reclaims
them), `docs/external-side-effects.md`, `docs/cron-jobs.md`,
`backend/src/backup/export-table-queries.ts` (the coverage guard),
`backend/test/integration/rls-enforcement.integration.spec.ts` (`INDIRECT_MAP`),
and the consumers the store's newly async methods reach:
`backend/src/mcp/resources/relay-attachment.resource.ts`,
`backend/src/ai/actions/ai-actions.service.ts`,
`backend/src/ai/query/tool-executor.service.ts`,
`backend/src/mcp/tools/transactions.tool.ts`. `storage-key.util.ts` was not
touched -- nothing needed a new key grammar.

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

**The storage provider cannot hold a relay attachment.** Its `database`
implementation writes `attachment_blobs`, whose primary key is a foreign key to
`transaction_attachments(id)` and whose RLS policy reads the owner from that
same row. A relay attachment has no transaction and no attachment row, so the
insert fails the foreign key outright and the policy would hide it even if it
did not. The remaining options were to weaken that foreign key (a guard, and
shrink-only), or to branch on the bound provider's name inside the relay, which
is the generic solution that looks fine in isolation and wrong in place.

So the bytes are rows: `ai_relay_attachments` plus a cascading
`ai_relay_attachment_blobs`, mirroring
`transaction_attachments`/`attachment_blobs` so metadata lookups never touch
BYTEA. That buys more than the provider would have. Bytes and metadata commit or
roll back together on every deployment -- there is no bytes-before-commit window
at all, which the `local` and `s3` attachment paths still have (EXT-004) -- and
the cascade reclaims the bytes, so the sweep is one `DELETE` with nothing
outside PostgreSQL to order against or leak. The trap above therefore does not
arise: there is no relay key for the orphan sweeper to see, and it enumerates
`attachment_blob_tombstones` rather than the store in any case.

The cost, stated plainly: a deployment running `ATTACHMENT_STORAGE_PROVIDER=s3`
or `local` to keep attachment bytes out of PostgreSQL still holds relay
attachments there -- at most a few megabytes, for at most twenty minutes, and
deleted as soon as the prompt settles. If that ever stops being acceptable, the
move is a relay-owned provider whose key space is not `transaction_attachments`,
not a branch inside this store.

Two things the sketched shape needed: `filename` and `kind` columns (the MCP
resource returns text, a PDF's extracted text or a base64 blob, and re-deriving
that from the prompt JSONB would be a second source of truth), and `kind`
carrying `DEFAULT 'text'` for the same reason `ai_relay_prompts.status` carries
`DEFAULT 'pending'` -- the RLS enforcement spec's generic seeder invents a
`t<n>` string for a NOT NULL text column with no default, which no
CHECK-constrained column can accept.

`byUser` is gone, and with it the per-user cap: it bounded process memory, and
the TTL plus the sweep bound a table.

### R6 -- `PostgresEventBus`

- [x] Status: done.

**Scope:** `backend/src/common/events/postgres-event-bus.ts` (new) + spec,
`backend/src/common/events/event-bus.module.ts`,
`backend/src/common/events/event-bus.interface.ts` (the `name` literal and
the header comment), `backend/src/common/events/memory-event-bus.ts` and
`backend/src/common/events/wake-signal.ts` (header comments that name the
Redis bus R1 expected), `backend/src/ai/relay/ai-relay.service.spec.ts` (the
"redis unreachable" error text in its rejected-publish case),
`backend/test/integration/postgres-event-bus.integration.spec.ts` (new).

**Pattern:** `MemoryEventBus` for the local fan-out and the
snapshot-before-delivery rule; F2's `PgListener` for the connection.

**Steps:**

1. `PostgresEventBus` takes `PG_LISTENER`. On construction it issues one
   `LISTEN monize_wakeups` (re-issued by the listener on reconnect) and
   registers an `onNotification` hook that parses the JSON payload
   `{ "channel": string, "payload": object }` and delivers to the local
   handlers subscribed to exactly that channel, on the next microtask, with
   the same snapshot-and-idempotent-unsubscribe semantics as `MemoryEventBus`.
   `subscribe` and unsubscribe touch only the local map; the session sees one
   `LISTEN` for the life of the process.
2. `publish` serialises `{ channel, payload }`, refuses anything over 4 KB
   (the server's limit is 8000 bytes and a wake-up is a few ids), and calls
   `notify("monize_wakeups", json)` on the listener connection. A publish
   while the connection is down rejects; the relay already tolerates a
   rejected publish (its spec has the case) because every waiter polls.
3. `event-bus.module.ts`'s factory returns it in `multi`, injecting
   `CLUSTER_MODE` and `PG_LISTENER`. `name` becomes `"memory" | "postgres"`.
4. Rewrite the three header comments: the bus can lose a message because a
   notification sent while a listener is reconnecting is gone, not because
   of a Redis restart.

**Acceptance:** two bus instances over two `PgListener`s to one database
deliver a publish on A to a subscriber on B, and a publish on A to a
subscriber on A.

**Tests:** unit spec with a `PgListener` double (delivery by exact channel,
the 4 KB refusal, a malformed payload logged and dropped, a throwing handler
not stopping the others); the integration spec opens two real `pg.Client`s
against the PostgreSQL service the integration job already has.

**Traps:** `NOTIFY` de-duplicates identical payloads within one transaction;
the listener connection is autocommit so that never applies, but a future
caller publishing through the pool inside a transaction would see two
identical wake-ups collapse to one, harmless for a hint and worth a comment.
A dropped socket surfaces as `error` on the client; the reconnect is F2's, not
this file's. A `LISTEN` channel is an identifier (63 bytes, quoted if it
carries anything but a plain name) while `pg_notify()` takes text; keep the
one fixed channel and put the routing in the payload.

**Notes:**

**`UNLISTEN` is global to the session, which is why `subscribe` does not touch
the connection at all.** One `LISTEN monize_wakeups` is issued for the life of
the process and every subscribe and unsubscribe is a local map operation. Per
subscriber channels would have been the obvious design and are wrong twice
over: a subscribe happens on every SSE open and every agent long-poll, so the
churn would be on the hot path, and one request's `UNLISTEN` would deafen every
other request sharing that session. The cost is that each replica hears every
wake-up and drops the ones it has no subscriber for -- a string comparison per
replica, against a volume bounded by how often a person sends a chat message.

**The `EventBusModule` factory refuses rather than falling back.** A `multi`
deployment with no `PG_LISTENER` is a wiring defect, not a mode, and quietly
returning `MemoryEventBus` there would leave every SSE stream on its slow poll
with nothing in the log saying why. `main.ts` already refuses the boot before
this is reached, so the throw is a second wall.

**The bus subscribes to the connection in its constructor, not in `start()`.**
`main.ts` issues the same `LISTEN` as its boot check, so the two race; a bus
that only wired its handler in `start()` could miss a notification that arrived
first. `start()` is therefore just the idempotent `listen()` call, kept so a bus
constructed in a spec or a script is not silently deaf. A spec asserts delivery
without `start()` ever being called.

**The size limit is measured in bytes.** PostgreSQL's cap is 8000 bytes, the
bus refuses at 4096, and `Buffer.byteLength` rather than `String.length` is
what makes a multi-byte payload fail here with a message naming the rule rather
than at the server with a `22023`.

**Three comments that named Redis were rewritten, not just re-pointed**:
`event-bus.interface.ts` (the reason a message can be lost is now a listener
reconnecting, which is the mechanism that actually applies), `memory-event-bus.ts`
(both its allowlist reason and its next-microtask rationale) and
`wake-signal.ts`. The `name` literal is `"memory" | "postgres"`. The relay
spec's two rejected-publish cases spelled their error `"redis unreachable"`;
they now spell what `PgListener.notify` actually throws.

**The reconnect case in the integration spec kills by `application_name`.** The
two listeners set one at connect, so `pg_terminate_backend` finds exactly them
and leaves the rest of the suite's pools alone. Matching on `query` -- the
obvious alternative -- holds whichever statement ran last on that session, which
is `SELECT pg_notify(...)` as often as it is `LISTEN`. Both sessions are
dropped together, which is what a database restart looks like from here, and
the assertion that matters is not that the connection came back but that its
`LISTEN` came back with it.

**For G1:** `PostgresEventBus.handlers` is process-local by design, the same as
`MemoryEventBus.handlers`: it describes the requests this replica is serving.

### T1 -- `PostgresThrottlerStorage`

- [x] Status: done.

**Scope:** one migration + `database/schema.sql` (`http_throttle_counters`),
`backend/src/common/throttler/http-throttle-counter.entity.ts` (new),
`backend/src/common/throttler/postgres-throttler-storage.ts` (new) + spec,
`backend/src/app.module.ts` (`ThrottlerModule.forRootAsync`),
`backend/src/common/db/rls-exempt-tables.ts`,
`docs/row-level-security-contract.md`,
`backend/src/backup/export-table-queries.ts` (the table's backup
classification), `backend/src/auth/auth-state-sweeper.service.ts` and spec (a
third `DELETE`), `docs/cron-jobs.md` (that sweeper's row),
`backend/eslint.config.mjs` (`WITH_CONTEXT_ALLOWLIST`),
`backend/test/integration/postgres-throttler.integration.spec.ts` (new).

**Pattern:** `@nestjs/throttler` 6.x's `ThrottlerStorage` interface
(`increment(key, ttl, limit, blockDuration, throttlerName)` returning
`{ totalHits, timeToExpire, isBlocked, timeToBlockExpire }`); verify the exact
signature against the installed version in `backend/node_modules` before
writing. A2's `AuthAttemptCounterService` for the one-statement upsert and for
`runOutsideActiveScopedManager`.

**Steps:**

1. Migration: `CREATE UNLOGGED TABLE IF NOT EXISTS http_throttle_counters (name TEXT NOT NULL, key TEXT NOT NULL, hits INTEGER NOT NULL, window_expires_at TIMESTAMPTZ NOT NULL, blocked_until TIMESTAMPTZ, PRIMARY KEY (name, key))`
   with an index on `window_expires_at` for the sweep; mirrored in
   `schema.sql` without the `IF NOT EXISTS` but with the `UNLOGGED`. The
   entity cannot express `UNLOGGED` and does not need to: the integration
   harness builds a logged copy, and nothing the spec asserts depends on
   durability. RLS-exempt with the `auth_attempt_counters` reason (opaque
   key, no owner, written before any identity exists); excluded from the
   backup with the reason that it is a cache.
2. `increment` is one statement: `INSERT INTO http_throttle_counters (name, key, hits, window_expires_at, blocked_until) VALUES ($1, $2, 1, now() + $3, NULL) ON CONFLICT (name, key) DO UPDATE SET hits = CASE WHEN t.window_expires_at < now() THEN 1 ELSE t.hits + 1 END, window_expires_at = CASE WHEN t.window_expires_at < now() THEN now() + $3 ELSE t.window_expires_at END, blocked_until = CASE WHEN (CASE WHEN t.window_expires_at < now() THEN 1 ELSE t.hits + 1 END) > $4 THEN now() + $5 ELSE t.blocked_until END RETURNING hits, window_expires_at, blocked_until, now() AS db_now`
   (`t` aliasing the table). The nested `CASE` repeats the hits expression
   because a `SET` list cannot read the value it is assigning. `isBlocked` is
   `blocked_until > db_now`; `timeToExpire` and `timeToBlockExpire` are the
   stored timestamps minus `db_now`, never the process clock. While a row is
   blocked its count no longer matters; the block wins, as the library's
   in-memory storage does.
3. The guard runs before `RequestContextInterceptor`, so there is no ambient
   identity: the storage seeds `withSystemContext` around its one
   `withScopedDb` and the file joins `WITH_CONTEXT_ALLOWLIST` as a reviewed
   decision. Run it through `runOutsideActiveScopedManager` as A2 does, for
   the same reason: a counter that joins a transaction the handler later rolls
   back counts nothing.
4. Fail open: on any error return `{ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }`
   and log at most once per minute with a process-local timestamp (allowlist
   it in G1 with the reason: it is a log throttle).
5. `app.module.ts`: `ThrottlerModule.forRootAsync` with
   `inject: [CLUSTER_MODE, PostgresThrottlerStorage]`; `storage` is set only in
   `multi`, so `single` keeps the library default object untouched and pays
   no write.
6. `auth-state-sweeper.service.ts` gains
   `DELETE FROM http_throttle_counters WHERE window_expires_at < now() AND (blocked_until IS NULL OR blocked_until < now())`;
   the `docs/cron-jobs.md` row names the third table.

**Acceptance:** in `multi`, 100 requests spread over two backends trip the
default `limit(100)`; in `single`, the storage class is never constructed.

**Tests:** unit spec for the statement and the fail-open path with a mocked
manager; integration spec with two storage instances over two connections
incrementing one key concurrently and reading `{1, 2}` in some order, a block
once `hits > limit`, and a reset once `window_expires_at` passes (`pg_sleep`
on a short ttl, not a fake clock: the predicate is the database's).

**Traps:** `RATE_LIMIT_MAX` via `rateLimit()` in
`backend/src/common/throttle.util.ts` is raise-only; do not change it. The
health controller is `@SkipThrottle()`; keep it so. The key the guard hands
over is already an opaque hash of tracker and route; do not add the raw IP to
the row. `UNLOGGED` tables are not replicated to a streaming standby: a
failover starts with an empty table, one window of leniency, which is the
documented cost, not a defect.

**Notes:**

**Scope additions**, each with its reason:
`backend/src/common/throttler/throttler-storage.module.ts` (new -- see below);
`backend/src/common/throttler/http-throttle-counter.entity.ts` (the integration
harness builds its schema from entity metadata, so a table with no entity does
not exist there); this task list.

**`forRootAsync` needs the storage in a module it imports.** It resolves its
`inject` list inside the dynamic module it builds, so a provider declared
beside it in `AppModule`'s own `providers` is out of scope there and the
failure is a boot-time "Nest can't resolve dependencies" naming a class that is
plainly present. Hence a one-provider `ThrottlerStorageModule` passed as
`imports`. `CLUSTER_MODE` needs no import -- `ClusterModule` is `@Global`.

**`ThrottlerStorageRecord` is not exported from the package barrel.** Reaching
`@nestjs/throttler/dist/throttler-storage-record.interface` is the deep-path
shape that type-checks under `tsc` and then fails to resolve under `ts-jest`,
which is why `ScopedDbIsolation` is spelled out in `scoped-db.ts`. The return
type is therefore a local `ThrottleRecord` interface; TypeScript is structural,
so `implements ThrottlerStorage` still checks it against the library's own
signature and a field renamed upstream fails the build.

**The block semantics are the library's, deliberately.** A blocked key stops
accumulating hits until the block lapses, and a lapsed block resets the count
to one. Letting hits keep climbing would turn a fixed sentence into an
indefinite one for a client that keeps retrying -- a different control from the
one the `@Throttle` decorators describe. The integration spec asserts both.

**Three `CASE` expressions repeat one guard sequence** (blocked / block lapsed
/ window expired / otherwise) because a `SET` list cannot read the value it is
assigning, so "what are the hits now" has to be spelled once per column. The
statement is the mechanism, so it is one statement: a read then a write lets
two replicas each see "4 of 5" and both allow the fifth.

**The sweeper spares a blocked row.** Its predicate is
`window_expires_at < now() AND (blocked_until IS NULL OR blocked_until < now())`:
a key whose window has passed but whose block has not is still serving a
refusal, and deleting it would hand a blocked client a clean count. That is the
one way a garbage collector could weaken a limit, so the integration spec runs
the sweeper's exact predicate and asserts both directions.

**`verify-schema.sh` needs Docker, which this session did not have.** The same
two databases, the same double replay and the same normalized `pg_dump` diff
were run against a local PostgreSQL 16 instead, and the dump confirms
`CREATE UNLOGGED TABLE` on both sides. CI's `Schema vs Migrations Drift` job is
the real gate.

**For G1:** `PostgresThrottlerStorage.lastFailureLoggedAt` is a process-local
number, not a `Map` or `Set`, so the guard's regex will not see it. It is
allowlisted in spirit either way: it is a log throttle, so one line a minute
per replica is the intended behaviour.

### M1 -- MCP 2025-era sessions

- [x] Status: done (sticky-routing variant).

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

**Step 1, answered: no.** On `@modelcontextprotocol/server` and
`@modelcontextprotocol/node` **2.0.0**, the session id is not the only state and
cannot be put back anyway:

- `NodeStreamableHTTPServerTransport.sessionId` is a getter with no setter --
  assigning a persisted id throws `TypeError`.
- `_initialized` is private and set only by handling an `initialize` request;
  `validateSession` answers `400 Bad Request: Server not initialized` to a
  request carrying a known session id on a transport that has not seen one.
- Even with a seam to put the id back, the live state of an exchange is the open
  response stream on that pod's socket (`_streamMapping`), the
  `Protocol._responseHandlers` entry holding the promise a `confirmWrite`
  elicitation waits on, and the per-`McpServer` record in
  `mcp-elicitation-support.ts`. A session id addresses none of them, so
  `mcp_sessions` would make the id resolvable and the session no more servable.

Both SDK facts are pinned in `mcp-http.controller.spec.ts`, so an SDK upgrade
that adds a session-restore seam turns red and sends the next reader back to the
persisted variant.

**So step 3 shipped:** `mcp.stickySessions` (default `false`), rendering an
`nginx.ingress.kubernetes.io/affinity` Ingress of its own under
`ingress.enabled`, and an HTTPRoute rule with `sessionPersistence` under
`httpRoute.enabled`.

**Two things the step-3 sketch did not account for**, both now documented in
`helm/README.md` rather than papered over:

1. **The route has to reach the backend Service directly.** Every other path is
   served by the frontend, which proxies to `monize-backend-service` with a
   server-side `fetch` (`frontend/src/proxy.ts`), so an affinity annotation on
   the existing Ingress would pin the frontend pod while kube-proxy still spread
   that fetch across backend replicas. Hence a second Ingress / an extra
   HTTPRoute rule rather than an annotation on the existing one.
2. **Cookie affinity pins only clients that keep cookies**, and Gateway API
   `sessionPersistence` is an experimental-channel field. Where neither holds,
   the working configurations are one backend replica or a 2026-07-28 client.
   Without stickiness a misrouted session id is answered `404` and the client
   re-initializes, so reads recover -- but a confirmation in flight does not: its
   answer never reaches the replica that asked, the wait expires, and
   `clientAnsweredForItself` reads the timeout as `"unsupported"`, so the write
   proceeds under the client's own approval prompt.

**Scope additions** (per the "add the file and say why" rule): `helm/values.yaml`
and `helm/README.md`, because a Helm value that exists in no `values.yaml` cannot
be set and `scripts/check-docs-manifests.mjs` checks documented defaults against
it; `docs/backend/mcp.md`, because `AGENTS.md` requires the full entry beside the
one-line rule added to `backend/src/mcp/CLAUDE.md`.

**Deploy impact is `none`, not `neutral`:** no runtime code changed. The
controller keeps its four process-local maps and its `setInterval` sweep -- both
correct for state that cannot outlive its process -- and the chart's new value
defaults off, so a rendered chart is byte-identical until it is set. The
2026-07-28 leg is untouched.

**For D1:** the render test this task owes is the one named under Tests above --
`mcp.stickySessions.enabled=true` renders the `monize-mcp` Ingress (with
`ingress.enabled=true`) and the `sessionPersistence` rule (with
`httpRoute.enabled=true`), and neither appears at the default. `helm lint` and
`helm template` could not be run in the session that did M1 (the sandbox's egress
policy blocks `get.helm.sh`); the templates were rendered by substitution and
YAML-parsed, and CI's `helm-chart` job is the real gate.

**For G1:** `mcp-http.controller.ts` needs its four session maps on the
process-local-state allowlist, as sticky-routed state rather than a gap.

### S1 -- Boot refusals for per-pod storage in `multi`

- [x] Status: done.

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

**The backup refusal is unconditional in `multi`, not conditional on backups
being enabled.** The task's step 1 asked for "whatever cheap predicate says
backups are configured", and there is none: automatic backups are a row
(`auto_backup_settings.enabled`, per user), so any user can switch theirs on at
any time and no environment variable can say whether one has. A check that
tried to be conditional would be reading the wrong thing. The refusal therefore
holds until the S3 backup target ships (task S2), and the message says so.

**`auto-backup.service.ts` was not touched.** The task allowed exposing a
"backups enabled" predicate from it if none existed; since the honest answer is
that backups are always potentially enabled, exposing one would have meant
inventing a predicate to justify a conditional the check should not have.

**The assertions are assertions, and the code says so.** No process can see
from inside its own mount namespace whether the directory under its mount point
is the one another pod sees, so `*_SHARED_VOLUME=true` is the operator stating
it. The refusal exists so they state it knowingly rather than discover it from
a restore that cannot find its bytes. Only the exact string `true` counts:
`yes` and `1` are what an operator reaches for, and accepting them would pass
the check on a value nobody chose deliberately. There is a matrix row for that.

**The `database` attachment provider warns rather than refuses**, with the
sentence the design doc's open questions asked for: it is cluster-safe by
construction, and the note is about blobs on the primary being a scaling
concern of a different kind. That warning fires on the default, so every
`multi` row in the matrix that is about something else now carries it, and the
storage rows state their own inputs rather than inheriting them.

**`ATTACHMENT_LOCAL_DIR` joined `.env.example`.** It was referenced only in
prose there, and `scripts/check-env-docs.mjs` scans `process.env` reads: naming
the deprecated alias in a refusal made it a documented variable. It is
documented as deprecated, beside the current name.

**Scope additions:** `.env.example` (the task named it), and this task list.

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
integration spec against a MinIO service (add it to the
`backend-integration-tests` job if it is not there).

**Traps:** `docs/external-side-effects.md` EXT-001: durable state before the
external write, or reconstructibility; a backup object with no record is a
storage cost, a record with no object is the failure. Keep the order the
filesystem target has.

**Notes:**

### C1 -- Budget period rollover under a per-owner `claimOnce`

- [x] Status: done.

**Scope:** `backend/src/budgets/budget-period-cron.service.ts` and spec,
`backend/src/common/jobs/job-claim.service.ts` (a `BudgetPeriodRollover`
member on the `JobClaimType` const), `docs/cron-jobs.md`,
`backend/test/integration/budget-period-rollover.integration.spec.ts` (new),
`docs/concurrency-and-idempotency.md` (the register row, which the task's own
steps call for), `backend/src/budgets/budget-period.service.ts` (added to
scope: `NoOpenPeriodError` -- see the notes),
`backend/src/budgets/budget-period-lifecycle.spec.ts` and
`backend/src/budgets/rls-context-smoke.spec.ts` (they construct the cron
service, so the new constructor argument is provided there too).

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

**Notes:** the repair path exists --
`BudgetPeriodService.getOrCreateCurrentPeriod`, reached by opening the Budgets
screen, which inserts the month's period with
`ON CONFLICT (budget_id, period_start) DO NOTHING` -- so the permanent
`claimOnce` is the right primitive and `claimLease` was not needed.

The loop is now over owners rather than over budgets: `groupByOwner` collects
each owner's active budgets, one claim is taken for the owner, and the whole
group is skipped when it is lost. The per-budget body inside is unchanged.

The "no OPEN period" skip is carried by a **named error**, not by a message
match. `closePeriod` threw a bare `BadRequestException` whose message goes
through `tr`, so matching it in the cron would be matching on translated copy;
`NoOpenPeriodError` (still a `BadRequestException`, same status and same
message on the HTTP path) makes it a type test. That is why
`budget-period.service.ts` joined the scope. A first attempt discriminated by
re-reading the period's status instead -- it worked, but it cost a query per
error and its signature ("an OPEN period exists whose end is in the future")
was a heuristic rather than the fact.

`rolloverMonthKey` is UTC and exported, so two replicas in two zones derive one
key from one instant. `job_claims.claim_type` is a plain `VARCHAR(64)` with no
CHECK constraint, so the new member needed no migration.

The gap row in `docs/concurrency-and-idempotency.md` is retired and the job
moved into the resolved-claims paragraphs beside the demo reset.

### C2 -- Fetch crons behind a deployment-wide sync claim

- [x] Status: done.

**Scope:** one migration + `schema.sql` (`fetch_sync`),
`backend/src/common/jobs/fetch-sync.service.ts` (new) + spec,
`backend/src/common/jobs/entities/fetch-sync.entity.ts` (new, added to scope:
the integration harness builds its schema from entity metadata with
`synchronize: true`, so a table with no entity does not exist there),
`backend/src/common/jobs/job-claim.module.ts`,
`backend/src/currencies/exchange-rate.service.ts` and spec (`onModuleInit`
sweep and the 17:05 cron), `backend/src/securities/security-price.service.ts`
and spec (17:00 cron), `backend/src/securities/market-index.service.ts` and
spec (17:10 cron), `backend/src/common/db/rls-exempt-tables.ts`,
`docs/row-level-security-contract.md`, `docs/cron-jobs.md`,
`backend/test/integration/fetch-sync.integration.spec.ts` (new),
`backend/src/backup/export-table-queries.ts` (the new table's backup
classification, which the definition of done requires),
`backend/src/test-helpers/job-claim-testing.ts` (the `FetchSyncService`
double), and the four specs that construct one of the three services:
`currencies/rls-context-smoke.spec.ts`, `securities/rls-context-smoke.spec.ts`,
`currencies/exchange-rate.service.spec.ts`, and
`test/integration/manual-price-snapshot-recovery.integration.spec.ts`.

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

**Notes:** `FetchSyncService` seeds no context of its own, so
`WITH_CONTEXT_ALLOWLIST` was not touched -- all three callers already wrap in
`withSystemContext`, and the lease sits inside that wrap.

The service carries a fourth method the task did not name, `withLease(job,
leaseMs, fn)`, and the three crons call that rather than `claim`/`markSuccess`
by hand. The lease has to come back on **both** paths, and three call sites each
spelling out the same `try`/`catch` is the shape that ends up right in two of
the three places. `markFailure` records the reason and releases, then rethrows:
how a failed fetch is reported is each cron's own decision, and swallowing it
here would take that away from all three at once.

The market-index warm-up (`onApplicationBootstrap`) takes the lease too, not
just the cron -- a rollout is exactly where N identical bursts of 24 indexes are
least welcome. Its per-index `respectCooldown` is untouched: `market_index_sync`
answers how often ONE index is worth re-asking for, this answers which replica
asks at all.

Leases are 15/30/20 minutes for FX, prices and indexes -- longer than a run,
far shorter than the daily interval, so a killed holder never blocks the next
tick and the expiry alone hands the job back. Each service spec asserts that
bound rather than the literal, so tuning one does not silently drop it.

A `FetchSync` entity was needed. `backend/test/helpers/integration-setup.ts`
builds its schema from entity metadata (`synchronize: true`) while production
applies `schema.sql`, so without one the integration spec met a table that did
not exist.

### C3 -- Release-check cache to a one-row table

- [x] Status: done.

**Scope:** migration + `schema.sql` (`update_check_state`),
`backend/src/updates/updates.service.ts` and spec,
`backend/src/updates/entities/update-check-state.entity.ts` (new),
`docs/cron-jobs.md`, `backend/src/common/db/rls-exempt-tables.ts`,
`docs/row-level-security-contract.md` (the contract entry the exemption
requires), `backend/eslint.config.mjs` (`WITH_CONTEXT_ALLOWLIST`),
`backend/src/backup/export-table-queries.ts` (the new table's backup
classification), `backend/test/integration/update-check-state.integration.spec.ts`
(new).

**Pattern:** `push_instance_config` for a singleton row.

**Steps:** the 12-hour cron and the startup refresh first read the row; if
`checked_at` is within 12 hours, serve it and skip GitHub. The write is an
upsert. The in-memory `cache` field becomes a short read-through (or is
removed; the endpoint is not hot).

**Acceptance:** two replicas answer `/updates` identically; GitHub is called
once per 12 hours per deployment.

**Tests:** service spec with a clock; two instances, one fetch.

**Notes:** the in-memory `cache` field is gone rather than kept as a
read-through. Every read is the row, so the two replicas cannot disagree at all,
and the endpoint is not hot enough for the extra query to matter.

"Once per 12 hours per deployment" needed the freshness check and the claim to
be **one statement**, not a read then a fetch: two replicas ticking together
would both pass a read. `claimCheck` is a conditional upsert that moves
`checked_at` only when the stored one is older than the window, and only the
statement that moved it goes on to call GitHub.

It stamps on the **attempt**, not the outcome, which is the same thing the old
field did: a failed check still holds the window, because stamping only on
success would turn an unreachable GitHub into a request from every replica on
every tick -- exactly when a per-IP rate limit shared across one egress address
is least affordable. The last known version is kept through a failure, so the
banner says "could not check" rather than "nothing to install".

The table carries `release_name` and `published_at` as well as the four columns
this task named. `getStatus` returns both, so leaving them out would have made
them null on any replica that had not itself fetched -- the defect being fixed,
in two fields.

`readLatestRelease` is public and reads under the **caller's** identity;
`update_check_state` is RLS-exempt, so a request transaction sees it without a
bypass, and seeding one on a request path would widen the fence for nothing.
Only the refresh (a cron and a bootstrap hook, with no request behind either)
seeds `withSystemContext`, which is the one `WITH_CONTEXT_ALLOWLIST` entry this
task adds.

### C4 -- Demo seed under the lifecycle advisory lock

- [x] Status: done.

**Scope:** `backend/src/db-demo-check.ts` and its spec,
`backend/src/database/seed.ts`,
`backend/test/integration/demo-seed-lock.integration.spec.ts` (new).
`backend/docker-entrypoint.sh` is **unchanged** -- the step order did not need
to move -- and `PRE_BOOT_SCRIPTS` in `backend/src/startup-logging.spec.ts`
already lists both scripts, confirmed by running it.

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

**Notes:** both halves are needed and neither is sufficient. The probe takes the
lock before it reads, so two containers starting together do not both read "no
demo user" at once -- but a session lock dies with its connection and the shell
runs the seeder as a **separate process**, so the probe cannot hold it across
its own exit. `seed.ts` therefore re-asks the same question after acquiring the
lock itself, on the connection that holds it: the probe narrows the window, the
re-check closes it.

The re-check has to be on the locked connection, which is why
`demoUserExistsOn(client)` was split out of `demoUserExists()`. Asking on a
second connection would be answering about a moment the lock does not cover.

`seed.ts` opens its own direct `pg.Client` for the lock -- never the pooled
runtime connection, which the RLS design forbids from holding cross-transaction
session state, and which a transaction-mode pooler could put the lock and the
read on different server sessions of. It opens it *before* the Nest application
context, so a follower that finds the seed done exits without paying for one,
and holds it until the seed has finished so a waiter re-reads a completed seed
rather than a half-written one.

A follower that finds the demo user exits **0**, not 1: the data it would have
written is already there, and a non-zero exit would crash-loop a pod over work
that is done.

The non-demo `SeedService` path takes the lock too (it is a lifecycle
operation) but has no predicate to re-check; it is only ever run by hand.

The integration spec drives `acquireDbLifecycleLock` and `demoUserExistsOn` on
two real connections rather than invoking `seed.ts`, which calls `process.exit`
and builds a Nest context -- neither belongs in a Jest worker, and neither is
what this task changed.

### G1 -- Whole-tree process-local-state guard

- [x] Status: done.

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
channel and handler sets in `PgListener` (F2), the local fan-out map in
`PostgresEventBus` (R6), the T1 log throttle, and the four session maps in
`mcp-http.controller.ts` (M1 shipped the sticky-routing
variant; its Notes say why they stay), each with its reason as the map value. Leave the cron-scoped guard in place (it has a
narrower, stronger claim).

**Acceptance:** the guard is green on the tree after A4, X1 and R4; removing
any allowlist entry reports its file and line.

**Traps:** function-scoped `new Map(` inside a method is fine and must not
match (the regex anchors on `private`). Blank comments while preserving line
numbers so the report points at the right line.

**Notes:** 35 allowlist entries, each with its reason. Three things the plan
did not anticipate:

- The allowlist is keyed `path#field`, not by file. Keying by file would have
  exempted a sixth map in `provider-health.service.ts` on the strength of the
  five already there, and keying by `path:line` would churn on every edit above
  the declaration.
- A field whose declared type is `ReadonlySet`/`ReadonlyMap` is skipped rather
  than allowlisted: the type already forbids the mutation the guard is about,
  and three constant lookup tables (`yahoo-finance.service.ts`,
  `investment-transactions.service.ts` x2) would otherwise have been three
  exemptions saying "this is a constant". A `static` field with a mutable type
  IS scanned.
- The scan also matches the declaration-only shape (`private readonly x: Map<`,
  assigned in the constructor), which the plan's regex pair covers but the cron
  guard's does not use; `MovementModel` in `daily-movement.service.ts` is
  written that way.

A second `it` fails an allowlist entry whose field is gone, so the list shrinks
by being checked rather than by being remembered. Both directions were proved
by removing an entry and by renaming one. The forward references in
`memory-event-bus.ts` and `postgres-event-bus.ts` ("allowlisted when the
whole-tree guard lands") are now satisfied; their wording still reads correctly
and was left alone rather than widening this task's scope.

Out of scope, reported not fixed: `docs/system-invariants.md`'s "Candidates not
yet admitted" still lists "Bootstrap must be serialized across replicas ... no
advisory lock", which `backend/src/common/db/advisory-locks.ts` has closed.

### G2 -- Invariants in both contract docs

- [x] Status: done.

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

**Notes:** four `enforced`, one `partial`. INV-HA-001 is the `partial`, for two
named reasons rather than an unfinished mechanism: no E2E flips readiness on a
live replica yet (task D4), and `PostgresThrottlerStorage` fails **open** on a
structural failure, so a broken rate limiter deliberately does not refuse
readiness -- `/health` reports `rateLimiting: disabled` and every auth route
keeps INV-HA-002's logged counter beneath the throttler. Both are written into
the entry rather than left for a reader to notice.

INV-HA-003's statement covers the OIDC step-up `jti` as the design doc worded
it, but its enforcement names `oidc_step_up_claims` rather than
`single_use_tokens`: that path already had the same mechanism on its own table
and X1 did not move it.

INV-HA-002 carries a source scan as a second load-bearing kind in the matrix --
G1's guard. A budget kept in memory passes every behavioural test on one
replica, so the scan is the only kind that can fail it.

### D1 -- Helm

- [x] Status: done.

**Scope:** `helm/values.yaml`, `helm/templates/statefulset-backend.yaml` and
`helm/templates/statefulset-frontend.yaml` (renamed to `deployment-*.yaml`),
new `helm/templates/pdb-backend.yaml`, `helm/templates/pdb-frontend.yaml`,
`helm/templates/hpa-backend.yaml` (optional), `helm/templates/configmap-backend.yaml`,
`helm/templates/NOTES.txt`, `helm/README.md`, `.github/workflows/ci.yml` (the
`helm-chart` job renders a second values file), `helm/ci/multi-values.yaml`
(new).

**Steps:**

1. `Deployment` with `strategy: RollingUpdate`, `maxUnavailable: 0`,
   `maxSurge: 1`; keep `revisionHistoryLimit`, security context, probes,
   `readOnlyRootFilesystem` and the `/tmp` `emptyDir` as they are.
2. Values: `backend.replicas`, `backend.podDisruptionBudget.minAvailable`,
   `backend.topologySpreadConstraints`, `backend.autoscaling.{enabled,minReplicas,maxReplicas,targetCPU}`,
   `cluster.mode` (`single|multi`); the same replica/PDB/spread block for the
   frontend. No `redis.*` block and no new Secret: `multi` needs nothing the
   chart's database settings do not already carry.
3. `NOTES.txt`: when `cluster.mode=multi` and `attachments` or `backups`
   persistence is enabled, print the ReadWriteMany requirement and the
   `*_SHARED_VOLUME` assertion values; when `cluster.mode=multi`, print that
   the database host must be a session-capable endpoint (a transaction-mode
   pooler such as pgBouncer cannot carry the `LISTEN` each replica holds; a
   direct service such as CNPG's `-rw` is fine).
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

**The value is `cluster.mode`, not `backend.clusterMode`.** It sits beside the
two storage assertions it constrains (`cluster.attachmentSharedVolume`,
`cluster.backupSharedVolume`), because all three answer one question and an
operator who sets one needs to see the others. There is no `redis.*` block and
no `secret-redis.yaml`, which the task's scope still named from the earlier
draft.

**The Deployment omits `replicas` entirely when its HPA is on.** A Deployment
that keeps a replica count in its spec fights the autoscaler on every
`helm upgrade`, scaling back to the chart's number until the HPA scales out
again. This is the defect that makes people think their HPA is broken.

**`maxUnavailable: 0` with `maxSurge: 1`**, so a rollout is zero-downtime at
`replicas: 1` -- still the default -- because the new pod must pass readiness
before the old one goes. The reverse is the ordinary way a "rolling" update
drops every request for a few seconds.

**The PodDisruptionBudgets default to off.** At one replica a budget of
`minAvailable: 1` makes a node drain block indefinitely rather than interrupt
the service briefly, which is the worse surprise. They are turned on with the
replica count, and the README says so.

**`NOTES.txt` prints the mismatch, not just the requirement.** Asserting
`cluster.backupSharedVolume: true` while the claim is still `ReadWriteOnce` is
a deployment that boots and then loses backups, so the notes compare the two
and name whichever is wrong. It also states the `DATABASE_HOST` requirement,
which no template can check.

**`helm lint` and `helm template` could not be run here**: the sandbox's egress
policy blocks `get.helm.sh` (the same wall task M1 hit), and Helm publishes no
binary on GitHub releases. What was run instead is a check with real teeth
rather than a reading: every `.Values.<path>` in every template resolved
against `helm/values.yaml`, plus an if/with/range-versus-end balance per file.
The only unresolved paths are `.Values.nameOverride` and
`.Values.fullnameOverride` in the untouched `_helpers.tpl`, which are optional
by construction. `helm/ci/multi-values.yaml` was checked the same way and
parses as YAML, as does the workflow. CI's `Helm Chart Lint & Render` job is
the real gate, and it now renders the multi values file and asserts the
PodDisruptionBudget, the HPA, `CLUSTER_MODE` in the configmap, that a
Deployment is present and that no StatefulSet is.

**Scope additions:** `helm/templates/NOTES.txt` prose beyond the storage note,
`helm/values.yaml` comments that described the workload as a StatefulSet, and
`docs/future-plans/horizontal-scaling.md` (its "what remains" table named the
two template files this task renamed, so it pointed at paths that no longer
exist).

### D2 -- Compose HA example

- [x] Status: done.

**Scope:** `docker-compose.ha.yml` (new), `README.md` or `docs/` deployment
page that lists compose files, `.env.example` comments.

**Steps:** postgres, two `backend` replicas via `deploy.replicas: 2` (no
`container_name`), two `frontend` replicas, one reverse proxy (Caddy or nginx)
in front of the frontend; `CLUSTER_MODE: multi`; attachments on the
`database` provider; backups on a shared named volume with
`BACKUP_SHARED_VOLUME: "true"` (a single-host volume is shared by
definition). No other service: both backends point `DATABASE_HOST` at the one
`postgres` service directly, which is the session-capable endpoint `multi`
needs. Every documented command carries `-f docker-compose.ha.yml`
(`scripts/check-docs-manifests.mjs` rejects a bare `docker compose`).

**Acceptance:** `docker compose -f docker-compose.ha.yml up -d --wait` boots
both backends green; killing one backend leaves the app usable.

**Notes:**

**The acceptance could not be executed here**: this sandbox has the compose CLI
but no usable Docker daemon. What was run is
`docker compose -f docker-compose.ha.yml config`, which resolves and validates
the whole file, plus structural assertions on the parsed YAML: no
`container_name` on either replicated service, `deploy.replicas: 2` on both,
`CLUSTER_MODE=multi` and `BACKUP_SHARED_VOLUME=true` on the backend, and
exactly one service publishing a host port. Booting it and killing a replica is
still owed and belongs with D4, which is the shard that actually runs two
backends.

**Caddy, not nginx.** Its whole configuration is the one `caddy reverse-proxy`
command line, and it re-resolves the `frontend` service name per request, so a
replica that comes back after a restart is used without reloading the proxy --
which is exactly the behaviour the example is demonstrating. An nginx
`upstream` block caches the DNS answer at start, so a restarted replica stays
out until a reload, which would teach the reader the opposite lesson.

**The frontend publishes no port.** Two replicas cannot both bind one host
port, and that is the concrete reason this file needs a proxy at all rather
than a stylistic preference. `PROXY_PORT` defaults to the port
`docker-compose.prod.yml` publishes, so the URL a reader already has keeps
working.

**Backups are a named volume, not a bind.** On one host either is shared, but
the named volume states the sharing rather than relying on the reader noticing
that two services bind the same path -- and it is what
`BACKUP_SHARED_VOLUME=true` is asserting. Attachments sidestep the question
entirely: `ATTACHMENT_STORAGE_PROVIDER=database` is cluster-safe by
construction, which is the recommendation for this shape of deployment.

**The backend healthcheck is `/ready`, not `/live`.** `docker-compose.prod.yml`
uses liveness, which is right for one replica. Here the check decides whether a
replica is in `depends_on: service_healthy` and, more importantly, whether it
should be taking traffic at all: in `multi` a replica whose notification
connection is down is alive and cannot be woken, and only readiness reports
that.

**Scope additions:** `README.md` (its compose tree, which
`scripts/check-docs-manifests.mjs` checks against the files on disk), and this
task list. `.env.example` needed nothing: the file introduces one variable,
`PROXY_PORT`, and it is read by compose rather than by the application.

### D3 -- CI: retire the `redis` service

- [x] Status: done, in the follow-up to PR
  [#1407](https://github.com/kenlasko/monize/pull/1407), alongside F6. The task
  as first written ("add a `redis` service") shipped against the earlier draft;
  this is its reversal.

**Scope:** `.github/workflows/ci.yml` (`backend-integration-tests` job).
`.github/` is an ask-first change under `AGENTS.md`; this task is the
agreement.

**Steps:** remove the `redis:` service block (the digest-pinned
`redis:7-alpine`, its health command and port) and `REDIS_URL` from the job
env; keep the comment that `CLUSTER_MODE` is deliberately not set job-wide,
because that reasoning still holds for the two-instance specs R6 and T1 add.
Nothing else in the job changes: those specs need only the PostgreSQL service
already there.

**Acceptance:** the job runs unchanged; `zizmor --offline .github/workflows/ci.yml`
reports no findings; `grep -i redis .github/workflows/ci.yml` is empty.

**Notes (what shipped, so the reversal removed the right lines):**
`redis:7-alpine` was pinned to
`sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf`, a
multi-arch index, with `--health-cmd "redis-cli ping"`, port `6379:6379`, and
`REDIS_URL: redis://localhost:6379` in the job env. All four are gone.

The comment that `CLUSTER_MODE` is deliberately not set job-wide stayed, and
gained the reason the service is no longer needed: the event bus is
`LISTEN`/`NOTIFY` and the throttler's counters are a table, so R6's and T1's
specs are properties of the `postgres` service the job already runs. Without
that sentence the next reader finds a comment about specs that need a mode,
and no sign of what they connect to.

`zizmor --offline .github/workflows/ci.yml` reports no findings (v1.30.1, two
suppressed, the same two as before). As recorded when the service landed, the
`zizmor-scan` job runs with `|| true` and only uploads SARIF, so it could
neither go red on the pin nor go red on its removal; the scan was run by hand
for the same reason it was then.

### D4 -- E2E shard on `CLUSTER_MODE=multi`

- [x] Status: done.

**Scope:** `docker-compose.e2e.yml`, `.github/workflows/ci.yml` (`e2e-tests`
matrix), `e2e/tests/` (a relay round trip and a login-lockout spec that
alternate backends), `e2e/playwright.config.ts` if a project needs the mode.

**Steps:** add a second backend service to the compose file behind the
frontend's `INTERNAL_API_URL` (a tiny nginx `upstream` with two backends,
round-robin), both on the file's `postgres` service; one matrix entry sets
`CLUSTER_MODE: multi`; the other three stay `single`. The lockout spec fails login six times and asserts
the seventh is refused regardless of which backend served each attempt.

**Acceptance:** all four shards green; the `multi` shard's container logs
show both backends served requests.

**Traps:** `zz-danger-zone.spec.ts` deletes the shared account; keep
`workers: 1`. The Lighthouse job reuses the same compose file; keep its
default path on one backend so its budgets do not shift.

**Notes:** Scope gained `e2e/cluster/api-lb.conf` (the nginx config the compose
file mounts), `e2e/tests/cluster.spec.ts`, `e2e/helpers/api.ts` (one export),
`e2e/CLAUDE.md`, and the two contract docs, for the reasons below.

**The shape.** A compose **profile**, not a second compose file: with
`COMPOSE_PROFILES` unset the file renders exactly what it rendered before, which
is what keeps the Lighthouse job's budgets where they are. `backend` and
`backend-2` share one YAML anchor for their whole environment, so the two
replicas cannot drift into being two different applications. Both run
`db-init`/`db-migrate` on purpose: the lifecycle advisory lock is part of what
the shard proves.

**The specs do not alternate backends by hoping.** `api-lb.conf` labels every
answer with `X-E2E-Upstream`, so each test asserts on the set of replicas that
served it rather than on a log grep after the fact; a test whose requests all
landed on one replica fails as inconclusive rather than passing for the wrong
reason. The load balancer is also published on 3002 so a failure says whether
the fixture or the frontend proxy's header forwarding is at fault.

**The relay round trip is in, and needed no new dependency.** The 2026-07-28 MCP
revision is a plain JSON-RPC POST, so the agent half is `request.post` with two
`_meta` envelope keys and the `Mcp-Method`/`Mcp-Name` headers. It has to be that
leg: a 2025-era session is pinned to its replica, so a round-robin LB would
answer its second request `404`. The wire was verified against the real SDK
handler before the spec was written rather than guessed.

**The shard also covers what the plan did not ask for**: `/oauth/jwks` agreeing
across replicas (INV-HA-004 -- the one defect here that was user-visible before
K1), and `/health` reporting the wake-up channel on each replica.

**What is NOT covered, and the invariant says so.** INV-HA-001's readiness
*flip* has no E2E: nothing in this stack can sever one replica's `LISTEN`
without taking the database from both, so its matrix cell stays
`required (not yet met)` and its entry stays `partial`. The paragraph in
`docs/verification-contract.md` that said D4 would close it was corrected in the
same commit rather than left to read as satisfied.

**Not verified here.** This session had no Docker daemon, so the compose file
was validated with `docker compose config` in both shapes and the specs with
`playwright test --list`, but the shard has never been run. CI is the first
execution.
