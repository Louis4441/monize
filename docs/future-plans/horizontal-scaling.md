# Plan: Horizontal scaling and high availability

> **Status: proposed. Nothing in this document has shipped.** It records what
> stands between the current single-replica deployment and one where several
> backend and frontend replicas serve one database behind an ordinary load
> balancer, and the order in which to close that gap. Redis (or a compatible
> server) becomes a requirement only for an operator who opts into
> multi-replica mode; a single-replica deployment keeps running exactly as it
> does today, with no new dependency. Companion task list:
> [`horizontal-scaling-tasks.md`](./horizontal-scaling-tasks.md).

## Goal

- Any number of backend replicas and any number of frontend replicas, behind a
  load balancer with **no session affinity**, over one PostgreSQL.
- A new `CLUSTER_MODE` setting: `single` (the default, today's behaviour,
  byte-for-byte) or `multi`. In `multi` the process refuses to boot unless the
  things a second replica needs are present: a Redis URL, and cluster-safe
  storage for attachments and backups.
- Everything that must be *correct* across replicas (rate-limit budgets, replay
  protection, signing keys, cron claims) lives in PostgreSQL and therefore
  behaves identically in both modes. Redis carries only what is ephemeral and
  latency-bound: the HTTP throttler's counters and a publish/subscribe channel
  that wakes the replica holding a live connection.
- Rolling upgrades with zero downtime, and one replica failing without a user
  noticing more than a retried request.

Out of scope: a PostgreSQL high-availability topology (that is the operator's
database, not this application), read replicas, and sharding the database.

## Why this is non-trivial here (current state)

Much of the work is already done. The claims below are what a reviewer should
*not* re-propose.

| Already solved | Source | Mechanism |
|---|---|---|
| Every replica runs every cron, and most crons are safe | `docs/cron-jobs.md`, `backend/src/common/jobs/job-claim.service.ts` | `claimOnce` / `claimLease` + lease token, `markDelivered`; occurrence claim on auto-posting (`scheduled_transaction_postings` unique key); `FOR UPDATE SKIP LOCKED` in `backend/src/notifications/notification-reminder-cron.service.ts`; insert-winner dedupe indexes for alerts |
| Two containers starting together against one database | `backend/src/common/db/advisory-locks.ts` | `db-init` and `db-migrate` take `pg_advisory_lock(DB_LIFECYCLE_LOCK_KEY)` and re-read state after acquiring |
| First-user-becomes-admin race | `backend/src/auth/auth.service.ts` | `withScopedDb(..., "SERIALIZABLE")` |
| Refresh-token rotation, PATs, OAuth artifacts, TOTP secrets | `backend/src/auth/token.service.ts`, `backend/src/oauth/postgres.adapter.ts` | rows, not memory; rotation under a row lock |
| OIDC step-up single-use artifacts | `backend/src/auth/oidc/oidc-reauth.service.ts` | `INSERT ... ON CONFLICT (jti) DO NOTHING` -- the comment there already names the multi-replica reason |
| Web Push VAPID key pair | `backend/src/push/push-config.service.ts` | one row, `INSERT ... ON CONFLICT (id) DO NOTHING` as the arbiter, re-read in the same transaction |
| Restore upload ticket | `backend/src/backup/restore-upload-ticket.ts` | HMAC over `{userId, expiry}` keyed from `JWT_SECRET`, chosen so the upload can land on a different pod from the JSON request |
| CSRF and OAuth cookie keys | `backend/src/auth/auth.service.ts`, `backend/src/oauth/oauth-provider.service.ts` | derived from `JWT_SECRET` via `derivePurposeKey`, identical on every replica |
| `.mny` import workers | `backend/src/import/mny/mny-import-job.service.ts` | partial unique index, atomic claim, heartbeat + reaper, `attempt_token` fencing; progress is a row the wizard polls |
| Backup temp files on a shared volume | `backend/src/backup/atomic-file.ts` | `randomUUID` in the intermediate name (FV-004) |
| The frontend | `frontend/src/proxy.ts` | stateless: no route-handler caches, no ISR, no `unstable_cache`; the only module-scope mutable is a one-shot log flag |

What remains, in severity order:

| Severity | Where | Consequence at N replicas |
|---|---|---|
| Security | `backend/src/auth/two-factor.service.ts` -- `twoFactorAttempts`, `user2FAAttempts`, `usedTotpCodes` are `Map`s | 2FA attempt budgets become 3N and 10N. The TOTP replay window is per process, so a captured code can be spent once on each replica |
| Security | `backend/src/auth/step-up/step-up.service.ts` `attempts`; `backend/src/auth/auth-email.service.ts` `forgotPasswordAttempts`, `verificationEmailAttempts` | step-up lockout and the 3-per-hour email throttles multiply by N |
| Security | `ThrottlerModule.forRoot` in `backend/src/app.module.ts` passes no `storage`, so `@nestjs/throttler` keeps counters in process | every `@Throttle` override (login 5 per 15 minutes, password reset 3 per 15 minutes, and the rest) becomes limit x N |
| Security | `users.failed_login_attempts` is a JavaScript read-modify-write | already on the gap register in `docs/concurrency-and-idempotency.md` (CONC-001, CONC-007); replicas make the lost increment routine |
| Correctness | `backend/src/ai/actions/ai-actions.service.ts` `consumed` | "a confirmed action descriptor cannot be submitted twice" is enforced per process; the same descriptor confirms once per replica |
| Correctness | `backend/src/oauth/oauth-provider.service.ts` constructs `oidc-provider` with **no `jwks`** | the library generates a development signing key per process. `/oauth/jwks` differs per replica and per restart; an ID token signed by one replica does not verify against the JWKS document served by another. Today this is masked because access tokens are opaque and `userinfo` is disabled, so only the ID token is affected -- and it already breaks across a restart |
| Blocker | `backend/src/ai/relay/ai-relay.service.ts` (`pending`, `inFlight`, `waiters`, `buffered`, `awaitingLate`, `bufferedActions`) and `backend/src/ai/relay/relay-attachment.store.ts` | the browser SSE stream, the agent's long-poll and the agent's answer POST each hold a live promise in a `Map`; the three requests must reach the same process. Both files say so in their header comments |
| Blocker (2025-era MCP only) | `backend/src/mcp/mcp-http.controller.ts` -- `transports`, `servers`, `sessionUsers`, `sessionCreatedAt` | a 2025-era session id resolves only on the replica that created it. The 2026-07-28 leg is stateless per request (`docs/adr/0004-mcp-two-eras-request-identity-and-mrtr-confirmation.md`) |
| Storage | `backend/src/attachments/storage/local-storage.provider.ts`, `backend/src/backup/auto-backup.service.ts`, `backend/src/backup/backup-paths.ts` | per-pod disk. `helm/values.yaml` mounts one `ReadWriteOnce` claim, which a second pod on another node cannot attach |
| Startup | `backend/docker-entrypoint.sh` runs the demo seed **after** `db-migrate` releases the lifecycle lock | two demo pods can both fail `db-demo-check` and both seed |
| Duplication (cost, not data) | `backend/src/currencies/exchange-rate.service.ts` (`onModuleInit` sweep and the 17:05 cron), `backend/src/securities/security-price.service.ts`, `backend/src/securities/market-index.service.ts`, `backend/src/updates/updates.service.ts` | N provider fetches per tick and per rollout; the writes are natural-key upserts, so data stays right |
| Duplication (a counted error) | `backend/src/budgets/budget-period-cron.service.ts` | no claim; the loser's 23505 on `UNIQUE(budget_id, period_start)` is caught and counted as a failure |
| Deployment | `helm/templates/statefulset-backend.yaml`, `helm/templates/statefulset-frontend.yaml`, `helm/templates/service-backend.yaml`, `docker-compose.prod.yml` | `replicas: 1`, no PodDisruptionBudget, no spread constraints, no HPA, no `sessionAffinity`; compose pins `container_name`, so it cannot replicate at all |

One latent trap to close on the way: `backend/src/common/csrf.util.ts` keeps a
per-process random `FALLBACK_KEY` that is reached only when `JWT_SECRET` is
absent, while `backend/src/common/guards/csrf.guard.ts` skips verification in
that state. A deployment without `JWT_SECRET` works on one replica and fails
open on two. `JWT_SECRET` should be fatal at boot in every mode.

Doc drift to correct in the same body of work, so this plan does not inherit
it: section 8 of `docs/concurrency-and-idempotency.md` still lists scheduled
auto-posting and the demo reset as unclaimed, and `docs/external-side-effects.md`
still says bill and mortgage reminders have no dedupe state and that the
automatic backup writes with a bare `fs.writeFile`. All four are fixed in code.

## Principles

1. **PostgreSQL is the store for anything that must be correct.** Counters,
   replay sets, signing keys and claims are rows, arbitrated by the mechanisms
   in `docs/concurrency-and-idempotency.md` section 2 (atomic arithmetic, unique
   index, conditional `UPDATE ... RETURNING`, `ON CONFLICT DO NOTHING`). They
   then work the same in `single` and `multi`, and losing Redis never widens a
   brute-force budget or replays a confirmation.
2. **Redis carries only what is ephemeral and latency-bound.** Two things:
   the HTTP throttler's sliding counters (a hot path, and losing them costs at
   most one window of leniency on non-auth routes, because auth routes keep a
   PostgreSQL counter beneath the throttler) and a publish/subscribe channel
   whose only message is "re-read this row".
3. **One door per concern, behind a DI token, selected by config, memory by
   default.** Copy `ATTACHMENT_STORAGE_PROVIDER` in
   `backend/src/attachments/attachments.module.ts`: register every
   implementation as a provider, then one `useFactory` picks by mode. The token
   name is the env var name.
4. **An unsafe mode refuses to boot; a sub-optimal one warns.** Refusal copies
   `assertRequiredDbFunctionsOrExit` in `backend/src/main.ts` (log the reason,
   `process.exit(1)`, before `app.listen`). Warning copies
   `reportEncryptionKeyStatus` in the same file. The parse-and-throw shape for
   the setting itself is `parseRlsMode` in `backend/src/common/db/rls-config.ts`.
5. **Every process-local `Map` or `Set` that survives is allowlisted with a
   reason.** `backend/src/common/db/derived-state-writers.guard.spec.ts` does
   this for files containing `@Cron(`; the scan widens to the whole tree and
   the allowlist may only shrink.
6. **A two-replica claim is tested with two real connections.**
   `docs/verification-contract.md` section 1 names the kinds ("two
   connections", "two instances"); `backend/test/integration/mny-import-job.integration.spec.ts`
   is the pattern. A concurrency mechanism with only unit tests has not been
   tested.

## Configuration

| Variable | Values | Meaning |
|---|---|---|
| `CLUSTER_MODE` | `single` (default), `multi` | `multi` enables the Redis-backed throttler storage and event bus, adds the Redis probe to readiness, and turns on the boot refusals below. Parsed like `RLS_MODE`: an unknown value throws and refuses the boot |
| `REDIS_URL` | `redis://` or `rediss://` URL | required in `multi`; ignored in `single` (a warning notes it is set but unused) |
| `REDIS_KEY_PREFIX` | string, default `monize:` | lets one Redis serve several Monize deployments |
| `ATTACHMENT_SHARED_VOLUME` | `true` | operator assertion that `ATTACHMENT_CONTAINER_DIR` is a volume every replica mounts (ReadWriteMany or equivalent). Read only in `multi`, only when `ATTACHMENT_STORAGE_PROVIDER=local` |
| `BACKUP_SHARED_VOLUME` | `true` | the same assertion for `BACKUP_CONTAINER_DIR` |

Boot matrix in `multi`:

| Condition | Outcome |
|---|---|
| `REDIS_URL` absent, or `PING` fails at boot | refuse |
| `ATTACHMENT_STORAGE_PROVIDER=local` without `ATTACHMENT_SHARED_VOLUME=true` | refuse, naming the `database` and `s3` providers as the alternatives |
| automatic backups enabled and `BACKUP_SHARED_VOLUME` not `true` | refuse (until the S3 backup target ships, see WP7) |
| `JWT_SECRET` absent | refuse (in every mode -- this is the CSRF trap above) |
| `ENCRYPTION_KEY` absent | warn, as today; Web Push and the persisted OIDC keys stay unavailable |

Readiness (`backend/src/health/health.controller.ts`) gains a Redis `PING` in
`multi` only, so a replica that lost Redis leaves the load balancer instead of
serving a throttler that counts nothing. Liveness stays dependency-free.

Every new variable lands in `.env.example` in the same PR;
`scripts/check-env-docs.mjs` fails the `Documentation vs Manifests` job
otherwise. Numeric knobs go through `resolvePositiveInt` in
`backend/src/common/env-number.util.ts`.

## Work packages

Each package names its mechanism, the invariant it serves, the test kind it
owes, and its deploy impact for a deployment that stays on `single`.

### WP0 -- Foundations

New `backend/src/common/cluster/cluster-mode.ts` (`parseClusterMode`, the
boot-matrix check as a pure function returning refusals and warnings) and a
global `ClusterModule` (`backend/src/common/cluster/cluster.module.ts`, the
two-provider shape of `backend/src/common/demo-mode.module.ts`) exposing the
mode and, in `multi`, one shared `ioredis` client plus one dedicated subscriber
connection. `main.ts` calls the check before `app.listen`. Readiness probe
extension. `docs/cron-jobs.md` and the two stale doc sections corrected. ADR
`0005` written when this lands (next free number in `docs/adr/README.md`).

Deploy impact: `none` for `single`.

### WP1 -- Auth counters and single-use codes to PostgreSQL

Ships first because it fixes single-replica behaviour too (a restart today
resets every lockout).

- New table `auth_attempt_counters (scope TEXT, key TEXT, count INT, window_expires_at TIMESTAMPTZ, PRIMARY KEY (scope, key))`
  with one service, `backend/src/auth/auth-attempt-counter.service.ts`, whose
  only write is `INSERT ... ON CONFLICT (scope, key) DO UPDATE SET count = CASE WHEN window_expires_at < now() THEN 1 ELSE count + 1 END, window_expires_at = ... RETURNING count`.
  Scopes: 2FA per temp token, 2FA per user, step-up per `userId:purpose`,
  forgot-password per email, verification email per email.
- `users.failed_login_attempts` moves to `UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = $1 RETURNING failed_login_attempts`
  (closes the CONC-001 register entry).
- New table `single_use_tokens (purpose TEXT, token_hash TEXT, expires_at TIMESTAMPTZ, PRIMARY KEY (purpose, token_hash))`
  with `claim(purpose, token)` doing `INSERT ... ON CONFLICT DO NOTHING RETURNING` --
  the `claimJti` shape from `backend/src/auth/oidc/oidc-reauth.service.ts`,
  generalised. `usedTotpCodes` becomes purpose `totp` keyed on
  `hash(userId:code)`; WP3 reuses it.
- A daily sweep of expired rows on both tables (a `@Cron` with a row in
  `docs/cron-jobs.md`, idempotent by predicate).
- **Transaction boundary.** A failed login must still persist its counter, so
  the increment runs in its own short `withScopedDb` after the login
  transaction has decided, never inside it -- otherwise the rejection rolls
  back the evidence. The doc comment on the service says which.
- RLS: both tables are keyed by opaque scope and hash, not by `user_id`. They
  join the exempt list in `docs/row-level-security-contract.md` with the
  reason, and `RLS_EXEMPT_TABLES` in the same PR.

Invariant: INV-HA-002, INV-HA-003. Tests: two-connection integration spec
where two concurrent increments both see the threshold, and where two
concurrent claims of one TOTP code yield exactly one winner. Deploy impact:
`neutral` (same limits, durable across restarts).

### WP2 -- HTTP throttler storage

`backend/src/common/throttler/redis-throttler-storage.ts` implementing
`@nestjs/throttler`'s `ThrottlerStorage` (`increment(key, ttl, limit, blockDuration, name)`)
with a Lua script or `MULTI`/`INCR`/`PEXPIRE`, prefixed by `REDIS_KEY_PREFIX`.
`ThrottlerModule.forRootAsync` selects it in `multi`; `single` keeps the
library default. Auth routes are protected twice on purpose: the throttler is
the cheap first gate, WP1's counters are the correctness gate. If Redis is
unreachable at request time the storage fails **open** and logs once per
minute (a closed throttler would take the whole API down with Redis, and the
readiness probe already removes the replica).

Invariant: INV-HA-001 (readiness). Tests: unit spec with an in-memory Redis
double, plus one integration spec against the CI Redis service asserting the
limit holds across two `ThrottlerStorage` instances sharing one server. Deploy
impact: `multi-only`.

### WP3 -- AI action anti-replay

`consumed` in `backend/src/ai/actions/ai-actions.service.ts` becomes a
`single_use_tokens` claim with purpose `ai-action`, taken **inside** the
transaction that applies the action, so a rejected claim and an applied write
cannot both happen. Grep the MCP confirmation path for the same descriptor and
route it through the same claim.

Invariant: INV-HA-003. Tests: two-connection spec, one winner. Deploy impact:
`neutral`.

### WP4 -- OIDC provider signing keys

New table `oauth_instance_config (id BOOLEAN PRIMARY KEY DEFAULT TRUE, jwks_enc TEXT, generated_at TIMESTAMPTZ)`
and `backend/src/oauth/oauth-signing-keys.service.ts`: generate an RSA and an
EC key with `jose`, encrypt the JWKS with `ENCRYPTION_KEY`, `INSERT ... ON CONFLICT (id) DO NOTHING`,
re-read in the same transaction (the `push-config.service.ts` pattern,
verbatim). `oauth-provider.service.ts` passes the result as `jwks`. Without
`ENCRYPTION_KEY` the provider keeps today's per-process key and the existing
warning gains a sentence. Rotation is a later concern: a second row with a
`retired_at` and both keys published.

Invariant: INV-HA-004. Tests: unit spec that two service instances over one
database end up with the same key id; the OAuth E2E spec verifies an ID token
against `/oauth/jwks` after a backend restart. Deploy impact: `neutral`, and a
visible improvement for `single` (ID tokens survive restarts).

### WP5 -- Event bus and the AI relay

`backend/src/common/events/event-bus.interface.ts` (`publish(channel, payload)`,
`subscribe(channel, handler)`, `EVENT_BUS` token), with
`backend/src/common/events/memory-event-bus.ts` (default) and
`backend/src/common/events/redis-event-bus.ts` (one subscriber connection per
process from `ClusterModule`, `psubscribe` on the prefix). Messages are wake-ups
only -- `{ userId, promptId }` -- never the payload.

The relay itself moves its queue to rows:

- `ai_relay_prompts (id, user_id, status pending|claimed|answered|expired, prompt, claimed_at, answered_at, answer, created_at)`.
  The browser inserts `pending` and subscribes to `relay:<userId>`. The agent's
  long-poll claims with `UPDATE ... SET status='claimed', claimed_at=now() WHERE id = (SELECT id ... WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`
  (the `notification-reminder-cron.service.ts` shape). `post_response` is a
  conditional `UPDATE ... WHERE status='claimed'`; the loser of a double post is
  refused. Both transitions publish a wake-up; the replica holding the SSE
  stream re-reads the row and streams.
- Late answers and buffered action cards are the same rows with a TTL sweep;
  `buffered`, `awaitingLate` and `bufferedActions` disappear.
- `lastPollAt`, `idleSince`, `idleDisconnectedAt` become columns on a small
  `ai_relay_agents (user_id PRIMARY KEY, last_poll_at, idle_since, idle_disconnected_at)`
  row written through `runOutsideActiveScopedManager` (they are progress, not
  business data).
- Relay attachments (`relay-attachment.store.ts`) go through the existing
  `ATTACHMENT_STORAGE_PROVIDER` under a `relay/` key prefix with a TTL row, so
  bytes uploaded on one replica are readable on another.
- Per-connection heartbeat timers in `backend/src/ai/relay/ai-relay.controller.ts`
  stay where they are; they describe one socket.

In `single`, the memory bus delivers the wake-up in-process and behaviour is
today's, minus the restart-loses-queue defect.

Invariant: INV-HA-005. Tests: two-connection spec (two agents claim one
prompt, one wins); two-instance spec (browser subscribes on instance A, agent
answers on instance B, A streams). Deploy impact: `neutral` (relay persists
across restarts).

### WP6 -- MCP 2025-era sessions

Keep the 2026-07-28 leg as is. For the sessionful leg, persist
`session_id -> user_id, created_at` in a `mcp_sessions` table and re-create the
transport per request from that row, so any replica can serve any session; the
5-minute sweep becomes a `DELETE ... WHERE created_at < now() - interval '1 hour'`.
If the SDK's transport cannot be re-created statelessly for that revision, the
fallback is documented sticky routing on `/mcp` only (a Helm ingress
annotation), with `legacy: "reject"` already limiting the exposure. Decide by
reading the SDK, not by assuming.

Tests: two-instance spec for the persisted variant. Deploy impact: `neutral`.

### WP7 -- Storage under `multi`

The boot matrix refusals for `local` attachments and the backup directory
(WP0). Follow-on task: an S3 backup target for automatic backups, reusing the
client and the deadline rule of `backend/src/attachments/storage/s3-storage.provider.ts`,
so `multi` needs no shared filesystem at all. Retention and promotion move to
object listing; the per-user prefix keeps the `shardedSegments(userId)` layout
from `backend/src/common/shard-path.util.ts` so `docs/adr/0003-filesystem-objects-use-id-sharding.md`
still describes it.

Deploy impact: `multi-only` for the refusals; `none` until the S3 target is
selected.

### WP8 -- Cron duplication and bootstrap fan-out

- `claimLease` (new `JobClaimType` members) around: the budget period
  rollover; the exchange-rate startup sweep and 17:05 fetch; the security
  price and market index fetches. Data is already idempotent; the claim
  removes N provider calls and the counted 23505 errors. Each cron's row in
  `docs/cron-jobs.md` gains the mechanism, and
  `backend/src/common/cron-doc.spec.ts` checks the expression verbatim.
- `updates.service.ts` keeps its release check in a one-row table so every
  replica answers the same and GitHub is asked once per 12 hours per
  deployment.
- The demo seed step in `backend/docker-entrypoint.sh` moves inside the
  lifecycle advisory lock: `db-demo-check` and `seed` take
  `DB_LIFECYCLE_LOCK_KEY` like `db-init`, and are added to `PRE_BOOT_SCRIPTS`
  in `backend/src/startup-logging.spec.ts` if they are not already there.

Deploy impact: `neutral`.

### WP9 -- Deployment and CI

- **Helm.** Backend and frontend become `Deployment`s (nothing about them is
  ordinal; a StatefulSet only slows rollouts). Values: `replicas`,
  `podDisruptionBudget.minAvailable`, `topologySpreadConstraints`, an optional
  `autoscaling` block, `clusterMode`, `redis.url` (external) or a `redis`
  subchart toggle, `persistence.*.accessMode: ReadWriteMany` guidance in
  `helm/templates/NOTES.txt` when `clusterMode=multi` and the `local` provider
  is chosen. `CLUSTER_MODE` and `REDIS_URL` in `helm/templates/configmap-backend.yaml`
  (the URL through a Secret when it carries a password). The chart lint job
  renders both modes.
- **Compose.** A new `docker-compose.ha.yml` example with `deploy.replicas`,
  no `container_name`, a `redis` service and a reverse proxy in front; the
  production file is left as the single-replica reference.
- **CI.** A digest-pinned `redis` service beside PostgreSQL in the
  `backend-integration-tests` job of `.github/workflows/ci.yml` (the
  `zizmor-scan` job requires the pin), `REDIS_URL` in that job's env; a `redis`
  service in `docker-compose.e2e.yml` so one E2E shard runs with
  `CLUSTER_MODE=multi` and two backend replicas behind the frontend proxy.

Deploy impact: `none` for existing deployments (defaults unchanged).

## Per-replica state that stays

Each of these is listed in the widened guard's allowlist with the reason here.

| State | Source | Why it may stay per replica |
|---|---|---|
| Provider circuit breaker | `backend/src/provider-health/provider-health.service.ts` | describes this replica's own sockets; episode start and notification markers are already shared rows (`backend/CLAUDE.md`) |
| Yahoo request semaphore and crumb | `backend/src/securities/yahoo-finance.service.ts` | a per-process handshake; N replicas mean N crumbs, which the provider tolerates. WP8's fetch claim removes the cron-driven multiplication |
| `DailyWriteLimiter` | `backend/src/common/daily-write-limiter.ts` | documented as a soft guardrail, not a security boundary. Revisit if MCP write abuse is ever observed |
| `EmptyWindowMemory` and the empty-window caches | `backend/src/common/time-series/history-fill.ts` | "a cache, not a guard"; a cold replica costs one extra fetch behind an idempotent upsert |
| Intraday, news and instrument-id caches | `backend/src/securities/portfolio.service.ts`, `backend/src/securities/security-news.service.ts` | short TTL, miss costs one provider call |
| Activity-write throttle | `backend/src/common/interceptors/request-context.interceptor.ts` | up to N writes per five minutes instead of one; harmless |
| Support-backup raw export cache | `backend/src/backup/support-backup/support-backup.service.ts` | preview and generate landing on different replicas degrade to two exports. Acceptable; documented on the endpoint |
| Budget actuals promise cache | `backend/src/budgets/budgets.service.ts` | already stale within one replica for its TTL; multi-replica does not change the contract |
| Restore admission gate | `backend/src/backup/restore-processing-gate.ts` | memory is per pod, so the gate is correctly per pod. Cluster-wide restore admission is an open question |
| Email failure snapshot | `backend/src/notifications/email.service.ts` | the alert that reads it dedupes at the database; the threshold becomes per replica, which the class comment already anticipates |

## Invariants to add

Five entries in `docs/system-invariants.md`, in its field template, and the
matching rows in `docs/verification-contract.md` section 3 (the parity guard
`backend/src/common/invariant-catalog-parity.spec.ts` fails when either file
lacks an ID). Proposed wording:

| ID | Statement | Mechanism | Test kind |
|---|---|---|---|
| INV-HA-001 | A process in `CLUSTER_MODE=multi` serves traffic only while every replica-shared dependency it needs is reachable | boot refusal in `main.ts`; Redis `PING` in readiness | unit (boot matrix), E2E (readiness flips) |
| INV-HA-002 | An authentication attempt budget is one number per deployment, not per process | `auth_attempt_counters` atomic upsert; `users.failed_login_attempts` atomic increment | two connections |
| INV-HA-003 | A single-use artifact (TOTP code, AI action descriptor, re-auth jti) is consumed at most once across all replicas | `single_use_tokens` primary key, `ON CONFLICT DO NOTHING RETURNING` | two connections |
| INV-HA-004 | One deployment publishes one OIDC signing key set, stable across restarts | `oauth_instance_config` insert-as-arbiter | two instances |
| INV-HA-005 | A relay prompt is claimed by exactly one agent poll and answered at most once | `ai_relay_prompts` conditional `UPDATE ... RETURNING` under `FOR UPDATE SKIP LOCKED` | two connections, two instances |

## Guards to add

- `backend/src/common/process-local-state.guard.spec.ts`: the
  `derived-state-writers` scan widened from cron files to every file under
  `backend/src`, matching `private readonly <name> = new Map|Set(` and
  `private <name>: Map|Set`, with the allowlist from the table above. The
  allowlist may shrink and never grow without a written reason.
- `backend/src/common/cluster/cluster-mode.spec.ts`: the boot matrix as a
  table-driven test, one row per line of the matrix above.
- `startup-logging.spec.ts` gains any new pre-boot script.
- `check-env-docs.mjs` already covers the new variables; `.env.example` is
  the deliverable.
- The `Helm Chart Lint & Render` job renders `clusterMode=multi` as well as
  the default.

## Rollout order and deployment safety

| Order | Packages | Class for a `single` deployment |
|---|---|---|
| 1 | WP0 (mode parsing and checks only), WP1, WP3, WP4, WP8 | `neutral`: same behaviour, durable across restarts; auth lockouts stop resetting on restart, ID tokens stop breaking on restart |
| 2 | WP5 (relay rows + memory bus), WP6 | `neutral` |
| 3 | WP2, WP5 (Redis bus), WP7 refusals, WP9 | `multi-only`: no effect unless `CLUSTER_MODE=multi` |
| 4 | WP7 S3 backup target | `none` until selected |

Every task lands behind `CLUSTER_MODE=single` unchanged; the task list's
definition of done requires proving that.

## Open questions

- **Redis topology.** `ioredis` handles Sentinel and Cluster URLs, but the
  throttler's Lua script and the subscriber connection need testing against
  each. First release: a single Redis or a Sentinel pair; Cluster later.
- **Cluster-wide restore admission.** The per-pod gate protects a pod's memory;
  N pods can each admit a restore. A `claimLease` per user around restore would
  add a cluster ceiling. Not needed for correctness.
- **Frontend body buffer.** `frontend/src/proxy.ts` buffers the whole request
  body, so each frontend replica's memory request must still cover
  `MNY_IMPORT_LIMIT_MB + 8`. Document in the Helm values, no code.
- **pgBouncer.** Nothing in this plan uses `LISTEN`/`NOTIFY` or session-level
  locks on the runtime pool, so transaction-mode pooling stays possible for the
  API; the startup scripts still need a direct connection for the lifecycle
  lock, as `advisory-locks.ts` already states.
- **Should `multi` warn about the `database` attachment provider?** It is
  cluster-safe by construction, but large blobs on the primary are a scaling
  concern of a different kind. Warn, do not refuse.
