# Monize Universal Adversarial Review Protocol — audit V3

**Status:** active · **Supersedes:** V2 (unversioned, not committed) · **Executable form:** `/audit` (`.claude/commands/audit.md`)

This document carries the provenance and rationale for the comprehensive-review ("audit")
protocol. The **operational prompt is `.claude/commands/audit.md`**, and it is self-contained —
it holds the full text of every stage, rule and lens, not a summary. Read this document when a
rule's intent is unclear or when revising the protocol.

## Structure

The protocol is two layers. The **V3 calibration rules** decide what counts as a finding; the
**Universal Adversarial layer** decides where to look, how hard to attack the review's own
conclusion, and what must be true before a PR may be approved.

```text
Stage 0   review target, instruction ingestion, invariant map
Stage 1   V3 calibration rules 1-10
Stage 2   mandatory invariant-specific adversarial lenses (2a-2l)
Stage 3   evidence adversary: mutation, counterexample, cross-invariant interaction
Stage 4   remediation artifacts (suggested diffs, never applied)
Stage 5   independent final adversarial approval challenge
Stage 6   final merge gate
Stage 7   finding standard, review ledger, final verdict
```

Two independent passes are required. Stages 1–4 are the review; **Stage 5 is a separate pass
that starts from the premise that the review's conclusion is wrong.** `APPROVE` is forbidden
until Stage 5 and Stage 6 have both completed. This is the difference between a very good audit
prompt and an adversarial process.

## Why the calibration layer exists

After the V2 review round, V2 was clearly better: it found problems in secondary consumers, in
cache dependencies, and two material performance problems. The lesson was **not** "add more bug
classes" — it was to improve **finding calibration, false-positive rejection, and the
distinction between defects and design risks**.

Governing rule:

> Find hidden consumers and dependencies aggressively, but require a concrete present-day
> failure scenario before promoting a concern to a confirmed finding.

```text
higher recall:
find more hidden consumers, dependencies and semantic migrations

higher precision:
do not promote design smells or hypothetical future drift without a realistic current failure
```

Reducing false alarms must not cost the ability to find: secondary raw-vs-effective consumers;
derived-cache invalidation omissions; in-flight cache/state races; repeated semantic DB
derivation; serial provider amplification.

The protocol deliberately does **not** add further generic sections of the form
`check X / check Y / check Z`.

## The ten calibration rules

The prompt keeps the source numbering 1–10, so a review's output maps back to a rule by number.

| # | Rule | Guards against |
|---|---|---|
| 1 | Mandatory finding-admission gate (six questions; else `DESIGN RISK`) | Promoting a reachable-but-harmless concern to a confirmed finding (C4, S1–S7, K2). |
| 2 | Explicit contract-precedence gate (`implementation -> acceptance criteria -> specification -> regression tests`) | "Fixing" a deliberately-different path for DRY against a documented contract (C3 vs R10-F2). |
| 3 | PR causality classification, *before* severity | Charging a PR for a pre-existing `main` bug (`PostTransactionDialog`); and missing that a PR *exposed or amplified* a previously-correct consumer. |
| 4 | Read-model semantic-migration rule — the stronger form of the secondary-consumer pass | Leaving old-scalar consumers semantically stale when an `effective`/`current`/`complete` field is added (C1's real, wider scope). |
| 5 | Upstream dependency mutation matrix — mandatory for **every** cached derived financial value | A missing link in `mutation -> invalidation -> in-flight invalidation -> refresh` (the absent `scheduled:` invalidation after a manual FX refresh). |
| 6 | Performance calibration — a call-count model **or** a benchmark | Reporting "N+1" / "sequential async" by label alone. |
| 7 | One finding per violated invariant, surfaces enumerated | Inflating the count by reporting the same root cause once per surface. |
| 8 | Mandatory rejected-hypothesis table | Silent false positives; unaccounted design risks, pre-existing issues, external claims, and suggestions colliding with a repository contract. |
| 9 | External-review ingestion protocol | Inheriting another reviewer's severity / root cause / fix — including `CONFIRMED_WITH_DIFFERENT_ROOT_CAUSE`, where the symptom is right and the scope or cause is wrong. |
| 10 | Fix-review interaction test | A remediation that closes a new finding by reverting an older fix (mechanically moving Manual Post onto `decideSplitProvenance()` would have reverted R10-F2). |

## The adversarial layer, and what each part is for

| Part | Requirement | Why it is mandatory |
|---|---|---|
| 0a | `PR_REVIEW_SHA` as an explicitly named immutable review target | A verdict about "the PR" is a verdict about nothing; findings must be statements about one revision. |
| 0b | PR head + base + current `main` + merge base + ahead/behind | A stale base hides a semantic conflict that still merges cleanly. |
| 0c | Head-SHA drift handling, and re-running affected invariants after a new commit or rebase | A verdict must never outlive its target silently. |
| 0d | Read every `AGENTS.md`, `CLAUDE.md`, `README`, `CONTRIBUTING` and scoped instruction file | These are the specification the code is reviewed against; a scoped file governs its directory. |
| 0e | Explicit invariant map **before** hunting for bugs | Findings need something to be measured against; an invariant with no named mechanism is already a finding. |
| 0f | `producer -> transformations -> storage -> consumers -> side effects` per material invariant | Every arrow is a place the invariant can be lost; consumers and side effects are where this repository loses them. |
| 2a | Full cross-layer path: controller → DTO → auth → service → DB → frontend → tests | A change verified at one hop is not verified. |
| 2b | Representation matrix: `absent / null / undefined / zero / default / legacy / stale` | `absent` ≠ `null` during a rolling deploy; `zero` ≠ `null` for an empty account. |
| 2c | Browser round-trip | A resent unchanged value must not read as a change; driver values (`Buffer`, `Date`) must survive serialization. |
| 2d | Server-authoritative metadata rule | A currency, owner, rate or total accepted from the request is a defect regardless of current UI behavior. |
| 2e | Identity versus value | A cache keyed on a mutating value serves the wrong entry; a dedupe keyed on a per-request identity never dedupes. |
| 2f | State-machine review | Four states means a four-case matrix, and a refusal must exist on every entry point (single, bulk, AI, MCP, scheduled). |
| 2g | Concurrency / idempotency adversarial pass | "It's in a transaction" is not a mechanism; a refusal outside the transaction cannot undo a committed row. |
| 2h | Partial failure and compensation | Only one side of the commit boundary is survivable for a side effect that cannot roll back. |
| 2i | Migration / backfill / legacy-data review | `schema.sql` parity, idempotent replay, and constraints declared in every place that declares them. |
| 2j | Backup / restore lens | A new column or file must survive export and re-import. |
| 2k | Financial numerical lens | Precision, missing-data policy, completeness flags, signs, weighting, preview-equals-commit, ordering. |
| 2l | Auth / RLS actor-vs-subject lens | Collapsing actor and subject silently returns zero rows for whichever half it is not. |
| 3a | "Tests are evidence, not proof" | A green suite after a behavior change is a finding; some tests here deliberately assert defects. |
| 3b | Mutation — break it on purpose | An `undetected` mutation is a coverage finding with its own proof. |
| 3c | A new counterexample per invariant | Selection from the adversarial list, not recall of edge cases. |
| 3d | Cross-invariant interaction before `APPROVE` | Invariants that hold alone break together. |
| 4 | Concrete unified remediation diff **and** concrete regression-test diff | A described fix is not reviewable; the test must fail on the original mistake. |
| 5 | Independent final adversarial approval challenge | The pass that attacks the reviewer's own conclusion, especially unchanged callers a diff-shaped review cannot see. |
| 6 | Final merge gate: re-fetch head, `main`, BLOCKER/HIGH, hosted CI, migrations, review threads | An approval must rest on checked state, never inferred CI. |
| 7a | Full severity / confidence / location / root-cause finding format | Severity is decided after causality; a root cause is not a restatement of the symptom. |
| 7b | Review ledger | It lets a reader audit the audit; an `n/a` lens without a reason invalidates it. |
| 7c–7d | Report order and an exact `APPROVE` / `REQUEST CHANGES` verdict naming its SHA | No hedged conclusions. |
| 7e | Special procedure after a previous `APPROVE` | A prior approval is void once the head moves, and a force-push can restore code a fix removed. |

## Read-only

The audit is read-only, absolutely: **never apply, commit, push, or publish remediation during
`/audit`; produce suggested diffs only.** A suggested diff is an artefact of the review and is
never applied by the reviewer. Applying fixes is a separate task, run after the verdict.

## On the example labels

`C1`, `C3`, `C4`, `S1–S7`, `K2`, `R10-F2` and `PostTransactionDialog` come from the V2 review
round that motivated V3. They are retained because they are the *calibration examples* — each
names a concrete case where a rule fires — and not because they resolve to files in this
repository. `R10-F2` is a contract identifier from that round's task series.

## Provenance and known gap

The calibration rules 1–10 are transcribed from the V3 improvements document supplied by the
maintainer. The adversarial layer (Stages 0, 2–7) was **reconstructed from a 31-row conformance
table** produced by an external review of this branch, not from the Universal Adversarial Review
Protocol document itself, which was not available to the author of this commit. Every row of that
table is implemented, but the wording is a reconstruction. **If the original protocol document is
supplied, reconcile this prompt against it verbatim** — the two-round history of this file is
that calibration degrades by paraphrase.

## Monize grounding

The lenses name their own contracts inline. What is not lens-shaped lives in the prompt's
grounding section: the consumer surfaces to enumerate for Rule 4
(`backend/src/ai/query/tool-executor.service.ts`, `backend/src/mcp/tools/*`, dashboard, budgets,
built-in reports, CSV/PDF export, `frontend/src/types/*`); the shared AI+MCP tool rule; the
deliberate look-alikes that must not be unified for DRY (per-ledger reconciliation vs the shared
VOID boundary, `applyRegisterOrder`'s tiebreak, FX re-resolution only on structural change,
netting within one category); documentation as a claim about the source; and how to run the
suites the way CI does.

## Usage

```text
/audit                 # working-tree diff vs merge-base with origin/main
/audit 1234            # PR #1234
/audit my-branch       # git diff origin/main...my-branch
/audit backend/src/... # audit a path as it currently stands
```

## Revising this protocol

Its value is its calibration, and calibration degrades by paraphrase. When editing:

- keep the source numbering 1–10 and every verbatim quote block intact;
- keep the vertical `text` blocks vertical — they are read as structure, not prose;
- keep the calibration examples; a rule without its example is weaker than it looks;
- never let a stage become optional, and never let `APPROVE` precede Stages 5 and 6;
- prefer adding to "Monize grounding" over rewriting a rule or a lens.
