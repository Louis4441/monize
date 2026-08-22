---
description: Run the Monize Universal Adversarial Review Protocol (audit V3) over a PR, diff, branch, or path — V3 calibration rules, mandatory invariant lenses, a mutation and counterexample pass, an independent adversarial approval challenge, and a final merge gate ending in APPROVE or REQUEST CHANGES.
argument-hint: "[diff | PR number | branch | path]  (default: working-tree diff vs merge-base with main)"
---

# Monize Universal Adversarial Review Protocol (audit V3)

You are performing a **comprehensive adversarial audit** of Monize code, not a quick scan. This
file is self-contained: everything needed to run the protocol is here.
`docs/audits/review-prompt-v3.md` carries the provenance and rationale, and is worth reading
when a rule's intent is unclear — but do not treat this prompt as a summary of it.

The protocol runs in **seven stages, in order**. No stage may be skipped, merged into another,
or declared unnecessary because the diff looks small.

```text
Stage 0   review target, instruction ingestion, invariant map
Stage 1   V3 calibration rules 1-10
Stage 2   mandatory invariant-specific adversarial lenses
Stage 3   evidence adversary: mutation, counterexample, cross-invariant interaction
Stage 4   remediation artifacts (suggested diffs, never applied)
Stage 5   independent final adversarial approval challenge
Stage 6   final merge gate
Stage 7   finding standard, review ledger, final verdict
```

**Two independent passes are required.** Stages 1–4 are the review. Stage 5 is a *separate* pass
that begins from the assumption that the review's own conclusion is wrong. `APPROVE` is
forbidden until Stage 5 and Stage 6 have both completed.

## Read-only, absolutely

**Never apply, commit, push, or publish remediation during `/audit`. Produce suggested diffs
only.** A suggested diff is an artefact of the review and is never applied by the reviewer — not
on request inside the audit, not "while we're here", not as a convenience. If the user wants
fixes applied, that is a separate task run after the audit has delivered its verdict.

## Governing principle

> Find hidden consumers and dependencies aggressively, but require a concrete present-day
> failure scenario before promoting a concern to a confirmed finding.

Be more rigorous in **two directions at the same time**:

```text
higher recall:
find more hidden consumers, dependencies and semantic migrations

higher precision:
do not promote design smells or hypothetical future drift without a realistic current failure
```

## Do not widen the checklist

Do **not** invent additional sections of the form:

```text
check X
check Y
check Z
```

The stages and rules below are the audit. Adding generic checks dilutes it.

## Recall targets

Reducing false alarms must not cost the ability to find these classes. Treat this as the list
the discovery passes and lenses exist to catch:

- secondary raw-vs-effective consumers;
- derived-cache invalidation omissions;
- in-flight cache/state races;
- repeated semantic DB derivation;
- serial provider amplification.

---

## Stage 0 — Review target, instructions, invariant map

Nothing may be reviewed before this stage completes. Its output is quoted at the top of the
final report.

### 0a. Pin the review target

Resolve `$ARGUMENTS`:

- empty / `diff` → working-tree diff vs `git merge-base HEAD origin/main`.
- a number → that PR.
- a branch name → `git diff origin/main...<branch>`.
- a path → audit that file/directory as it currently stands.

Then name the immutable review target explicitly and use that name for the rest of the audit:

```text
PR_REVIEW_SHA = <full 40-character commit SHA of the PR head at review start>
```

Every finding, every lens and every verdict in this audit is a statement about
`PR_REVIEW_SHA` and nothing else. Never review "the PR" as a moving object.

### 0b. Revision table

Record all five, with full SHAs, before reading any code:

```text
PR head            <sha>   (= PR_REVIEW_SHA)
PR base ref        <ref>   <sha as recorded on the PR>
current main       <sha>   (origin/main, fetched now)
merge base         <sha>   (git merge-base PR_REVIEW_SHA origin/main)
ahead / behind     <n> commits ahead of main, <m> behind
```

Being behind `main` is itself reviewable: a stale base can hide a semantic conflict that merges
cleanly. State whether the diff was computed against the merge base (correct) or against a
`main` tip that the branch has never seen.

### 0c. Head-SHA drift during review

Re-fetch the head before Stage 5 and again in Stage 6. If the head SHA no longer equals
`PR_REVIEW_SHA`:

1. Say so explicitly and record the old and new SHA.
2. Diff `PR_REVIEW_SHA..<new head>` and classify what changed.
3. **Re-run every lens and every rule whose affected invariants the new commits touch** — not
   the whole audit, but never fewer than the affected set. A rebase counts: it changes the base,
   so re-derive the revision table and re-check any finding that depended on the base.
4. Re-pin `PR_REVIEW_SHA` to the new head, and state that findings carried over from the old SHA
   were re-verified against the new one.

A verdict issued against a superseded SHA is void. Never let a verdict outlive its target
silently.

### 0d. Instruction ingestion

Read, before judging anything, every instruction file in scope — they are the specification you
review against:

- every `AGENTS.md` (none exist in this repository today — check, do not assume);
- every `CLAUDE.md`: the root, `backend/`, `frontend/`, `database/`, `backend/src/mcp/`;
- `README.md` and `CONTRIBUTING.md`;
- any directory-scoped instructions covering a touched path.

A rule stated in a scoped file governs its directory over a weaker general statement elsewhere.
Where two instruction files conflict, name the conflict as a finding rather than picking one
silently.

### 0e. Invariant map — before hunting for bugs

Write the invariant map **first**. Bug hunting before the map produces findings with nothing to
measure them against.

For each invariant the change touches: its ID from `docs/system-invariants.md` (with its
`enforced` / `partial` / `unenforced` status), a one-line statement of what must hold, and the
mechanism that makes it hold. An invariant with no named mechanism is already a finding — the
repository's own rule is that "atomic", "single-use", "exactly once", "retryable", "cannot",
"always", "complete" and "transactional" must each name the transaction, index, conditional
`UPDATE` or verified checksum behind them.

Also name any relevant contract section: `docs/financial-calculation-contract.md`,
`docs/financial-semantics.md`, `docs/time-series-contract.md`,
`docs/concurrency-and-idempotency.md`, `docs/external-side-effects.md`,
`docs/row-level-security-contract.md`, `docs/backup-restore-contract.md`,
`docs/database-migrations.md`, `docs/verification-contract.md`, `docs/testing-contract.md`,
`docs/release-integrity.md`, `docs/adr/`.

### 0f. Dataflow spine per material invariant

For every **material** invariant in the map, trace the full spine and write it out:

```text
producer
-> transformations
-> storage
-> consumers
-> side effects
```

Each arrow is a place the invariant can be lost. Consumers and side effects are where this
repository has historically lost them, so neither may be left as "etc." — enumerate them.

---

## Stage 1 — V3 calibration rules

Rules 1–10 are the calibration core. They decide what counts as a finding and how it is
attributed; the lenses in Stage 2 decide where to look.

## 1. Mandatory finding-admission gate

Before treating anything as a finding, you must answer, in writing:

- what concrete input state causes the failure;
- exactly what value or behavior is currently produced;
- what value or behavior is required;
- whether the scenario is reachable through the current code;
- whether there is material impact on the user, data, security, or operations;
- whether the problem exists **now**, or only might arise after a future change.

If a present-day failure scenario cannot be constructed, the result must be classified as
`DESIGN RISK`, not a confirmed finding.

This is what lets concerns of the C4 / S1–S7 / K2 kind (V2 round) be classified quickly and
correctly instead of being reported as defects.

## 2. Explicit contract-precedence gate

Before claiming that a path should use a shared helper, or that two pieces of implementation
should be unified, you must check:

```text
implementation
-> issue acceptance criteria
-> repository specification
-> regression tests explaining historical edge cases
```

If an apparently duplicated path has **deliberately different semantics**, it must not be
"fixed" merely for DRY or structural similarity.

> A shared helper is not automatically the canonical behavior. Before consolidating two
> branches, prove that their input semantics and user-intent contracts are identical. A
> deliberate exception documented by a specification or regression test takes precedence over
> structural similarity.

This rule is what protects against a wrong finding of the C3 kind (V2 round), which collided
with the explicit R10-F2 contract.

## 3. PR causality classification for every finding

Every candidate gets exactly one category:

```text
INTRODUCED_BY_PR
EXPOSED_OR_AMPLIFIED_BY_PR
PRE_EXISTING_BUT_IN_SCOPE
PRE_EXISTING_UNRELATED
```

Only **after** that do you decide severity and merge-gate impact.

`EXPOSED_OR_AMPLIFIED_BY_PR` is the important one. Example: the secondary consumers existed
before, but the PR changed the semantics of the relationship:

```text
persisted amount
vs
effective/current amount
```

so a previously correct consumer became semantically incomplete.

The same classification is what lets you correctly **reject** problems that exist independently
on `main` — the previously found `PostTransactionDialog` problem is the reference case.

## 4. Read-model semantic-migration rule

If the PR introduces, alongside an existing field, a new field of the kind:

```text
effective
resolved
current
forecast
computed
complete
available
```

treat it as a **migration of a semantic contract**, not merely the addition of a new field.

> When a PR introduces an "effective", "resolved", "current", "forecast", "computed", or
> completeness field alongside an existing persisted scalar, assume every consumer of the old
> scalar may now be semantically stale. Search all consumers of the old field, not only
> consumers of the new one.

This is the **stronger form of the secondary-consumer pass**, and it directly addresses the
class of bug found in C1 (V2 round).

## 5. Upstream dependency mutation matrix

For every derived value, write out explicitly its upstream dependencies and every channel that
can change them.

Example:

```text
dependency                    mutation / refresh paths
-------------------------------------------------------
security currency             UI / AI / MCP / API
settlement account currency   UI / AI / MCP / API
exchange rate                 cron / manual refresh / provider refresh
persisted schedule            create / update / override
```

For each row, trace:

```text
mutation
-> invalidation
-> in-flight invalidation
-> component/read-model refresh
```

**This is mandatory for every cached derived financial value.**

Such a matrix is what leads quickly to a missing-invalidation finding — the absent `scheduled:`
invalidation after a manual FX rate refresh is the reference case.

## 6. Performance finding calibration

Do not report "N+1" or "sequential async" on the strength of the pattern's name.

Require **one of two** things:

- a concrete call-count model; or
- a test/benchmark demonstrating the amplification.

> Do not report "N+1" or sequential async work by label alone. Show the actual per-row calls and
> a realistic `N/S/K` model. If the operational effect cannot be bounded or demonstrated,
> classify it as an optimization opportunity rather than a defect.

Example of a properly grounded finding:

```text
50 schedules
same settlement tuple
~303 repeated account/security lookups
```

That is concrete enough to justify a finding.

On its own:

```text
this loop is sequential
```

is not enough.

## 7. One finding per violated invariant, not per surface

If several consumers violate the same invariant from the same root cause, that is **one**
finding, listing every affected surface.

> When multiple consumers violate the same semantic invariant for the same root cause,
> consolidate them into one finding and enumerate affected surfaces. Do not inflate finding
> count by reporting each consumer separately.

Example:

```text
AI
MCP
dashboard
budget
report
CSV/PDF
```

is one finding of the `raw persisted amount vs effective current amount` kind — not six separate
findings.

## 8. Mandatory rejected-hypothesis section

Before the final verdict, write a separate table:

```text
Candidate
Evidence considered
Why rejected or downgraded
Final classification
```

This forces an explicit accounting of:

- false positives;
- design risks;
- pre-existing issues;
- external-review claims;
- suggestions that collide with a repository contract.

In the V2 round, C3 and C4 belonged in this table.

## 9. External review ingestion protocol

If a prior review by a human or another model exists, you must not inherit its severity, root
cause, or suggested fix.

Every external finding gets one category:

```text
CONFIRMED
CONFIRMED_WITH_DIFFERENT_ROOT_CAUSE
DESIGN_RISK
PRE_EXISTING
REJECTED
```

> For every external-review finding, independently reconstruct the scenario from code. Do not
> inherit its severity, root-cause claim, suggested fix, or assumption that the behavior is
> unintended.

Especially important is the category:

```text
CONFIRMED_WITH_DIFFERENT_ROOT_CAUSE
```

because an external reviewer may correctly find the symptom but get the scope or the cause
wrong. Example: C1 (V2 round) was correct, but its real scope covered considerably more than
just AI/MCP.

## 10. Fix-review interaction test

After preparing every suggested remediation, you must ask:

> Which previous regression, documented exception, or explicit user-intent behavior would this
> suggested fix break?

Then re-check:

- historical regression tests;
- the specification;
- comments describing earlier edge cases;
- adjacent paths using similar but deliberately different logic.

This rule protects against a fix that closes a new finding by reverting an earlier one. The
example is C3: mechanically moving Manual Post onto `decideSplitProvenance()` could have
reverted the earlier R10-F2 fix.

---

## Stage 2 — Mandatory invariant-specific adversarial lenses

Every lens below is **mandatory**. A lens that does not apply is answered "not applicable
because <reason>" in the ledger — it is never silently omitted. Each lens names the Monize
contract it is measured against.

### 2a. Full cross-layer verification

For every changed behavior, walk the entire path and state what you found at each hop:

```text
controller
-> DTO / validation
-> auth (guard, ownership, actor derivation)
-> service (transaction boundary)
-> DB (schema, constraints, indexes, RLS)
-> frontend (types, read model, render)
-> tests
```

A change verified at one hop is not verified. `frontend/src/types/*` omitting a field the
backend now returns is the repository's canonical instance of stopping too early.

### 2b. Representation matrix

For every field the change reads, writes or newly introduces, fill in every row — a hole in this
matrix is where the bug lives:

```text
representation   behavior now   behavior required
-------------------------------------------------
absent
null
undefined
zero
default
legacy
stale
```

`absent` and `null` are different claims: during a rolling deploy absent means "no
information", so a completeness flag is read `=== false`, never `!flag`. `zero` and `null` are
different too: an empty account holds zero, moves zero and owes zero — that is known, not
unknown. `legacy` covers rows written before the change; `stale` covers a client or cache
holding a pre-change shape.

### 2c. Browser round-trip

Follow the value out to the browser and back in:

```text
server response -> serialization -> client state -> user edit -> request body -> server
```

Check that what the client sends back is accepted, that a resent unchanged value is not read as
a change (the repository's own rule: a change is a value difference, not a field being present),
and that a driver value survives the trip — `pg` returns `bytea` as a `Buffer` and DATE /
TIMESTAMP as `Date`, and `JSON.stringify` mangles a `Buffer`.

### 2d. Server-authoritative metadata

Any value the server must own may not be accepted from the request. Verify per field which side
is authoritative, and that the server derives rather than trusts:

- a transaction's `currencyCode` is derived from the account
  (`assertTransactionCurrencyMatchesAccount`), never taken from the payload;
- `userId` comes from the JWT (`req.user.id`), never from a param or body;
- an exchange rate for a cross-currency pair resolves server-side or the request is refused;
- timestamps, ids, statuses and computed totals are the server's to set.

A client-supplied value that reaches a balance, a currency, an owner or a total is a finding
regardless of how the UI currently behaves.

### 2e. Identity versus value

Distinguish "the same object" from "an equal value" everywhere the change compares, caches,
keys or dedupes. Ask: is this keyed on an identity that survives an edit, or on a value that
changes under it? Two rows describing one movement of money share identity (a transfer pair, a
split parent and its legs); two equal amounts do not. A cache keyed on a value that mutates
serves the wrong entry; a dedupe keyed on identity that is regenerated per request never
dedupes.

### 2f. State-machine review

Where the change touches a status, enumerate the states and the transitions, then check every
cell — not a representative one:

- which transitions the change permits, and which it must refuse;
- whether a refusal exists on **every** entry point: single write, bulk update, AI action, MCP
  tool, scheduled/automated path;
- what happens on a transition that is already in the target state (idempotence);
- where two rows can hold *different* statuses, every combination. A cross-owner transfer's
  status is per-ledger, so gating both ledgers on one leg's flag is wrong in two of the four
  combinations — four states means a four-case matrix.

`VOID` is the reference invariant: a `VOID` row moved no balance, on every path that writes one.

### 2g. Concurrency and idempotency adversarial pass

Mandatory whenever the change writes. Measured against `docs/concurrency-and-idempotency.md`.

- Name the mechanism: atomic delta, unique index, CAS, row lock, advisory lock, or idempotency
  key. "It's in a transaction" is not a mechanism against a concurrent identical request.
- Interleave two callers explicitly and show the resulting state. Then interleave the same
  caller twice (retry, double-submit, replayed webhook, re-fired cron).
- Verify every refusal — ownership, tenant, scenario identity, revision, precondition — runs
  **inside** the same transaction as the mutation, and under the same lock where concurrency
  matters. A `403`, `404`, `409` or validation failure claims the change did not happen, and an
  HTTP status cannot undo a committed row.
- Check lock ordering against the register in the contract, and check that read-modify-write is
  not split across two `withScopedDb` calls.
- `INSERT ... ON CONFLICT DO NOTHING` followed by a read model must re-read authoritative state
  inside the same transaction, never build the response from the pre-insert snapshot.

### 2h. Partial failure and compensation

Measured against `docs/external-side-effects.md`. For every step that cannot roll back:

- state where the side effect sits relative to the commit, and which failure mode that ordering
  produces. Only one side is survivable: write bytes before the commit and clean up on failure;
  delete bytes after it. The goal is *bytes nobody references*, never *a row promising bytes
  that are gone*;
- walk the failure at each step and name what compensates it, or state that nothing does;
- check that a count of things not done is not summed into the total of things done, and that
  the user is actually told (`skippedAttachments` beside `restored`, not folded into it);
- confirm a post-commit dispatch is not fired from inside the transaction — a rollback must not
  leave a recompute queued for state that was never written.

### 2i. Migration, backfill and legacy data

Measured against `docs/database-migrations.md`. Check:

- `database/schema.sql` updated alongside the migration — always, both directions;
- the migration replays as a no-op on top of `schema.sql` (`CREATE ... IF NOT EXISTS`,
  `DROP ... IF EXISTS` before `CREATE POLICY` / `TRIGGER`), because that is how the app boots; a
  missing guard aborts container start-up and CI then reports only "backend exited (1)";
- existing rows: what does the new code do with data written before it? Name the backfill, or
  state that legacy rows are handled at read time, or that none exist and why;
- any index or constraint declared in more than one place (migration, `schema.sql`, entity
  decorator) is declared in **all** of them — an integration suite building from entities will
  otherwise pass against a database with no constraint to contend over;
- every SQL function `src/` calls is registered in
  `backend/src/common/db/required-db-functions.ts` with the migration that creates it: code and
  schema ship in one image but do not arrive in one process.

### 2j. Backup and restore lens

Measured against `docs/backup-restore-contract.md`. Does a new column, table or file survive
export and re-import? Specifically: every `bytea` column read through `encode(col, 'base64')`;
insertion order and deferred foreign keys declared as data in `restore-plan.ts` and proven
against the schema; sharded paths validated (`isShardableId`) and asserted to resolve inside
their base; and no trigger DDL reintroduced in place of `withPreserveTimestamps`.

### 2k. Financial numerical lens

Measured against `docs/financial-calculation-contract.md`, `docs/financial-semantics.md` and
`docs/time-series-contract.md`. Mandatory whenever a number that represents money, a rate, a
quantity or a ratio is touched:

- **precision** — money is `decimal(20,4)`, a rate is `NUMERIC(20,10)`. `roundFxRate`, not
  `roundMoney`, for rates; round the *delta* too, since the difference of two 4dp decimals is
  not a 4dp decimal;
- **missing data** — a `total*` may carry a value only when every component is known; otherwise
  `null`, with any partial sum in a separately named field. Never default a price, cost basis or
  rate to `0`, and never a rate to `1`. Rate `1` means "same currency", never "no rate found".
  Equally: a state that *is* known must not be `null` — decide which branch each case is in;
- **completeness flags** — union every aggregate's gaps; check the flag survives to each
  consumer including the compact LLM shape and the human-readable summary line; check a nested
  total has its own answer, since a per-account total converts into the account's currency and
  the top-level into the user's;
- **signs and semantics** — a category's cost is its debits net of its credits, netted within
  one category and never across two; a clamp bounds the total, not one of its parts; a deletion
  reverses only what the row actually contributed (`deletionBalanceEffect`);
- **weighting** — convert into one common currency before weighting, and refuse the statistic
  rather than let a priced subset stand in for the portfolio;
- **preview equals commit** — a preview computes what the commit will do, through the same
  resolver;
- **ordering** — `created_at` cannot order rows written in one transaction; a running balance
  needs `applyRegisterOrder`.

### 2l. Auth, RLS, actor versus subject

Measured against `docs/row-level-security-contract.md`. Separate the **actor** (who is making
the request) from the **subject** (whose data is being touched), and check they are never
collapsed where they must differ:

- `withUserContext` collapses owner and delegate onto one id, which silently returns zero rows
  for whichever half it is not — a delegate acting on an owner's data needs
  `withDelegateContext`;
- every controller carries `@UseGuards(AuthGuard('jwt'))` at class level (health and auth
  excepted); every `:id` path param uses `ParseUUIDPipe`; DTOs keep `whitelist` +
  `forbidNonWhitelisted` with `@MaxLength` / `@Min` / `@Max` / `@IsUUID` / `@SanitizeHtml()`;
- all database access goes through `withScopedDb`; a bearer-only route such as `/mcp` seeds its
  own context; a new `withSystemContext` / `withUserContext` call site means an
  `WITH_CONTEXT_ALLOWLIST` entry as a reviewed decision;
- parameterized queries only; user-controlled values in HTML email escaped via `escapeHtml()`;
- sharding is storage distribution, never tenant isolation — an attachment's owner is
  database-authoritative and must not be inferred from its path.

---

## Stage 3 — Evidence adversary

### 3a. Tests are evidence, not proof

A passing suite is evidence that the cases it contains hold. It is not proof the invariant
holds. For every invariant in the map, state which test would fail if the invariant broke — and
if none would, say so plainly; that absence is itself a finding.

Read the tests adversarially: a mocked filesystem cannot demonstrate a filesystem property; a
test asserting `rename` was called says nothing about what the directory looks like after an
unfinished write. A test that reads the wall clock is a test about today's date. A guard walking
the tree with `git ls-files` cannot see an untracked file. And a suite that stays green across a
behavior change is a finding in itself: either the change is a no-op or the suite had no case
for it — say which.

Check known-wrong tests against `docs/verification-contract.md`: some tests in this repository
deliberately assert current defects, and "the test passes" means the opposite there.

### 3b. Mutation — break it on purpose

For each material invariant, name a **specific single-line mutation** to the changed code that
would violate it, and answer: does any existing test fail? Write it as a table:

```text
invariant   mutation (file:line, what to change)   test that fails   verdict
```

`verdict` is `covered` or `undetected`. Every `undetected` row is a test-coverage finding with
the mutation as its proof, and it feeds the regression-test diff in Stage 4.

### 3c. A new counterexample per invariant

For every invariant in the map, construct a **new** counterexample — an input or interleaving
not already covered by an existing test — and run it mentally against the code at
`PR_REVIEW_SHA`. Draw the inputs from `docs/testing-contract.md`'s adversarial list (dates,
money precision, aggregation, currency conversion, ownership, concurrency) so this is selection
from a list, not recall of edge cases. Record the outcome: invariant holds, invariant breaks, or
cannot be determined from the code — and treat the third as a finding about clarity, not a pass.

### 3d. Cross-invariant interaction

Invariants that each hold alone can break together. Before any `APPROVE`, take the invariants in
the map pairwise (and in any triple the change couples) and ask what happens when both apply at
once. The concrete shapes that have failed here: a void row inside a split whose legs cross
owners; an FX-repricing edit concurrent with a rate refresh; a deletion of a future-dated row
whose account is mid-recalculation; a restore replaying rows whose ordering depends on
`created_at`. Record each pair examined and its outcome.

---

## Stage 4 — Remediation artifacts

For each confirmed finding produce **both** artifacts, as text in the report:

1. **A concrete unified remediation diff** — real paths, real line context, in unified diff
   format. Not a description of a fix, not pseudocode. Minimal: what the finding needs, nothing
   more, and never widening the PR.
2. **A concrete regression-test diff** — also unified diff format, and it must **fail on the
   original mistake**, not merely cover the fix. Where the mistake is mechanical, prefer a
   source-scanning guard over a single case (`frontend/src/test/ui-conventions.test.ts`,
   `investment-replay.guard.spec.ts`, `deletion-balance.guard.spec.ts`,
   `fx-fallback.guard.spec.ts` are the pattern). Where the mutation table in 3b produced an
   `undetected` row, the test must kill that mutation.

Then apply Rule 10 to each diff, in writing, before it leaves the report.

**Neither diff is applied.** They are review output.

---

## Stage 5 — Independent final adversarial approval challenge

This is a **separate pass**, not a re-read. It begins only after Stages 1–4 have produced a
provisional conclusion, and it begins from this premise:

> My previous conclusion is wrong. Find a realistic scenario that invalidates the proposed
> APPROVE.

Re-fetch the head first (Stage 0c). Then hunt again, specifically through:

- **representation boundaries** — a row, request or cache entry in a shape the change did not
  anticipate (the 2b matrix, re-attacked rather than re-read);
- **stale clients** — a browser or integration running the previous bundle against the new
  server, and the reverse during a rolling deploy;
- **identity versus value** — a key that looked stable and is not;
- **concurrency** — the interleaving not tried in 2g, including the same actor twice;
- **partial side effects** — the failure between the write and the commit, and between the
  commit and the dispatch;
- **unchanged callers** — every call site the diff did *not* touch that reaches the changed
  code. These are the ones a diff-shaped review structurally cannot see, and where this
  repository's escaped defects have concentrated.

Record the challenge explicitly: what you attacked, what survived, what did not. If it produces
a finding, that finding goes through Rule 1 and the audit returns to Stage 4 for its artifacts.
An `APPROVE` issued without a completed Stage 5 is invalid.

---

## Stage 6 — Final merge gate

All of these must be checked and reported. Any failure blocks `APPROVE`.

```text
[ ] PR head re-fetched; still equals PR_REVIEW_SHA (else Stage 0c, then re-run this gate)
[ ] origin/main re-fetched; merge base and ahead/behind restated
[ ] no BLOCKER findings open
[ ] no HIGH findings open, or each has an explicit, recorded acceptance
[ ] hosted CI on PR_REVIEW_SHA: every check enumerated with its conclusion
[ ] CI red on this PR distinguished from CI red on base (a check failing on base too is not
    this PR's, and is stated as such rather than silently excused)
[ ] migrations: schema.sql parity, idempotent replay, required-db-functions registration
[ ] zero-discovered-tests treated as a failure, not a pass (docs/release-integrity.md)
[ ] i18n: English-first during development; full parity required for main; pseudo-locale
    regenerated; no duplicate keys
[ ] open review threads enumerated, each resolved or explicitly answered
[ ] the tested, imaged and tagged revision is one revision
```

Never infer a CI conclusion. If CI cannot be read, say so and treat the gate as unmet rather
than assumed green.

---

## Stage 7 — Finding standard, ledger, verdict

### 7a. Finding standard

Every finding is reported in this exact shape:

```text
ID              F<n>
Title           one line, the defect, not the symptom
Severity        BLOCKER | HIGH | MEDIUM | LOW
Confidence      CONFIRMED | PROBABLE
Causality       INTRODUCED_BY_PR | EXPOSED_OR_AMPLIFIED_BY_PR |
                PRE_EXISTING_BUT_IN_SCOPE | PRE_EXISTING_UNRELATED
Location        file:line (every affected surface, consolidated per Rule 7)
Invariant       ID from docs/system-invariants.md, or the contract section, or "none covers it"
Root cause      the mechanism that is missing or wrong -- not a restatement of the symptom
Failure         the Rule 1 answers: input state, produced, required, reachability, impact, now
Remediation     the Stage 4 unified diff
Regression      the Stage 4 test diff, and the 3b mutation it kills
Interaction     the Rule 10 answer for this remediation
```

Severity is decided **after** causality (Rule 3). `BLOCKER` means data loss, corruption, a
security or tenancy breach, or a wrong financial figure reaching a user. `PROBABLE` confidence
is allowed only with the reachability question answered yes; anything weaker is a design risk,
not a finding.

### 7b. Review ledger

A single table proving every stage ran, so a reader can audit the audit:

```text
stage / lens                     status      what it produced
---------------------------------------------------------------
0a-0f  target, instructions, map  done        <n> invariants mapped
1      rules 1-10                 done        <n> candidates, <n> admitted
2a-2l  each lens by name          done | n/a  finding ids, or the n/a reason
3a-3d  evidence adversary         done        <n> mutations, <n> undetected
4      remediation artifacts      done        <n> diffs, <n> test diffs
5      approval challenge         done        what was attacked and what survived
6      merge gate                 done        pass | blocked by <item>
```

A lens marked `n/a` without a reason invalidates the ledger.

### 7c. Report order

1. **Review target** — the Stage 0 revision table and `PR_REVIEW_SHA`.
2. **Invariant map** and dataflow spines.
3. **Confirmed findings** — most severe first, in the 7a format.
4. **Design risks** — reachable but with no present-day failure scenario. Kept strictly separate
   from findings; never counted among them.
5. **Rejected / downgraded hypotheses** — the mandatory Rule 8 table, even if every row is a
   rejection:

   | Candidate | Evidence considered | Why rejected / downgraded | Final classification |
   |---|---|---|---|

6. **External review reconciliation** — only if a prior review exists: each of its findings with
   its Rule 9 category.
7. **Review ledger** (7b).
8. **Verdict** (7d).

### 7d. Final verdict

End with exactly one, and nothing hedged:

```text
APPROVE            -- Stage 5 completed and Stage 6 fully met, no BLOCKER, no unaccepted HIGH
REQUEST CHANGES    -- anything else; list the findings that must close, by ID
```

State the SHA the verdict applies to: *"This verdict applies to `PR_REVIEW_SHA` = `<sha>` and to
no later commit."*

### 7e. Re-review after a previous APPROVE

If this audit re-reviews a PR you previously approved, and the head has moved:

1. Treat the previous `APPROVE` as **void**, not as a baseline. Say so explicitly: it covered a
   SHA that is no longer the head.
2. Re-pin `PR_REVIEW_SHA` and re-run the revision table.
3. Diff the previously approved SHA against the new head and re-run every rule and lens whose
   affected invariants those commits touch — at minimum the affected set, and the whole of Stage
   5 and Stage 6 regardless.
4. Never carry a finding's `resolved` status across a rebase without re-verifying it: a
   force-push can restore the code a fix removed.
5. The new verdict replaces the old one and names both SHAs.

---

## Monize grounding

The lenses above already name their contracts. This section holds what is not lens-shaped.

**Consumers to enumerate (Rule 4, lens 2a).** Backend services; the AI executor
(`backend/src/ai/query/tool-executor.service.ts`); MCP tools (`backend/src/mcp/tools/*`);
dashboard; budgets; built-in reports; CSV/PDF export; and `frontend/src/types/*`. Two repository
findings make this concrete: a completeness flag the frontend type omits ships a subtotal under
a total's caption, and the compact LLM shape dropping a flag makes AI/MCP quote a subtotal as
settled.

**Shared-surface pass (Rules 4, 7).** Every AI tool that reads or aggregates data is implemented
once on a domain service and adapted by **both** the AI executor and the MCP layer — a tool
wired into only one layer is a candidate. Equally: when a refusal or restriction is added on one
path, grep the bulk, AI-action and MCP routes to the same write.

**Deliberate look-alikes (Rule 2).** Paths that look duplicated but are not: per-ledger
reconciliation states vs the shared VOID boundary; `applyRegisterOrder`'s credits-before-debits
tiebreak; FX re-resolution only on structural change (a rename must not re-price); netting
within one category but never across two, while the payee surfaces deliberately do not net.

**Documentation as a claim.** A doc or `CLAUDE.md` naming an identifier or path is asserting
something about the source. A rename or deletion means grepping `docs/` and every `CLAUDE.md` in
the same commit; a comment asserting that *every* call site does something should be a scanning
test instead.

**Running the suites.** CI runs in UTC with one Playwright worker. `TZ=UTC npm run test:unit`
matches it; the E2E suite needs `--workers=1` because `zz-danger-zone.spec.ts` deletes the shared
account. `scripts/verify-schema.sh` reproduces the schema-drift job locally.
