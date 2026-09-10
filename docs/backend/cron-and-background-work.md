# Backend: cron jobs and background work

How a cron seeds its identity, where a cleanup somebody is blocked on belongs, and how a worker attempt is fenced so a reaper cannot double a side effect. `docs/cron-jobs.md` holds the schedule; read this before adding a `@Cron`, a reaper or a long-running job.

Paths are relative to `backend/src/` unless rooted. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## Cron Jobs

Cron jobs use `@Cron()` from `@nestjs/schedule` and run **in the API process** (`ScheduleModule.forRoot()` in `app.module.ts`; on k8s with multiple replicas, every replica fires every cron). Full schedule: `docs/cron-jobs.md`, or grep `@Cron(`.

Every `@Cron` handler is an out-of-request entry point, so its body must seed its own RLS context (tasks C2-C4): the cross-user fan-out under `withSystemContext`, each per-user body under `withUserContext(userId)`. A handler that reaches the DB with no ambient context throws in every `RLS_MODE`, including `off` -- the per-module `rls-context-smoke.spec.ts` specs are the pattern for proving a cron runs clean.

## Cleanup somebody is blocked on belongs on the request path

Before choosing an interval, ask what the stale row *does* while it sits there. Only untidy: a schedule is the whole answer. But if it **refuses the user's next request** (a slot, a lock, a uniqueness guard), the interval is a lockout the user cannot end. Run the cleanup inside the transaction of the request about to be refused, scoped to that caller, and leave the cron as a cross-user backstop. `MnyImportJobService` is the worked example: `reapStaleJobsForUser` runs in `create` and the poll's `findOne`, so a dead import clears within one 1.5s poll, and `reapStaleJobs` dropped to hourly.

Two things that path must get right, both tested: the staleness predicate is **one exported constant** used by the reap and negated by the advisory pre-check (an advisory check that still counts what the reap would clear reinstates the lockout through the back door); and a per-user cleanup whose predicate is a disjunction needs its own parentheses inside `user_id = $n AND (...)` -- assert the composed clause, not an `"AND ("` prefix.

## Deciding a worker is dead does not stop it -- revoke, do not merely record

A reaper's conclusion can be wrong in the direction that costs money: a merely *blocked* worker gets written off, wakes up, and finishes -- and if the reap also advertised a retry, the file lands twice. So an attempt gets an identity, not just a status: `import_jobs.attempt_token` is minted by `claim()`, required by every write that worker makes, and set to NULL by both reaps. The worker's commit checkpoint (`markDataCommitted`) is a fenced compare-and-set on that token and the **last statement of the transaction that wrote the rows**, so a zero-row result throws and rolls all of them back -- one statement later would be a check after the commit (see "Rejection happens before the write" in `docs/backend/database-access-and-tenancy.md`).

Three parts, each a separate way to get it wrong:

- **A status check is not a fence.** `WHERE status = 'running'` passes for a job reaped and re-claimed by a different attempt. Compare the token.
- **A fence the other binary does not know about is not a fence.** During a rolling deployment the previous release's checkpoint names no token, so the rule lives in the database: migration 145's `BEFORE UPDATE` trigger refuses a false -> true `data_committed` on a non-`running` job, from either binary. Deliberately not "and has a token": an old worker's normal state is `running` with a NULL token.
- **Terminal states are monotonic.** `complete()` and `fail()` are compare-and-set on `(status, attempt_token)` and return whether they took; the caller must read that boolean (logging "completed" after a refusal contradicts the reaper's line, with the false one more visible).

The integration suite installs the trigger via `findTriggerMigrations()` in `test/helpers/rls-setup.ts` -- `synchronize` creates no triggers, so without that step a mixed-version test reports the fence as working while nothing enforces it.
