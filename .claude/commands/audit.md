---
description: Run a comprehensive Monize code audit (review prompt V3) over a diff, PR, branch, or path — high recall on hidden consumers and semantic migrations, high precision on confirmed findings.
argument-hint: "[diff | PR number | branch | path]  (default: working-tree diff vs merge-base with main)"
---

# Monize Comprehensive Audit — Review Prompt V3

You are performing a **comprehensive audit** of Monize code, not a quick scan. This file is
self-contained: everything you need to run the audit is here. `docs/audits/review-prompt-v3.md`
carries the provenance and the rationale for each rule, and is worth reading when a rule's
intent is unclear — but do not treat this prompt as a summary of it.

V3 is a **calibration** release over V2. V2's scope was already wide enough to find new classes
of problem — it surfaced issues in secondary consumers, cache dependencies, and two material
performance problems. So V3's job is **not** to widen the list of bug classes. Its job is to
improve **finding calibration, false-positive rejection, and the distinction between defects and
design risks**.

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

The rules below are the audit. Adding generic checks dilutes it.

## Recall targets

Reducing false alarms must not cost the ability to find these classes. Treat this as the list
the discovery passes exist to catch:

- secondary raw-vs-effective consumers;
- derived-cache invalidation omissions;
- in-flight cache/state races;
- repeated semantic DB derivation;
- serial provider amplification.

## Scope: `$ARGUMENTS`

Resolve the target first, then state it back before reviewing:

- empty / `diff` → working-tree diff vs `git merge-base HEAD origin/main`.
- a number → that PR (`mcp__github__pull_request_read`, files + diff).
- a branch name → `git diff origin/main...<branch>`.
- a path → audit that file/directory as it currently stands.

Read the **whole** changed surface, not just the hunks: open each touched file, and for every
symbol the diff changes, use `findReferences` / `workspaceSymbol` (LSP) to reach its callers
before judging it. Pin the base revision and re-verify every candidate against it.

## Order of operations

```text
discovery (Rules 4, 5)          -> gather candidates aggressively, no severity yet
admission gate (Rule 1)         -> finding or DESIGN RISK
causality (Rule 3)              -> then, and only then, severity + merge-gate impact
precedence (Rule 2)             -> before any "use the shared helper" proposal
calibration (Rule 6)            -> before any performance finding
consolidation (Rule 7)          -> one finding per violated invariant
external review (Rule 9)        -> if a prior human/model review exists
fix interaction (Rule 10)       -> for every proposed remediation
rejected hypotheses (Rule 8)    -> mandatory, before the final verdict
```

---

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

## Monize grounding

The rules above are the audit; this section names where, in this repository, each one bites. It
adds targets, never exemptions.

**Contracts to name (Rules 1, 2, 8).** State the IDs your findings touch:
`docs/system-invariants.md` (invariant IDs and their `enforced` / `partial` / `unenforced`
status), `docs/financial-calculation-contract.md`, `docs/financial-semantics.md`,
`docs/concurrency-and-idempotency.md`, `docs/external-side-effects.md`,
`docs/row-level-security-contract.md`, `docs/verification-contract.md`, `docs/adr/`. A change
touching money, FX, balances, transfers, splits, investment replay, RLS/`withScopedDb`, or a
shared AI/MCP tool must name the specific sections it interacts with.

**Consumers to enumerate (Rule 4).** Backend services; the AI executor
(`backend/src/ai/query/tool-executor.service.ts`); MCP tools (`backend/src/mcp/tools/*`);
dashboard; budgets; built-in reports; CSV/PDF export; and `frontend/src/types/*`. Two
repository rules make this pass concrete: a completeness flag the frontend type omits ships a
subtotal under a total's caption, and the compact LLM shape dropping a flag makes AI/MCP quote a
subtotal as settled. Read such a flag defensively at the consumer (`=== false`, not `!`).

**Shared-surface pass (Rules 4, 7).** Every AI tool that reads or aggregates data is implemented
once on a domain service and adapted by **both** the AI executor and the MCP layer — a tool
wired into only one layer is a candidate. Equally: when a refusal or restriction is added on one
path, grep the bulk, AI-action and MCP routes to the same write.

**Deliberate look-alikes (Rule 2).** Paths that look duplicated but are not: per-ledger
reconciliation states vs the shared VOID boundary; `applyRegisterOrder`'s credits-before-debits
tiebreak; FX re-resolution only on structural change (a rename must not re-price); netting
within one category but never across two, while the payee surfaces deliberately do not net.

**Test obligation (Rule 10, and every confirmed finding).** Name the regression test that would
fail on the *original* mistake, not merely one that covers the fix. Where the mistake is
mechanical, prefer a source-scanning guard (`frontend/src/test/ui-conventions.test.ts`,
`investment-replay.guard.spec.ts`, `deletion-balance.guard.spec.ts`,
`fx-fallback.guard.spec.ts` are the pattern). A green suite after a behavior change is itself a
finding: either the change is a no-op or the suite had no case for it — say which.

## Output

Produce, in this order:

1. **Scope** — target resolved, base revision pinned, contracts and invariant IDs in play.
2. **Confirmed findings** — most severe first. Each one carries:
   - title, and every affected surface (consolidated per Rule 7);
   - causality class (Rule 3);
   - the six admission-gate answers (Rule 1);
   - the contract / invariant reference, or an explicit note that none covers it;
   - a minimal suggested fix, with its Rule 10 interaction check answered;
   - the regression test that should fail on the original mistake.
3. **Design risks** — reachable but with no present-day failure scenario. Kept strictly separate
   from findings; never counted among them.
4. **Rejected / downgraded hypotheses** — the mandatory Rule 8 table, even if every row is a
   rejection:

   | Candidate | Evidence considered | Why rejected / downgraded | Final classification |
   |---|---|---|---|

5. **External review reconciliation** — only if a prior review exists: each of its findings with
   its Rule 9 category.

Do not modify any source file unless the user explicitly asks for the fixes to be applied —
`/audit` reports; it does not commit.
