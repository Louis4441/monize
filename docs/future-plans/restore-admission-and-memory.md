# Restore admission and memory: plan for DR-F3RB-002..004 (issue #1073)

Status: plan, not implemented. Scope approved (`approved-to-build` on issue #1073).

Three findings from audit 03 that the restore path still carries. They are one plan
because they are one chain: the memory constants decide the gate's capacity, the
capacity decides who queues, and the queue is what an unauthenticated upload can
occupy.

| ID | Finding | Nature |
|---|---|---|
| DR-F3RB-002 | `restoreProcessingGate`'s wait queue is unbounded and not cancellation-aware | code |
| DR-F3RB-003 | Upload admission necessarily precedes authentication, so an unauthenticated request can occupy the budget until the receive deadline | design plus deployment |
| DR-F3RB-004 | `PEAK_MULTIPLE` and `restoreProcessBaselineBytes` are estimates; every ceiling in the chain is derived by dividing by the same estimate, so none of them can vouch for it | measurement |

## 0. The state today, in numbers

The subjects are `backend/src/backup/backup-limits.ts`,
`backend/src/backup/restore-processing-gate.ts`,
`backend/src/backup/restore-upload-admission.ts` and their wiring in
`backend/src/main.ts` (lines 182-260). Section 6 of
`docs/backup-restore-contract.md` is the prose contract.

On the chart's default backend (`helm/values.yaml`: requests 140Mi, limits 400Mi):

| Quantity | Where it comes from | Value |
|---|---|---|
| Container limit | `helm/values.yaml` | 400 MiB |
| Expanded limit | `deriveDefaultLimitBytes` (a quarter) | 100 MiB |
| Process baseline | `restoreProcessBaselineBytes` (`max(96 MiB, a fifth)`) | 96 MiB |
| Modeled peak, one restore | `PEAK_MULTIPLE * expanded` | 300 MiB |
| Modeled total | baseline plus peak | 396 MiB, 4 MiB spare |
| Break-even multiple | `(container - baseline) / expanded` | 3.04 |
| Wire limit | `safeDerivedUploadLimit` (`container * 0.5 / 3`) | 66 MiB |
| Processing slots | `computeRestoreProcessingSlots` | 1 |

Two consequences the plan has to change, not merely document:

- A true multiple above 3.04 (3.20 on a 512 MiB or 1 GiB pod) OOM-kills a single
  admitted restore. `backend/src/backup/restore-processing-gate.spec.ts` already pins
  this arithmetic, so the defect is asserted rather than hidden.
- The repository's own sizing assumptions disagree: the chart *requests* 140 MiB for
  ordinary backend use while the baseline formula reserves 96 MiB at a 400 MiB limit.
  One of those two numbers is wrong and only a measurement can say which.

## 1. Decisions to take before code

These are the forks the issue asks for. The recommendation is stated so review can
reject a named choice rather than an absence.

### D1. Queue posture (DR-F3RB-002): bounded, abort-aware queue, not fail-fast

A restore is rare, deliberate and destructive, and the caller has just uploaded up
to 66 MiB. Answering the *second* operator 503 immediately makes them re-upload;
letting them wait costs a held socket. So: keep queueing, but bound it, deadline
it, and drop a waiter whose client is gone.

**The cancellation rule is asymmetric, and that asymmetry is the point.** A queued
restore has done nothing and may be dropped. A restore holding a slot must never be
cancelled by a socket event: it is mid-way through deleting and re-inserting the
user's data. This is the same distinction the upload reservation already draws
between *receiving* and *processing* (`restore-upload-admission.ts`), and it must be
written as one rule with one test each way, or the next reader will "improve" it into
a cancellation that aborts a running restore.

### D2. Pre-auth occupation (DR-F3RB-003): authorize before reserving, at two layers

The gate cannot move behind Nest's guards -- it exists because `express.raw`
allocates before them. So authorization has to move *forward*, ahead of the
reservation:

1. **A short-lived upload ticket.** `POST /api/v1/backup/restore/ticket` is an
   ordinary authenticated JSON route (JWT guard, CSRF, throttler, demo guard all
   apply). It mints a single-use, per-user, TTL-bounded ticket bound to the declared
   content length. The raw upload carries it in a header, and the admission
   middleware validates it *before* reserving budget. An unauthenticated request then
   cannot occupy the budget at all: it is refused with 401 having reserved nothing.
2. **Ingress limits in the chart.** A body-size limit matching `BACKUP_RESTORE_LIMIT`
   and a per-IP connection/rate limit on the restore path, so the process is not the
   first thing a flood reaches. Cheap, real, and only helps deployments that use the
   chart's ingress -- which is why it is the second layer, not the answer.

Streaming the upload through decryption and gzip into a bounded temporary file or an
incremental parser is the real answer to both this and `PEAK_MULTIPLE`, and it is
explicitly **out of scope here**: it is a change to the restore pipeline, tracked with
the export-side streaming work (issue #1070).

Open questions D2 must answer in review, because they are the parts that can be
wrong quietly:

- **Where the ticket lives.** In-memory is one line and breaks on multi-replica
  deployments (the ticket is minted on pod A, the upload lands on pod B, and the
  restore path fails in exactly the incident it exists for). A row in PostgreSQL,
  consumed by a conditional `UPDATE`, is single-use by the index rather than by
  convention. Recommendation: a table, with the compare-and-set as the consumption,
  reached through `withUserContext` from a validator passed into the middleware
  (`main.ts` already has the `DataSource`).
- **When it is consumed.** At admission, not after the body arrives: a ticket
  released on failure is a replay window. A failed upload costs one more cheap
  round trip.
- **What it costs.** One indexed read plus one write per upload attempt, on a path
  that runs a handful of times per deployment lifetime. Only for requests
  `willBuffer` already selects.

### D3. Break the circularity (DR-F3RB-004): derive capacity first, then the ceiling

Measuring `PEAK_MULTIPLE` is necessary but not sufficient. Today the *same* constant
appears in the numerator of the peak and the denominator of every ceiling, so a
measurement that comes back at 3.5 does not merely tighten a number -- it invalidates
the derivation. Two candidate shapes:

- **Option A, keep the shape, raise the inputs.** Set `PEAK_MULTIPLE` to the measured
  maximum plus a margin and let the existing formulas fall out. On the default pod a
  measured 3.5 with a 15% margin gives an expanded limit of 100 MiB and a modeled
  total of 499 MiB against a 400 MiB container: `computeRestoreProcessingSlots`
  returns 0 and **every restore is refused** until the operator raises the pod. Honest,
  and a regression for every existing deployment.
- **Option B, solve for the ceiling (recommended).** Derive the expanded limit from
  the headroom instead of from a fixed share:
  `expanded = (container - baseline) / (measuredMultiple * safetyMargin)`, with **no
  usability floor** -- the same lesson `safeDerivedUploadLimit` already carries, where
  resolving a usability minimum and a safety maximum with `max()` let the floor win
  over the safety. On a 400 MiB pod with a measured 3.0 and a 1.15 margin that is
  88 MiB expanded, a 264 MiB peak, 40 MiB spare and one slot. On a 128 MiB pod it is
  about 9 MiB expanded and one slot -- small restores work, where today both the
  128 and 256 MiB pods refuse every restore. `warnIfRestoreUploadLimitIsCramped` is
  already the pattern for telling the operator their ceiling is small.

Under Option B the chain has one measured input and the slot count is at least one
whenever the container exceeds the baseline, by construction rather than by luck.
The invariant to assert, for every supported pod size: `baseline + slots * measured *
expanded <= container`, with a stated minimum spare.

### D4. Reconcile the baseline with the chart

`restoreProcessBaselineBytes` reserves 96 MiB; `helm/values.yaml` requests 140 MiB.
After measuring the idle-but-serving RSS of the real image, **one** of the two moves
to match the measurement, and the other cites it. A number that exists twice and
disagrees is the clearest argument in the issue for measuring at all.

## 2. Work packages

Ordered by dependency. WP1 gates the constants in WP2; WP3 and WP4 are independent of
the measurement and can land first.

### WP1 -- the cgroup-constrained peak-RSS harness (DR-F3RB-004, measurement)

Not a unit test: it needs a container with a real memory limit, and it must not run
in `test:unit` where a 400 MiB cap would fail the suite on a developer laptop.

- A script under `scripts/` that runs the real restore path in a
  `docker run --memory=<limit>` container, samples `process.memoryUsage.rss()` on an
  interval, and reads the authoritative peak from the cgroup
  (`/sys/fs/cgroup/memory.peak`) after each case. The in-process sample explains the
  shape; the cgroup number is the verdict, because it is what the kernel kills on.
- The matrix, from `docs/testing-contract.md`'s adversarial list plus what this path
  actually varies: plain and encrypted artifacts (MZBE v1 and v2); compression ratios
  at both ends (highly repetitive text, incompressible attachment bytes); artifact
  sizes at and just under the resolved wire limit; an attachment-heavy artifact, since
  base64 rows are the irreducible row cost; and each case repeated with concurrent
  ordinary traffic so the baseline is measured under load rather than idle.
- Output: a committed record of `(case, container limit, expanded bytes, peak RSS,
  implied multiple)` and the derived `measuredMultiple = max(implied)`. Committed,
  because a measurement nobody can find is an estimate again in six months.
- CI: a `workflow_dispatch` job (plus a label trigger) rather than a per-PR gate --
  shared runners are noisy, and a flaky memory gate teaches people to re-run. Take the
  maximum over N runs and apply the margin there.
- A cheap guard that *is* a per-PR gate: a spec asserting the constants in
  `backup-limits.ts` match the committed measurement record, so changing one without
  the other fails. `docs/verification-contract.md` gains the row naming this test kind
  and its owning job.

### WP2 -- constants and derivation (DR-F3RB-004, code)

Blocked on WP1. Implements D3 and D4.

- Replace the fixed-share expanded-limit derivation with the headroom solve; keep the
  environment override as the operator's last word.
- Fold the safety margin in as a named constant with the measurement in its comment,
  not a bare number.
- Rewrite the arithmetic guard in `restore-processing-gate.spec.ts`: it currently pins
  the *defect* (break-even 3.04, one restore that can still exceed the container). It
  must end up pinning the property -- measured multiple plus margin stays below
  break-even on every supported pod size, with the minimum spare asserted.
- Release note: any operator whose pod is smaller than the measurement wants gets a
  smaller expanded ceiling or a refusal, and must hear it from the notes rather than
  from a failed restore.

### WP3 -- bounded, abort-aware processing queue (DR-F3RB-002)

Implements D1, in `restore-processing-gate.ts`.

- `acquire` takes an `AbortSignal` and a wait deadline. A waiter is stored with its
  identity so it can be removed on abort or timeout, rather than surviving as a
  resolve callback nobody can find.
- A queue bound, declared as data next to its documentation and resolved through
  `resolvePositiveInt` (`backend/src/common/env-number.util.ts`) -- never a bare
  `Number(...)`. Documented in `.env.example` and rendered by the chart, both of which
  CI checks (`scripts/check-docs-manifests.mjs`, the env-doc job).
- Queue full, and wait deadline exceeded, both answer 503 **with** `Retry-After`. The
  zero-capacity 503 stays without one -- that distinction is already documented on the
  route (`backend/src/backup/backup.controller.ts`) and the Swagger text has to grow
  the two new conditions in the same commit.
- The signal comes from the request, wired in the controller, and governs **only** the
  wait. Once the slot is acquired the signal is ignored, and that is a test, not a
  comment.
- New refusal messages go through `tr(...)` with English catalog entries plus a
  regenerated pseudo-locale; the other locales come in one pass at acceptance, per the
  English-first rule in the root `CLAUDE.md`.

Test matrix (each of these is a way the current code is wrong or could become wrong):

| Case | Expected |
|---|---|
| Client disconnects while queued | Waiter removed, `waitingCount` returns to 0, the restore never runs |
| Client disconnects while holding a slot | Restore runs to completion; no cancellation |
| Queue at its bound | 503 with `Retry-After`, nothing reserved |
| Wait deadline expires | 503 with `Retry-After`, waiter removed |
| Capacity reconfigured to 0 with waiters queued | All rejected (existing behaviour, kept) |
| FIFO order under mixed aborts | Remaining waiters keep their order |
| Every path | `waitingCount` and `activeCount` return to 0; no leak |

### WP4 -- upload ticket and ingress limits (DR-F3RB-003)

Implements D2.

- The ticket route, the store, and the validator hook on
  `createRestoreUploadAdmission` -- authorization runs before the reservation, and the
  refusal is 401 with nothing reserved.
- The client sends the ticket alongside the existing restore headers. The OIDC
  re-authentication ordering in `backend/src/backup/backup-restore.service.ts` is
  untouched: the ticket authorizes the *upload*, the OIDC artifact authorizes the
  *destruction*, and section 5 of the contract already fixes the second one's place.
- Chart: body-size and rate limits on the restore path, with the values table in
  `helm/README.md` matching `helm/values.yaml` (CI checks that pairing).
- Tests: an upload with no ticket, an expired ticket, another user's ticket, and a
  replayed ticket each refused before `reservedBytes()` moves; a valid one admitted;
  and the multi-replica case argued in the store's design rather than mocked away
  (`docs/verification-contract.md`: a mock proves the call, not the property).

### WP5 -- documentation, and one correction landed with this plan

- Section 6 of `docs/backup-restore-contract.md` said the gate "still floors capacity
  at one" -- describing a floor that F3RB-005 removed. Corrected in the same commit as
  this plan, because a contract doc asserting the opposite of the code is worse than
  no doc.
- On completion: section 6 gains the measured numbers, the queue's bound and
  deadlines, and the ticket's lifecycle; `docs/system-invariants.md` gains a restore
  admission invariant with its enforcement status; `docs/verification-contract.md`
  gains the harness row.

## 3. Acceptance

Issue #1073 closes when all of these hold:

1. A committed measurement of peak RSS per case, taken under a real cgroup limit, and
   `PEAK_MULTIPLE` (or its successor) derived from it with a named margin -- plus the
   per-PR guard that fails when constants and record disagree.
2. `restoreProcessBaselineBytes` and the chart's memory request agree, both citing the
   measurement.
3. For every supported pod size, the asserted inequality holds with a stated spare,
   and the slot count is at least one whenever the container exceeds the baseline.
4. A queued restore whose client disconnects does not run; a running restore is never
   cancelled by a socket event; the queue has a bound and a deadline, both configurable
   and documented.
5. An unauthenticated restore upload reserves nothing.
6. Section 6 of the contract describes the code, and issue #1070 can cite a measured
   bound rather than an estimate.

## 4. Risks

- **The measurement may be unaffordable.** If the true multiple is well above 3, Option
  B shrinks the default deployment's maximum restorable artifact. That is a real
  product cost, and the honest alternative is a larger default pod -- a decision for
  the issue's owner, not for the implementation.
- **CI noise.** Peak RSS on a shared runner is not reproducible to the megabyte. Hence
  max-over-N plus margin, and a dispatch job rather than a gate.
- **The ticket adds a step to a disaster-recovery path.** Two round trips instead of
  one, and a new failure mode (expired ticket) during an incident. TTL generous enough
  to cover a slow upload's start, and the refusal message must name the fix.
- **A queue holds a destructive operation waiting.** Bounded by the wait deadline; the
  operator sees a 503 with `Retry-After` rather than an indefinite hang.
