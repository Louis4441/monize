---
description: Run a comprehensive Monize code audit (review prompt V3) over a diff, PR, branch, or path — high recall on hidden consumers, high precision on confirmed findings.
argument-hint: "[diff | PR number | branch | path]  (default: working-tree diff vs merge-base with main)"
---

# Monize Comprehensive Audit (Review Prompt V3)

You are performing a **comprehensive audit** of Monize code, not a quick scan. The
canonical, versioned copy of this prompt with its full rationale lives in
`docs/audits/review-prompt-v3.md`; this command is the executable form. When the two
disagree, the doc is authoritative — re-read it if anything here is ambiguous.

## Governing principle

> Find hidden consumers and dependencies aggressively, but require a concrete
> present-day failure scenario before promoting a concern to a confirmed finding.

Be rigorous in **two** directions at once:

- **Higher recall** — find more hidden consumers, upstream dependencies, and semantic
  migrations than a surface read would.
- **Higher precision** — do not promote a design smell or hypothetical future drift to a
  confirmed finding without a realistic *current* failure scenario.

Widening the list of bug *classes* is not the goal. Better calibration, honest rejection
of false positives, and a clean split between **defects** and **design risks** is.

## Scope: `$ARGUMENTS`

Resolve the target first, then state it back before reviewing:

- empty / `diff` → working-tree diff vs `git merge-base HEAD origin/main`.
- a number → that PR (`mcp__github__pull_request_read`, files + diff).
- a branch name → `git diff origin/main...<branch>`.
- a path → audit that file/directory as it currently stands.

Read the **whole** changed surface, not just the hunks: open each touched file, and for
every symbol the diff changes, use `findReferences` / `workspaceSymbol` (LSP) to reach
its callers before judging it.

## Phase 0 — Baseline and contract map

1. Identify the base revision and pin it. Re-verify every candidate against the base:
   something already broken on `main` is not introduced here (but may be **exposed** —
   see Phase 3).
2. List the Monize contracts the change touches and name their IDs:
   `docs/system-invariants.md` (invariant IDs), `docs/financial-calculation-contract.md`,
   `docs/financial-semantics.md`, `docs/concurrency-and-idempotency.md`,
   `docs/external-side-effects.md`, `docs/row-level-security-contract.md`,
   `docs/verification-contract.md`. A change that touches money, FX, balances, transfers,
   splits, investment replay, RLS/`withScopedDb`, or a shared AI/MCP tool **must** name
   the specific contract sections it interacts with.

## Phase 1 — Aggressive discovery (recall)

Run every discovery pass below. Discovery is where recall lives; do not gate it on
severity yet.

### 1a. Read-model semantic-migration pass

When the PR introduces a field named `effective`, `resolved`, `current`, `forecast`,
`computed`, `complete`, `available` (or similar) **alongside** an existing persisted
scalar, treat it as a **semantic-contract migration**, not just a new field.

> Assume every consumer of the *old* scalar may now be semantically stale. Search all
> consumers of the **old** field, not only consumers of the new one.

Enumerate every surface that reads the old field: backend services, the AI executor
(`backend/src/ai/query/tool-executor.service.ts`), MCP tools (`backend/src/mcp/tools/*`),
dashboard, budgets, built-in reports, CSV/PDF export, and `frontend/src/types/*`. Recall
the Monize rule: a completeness/effective flag the frontend type omits ships a subtotal
under a total's caption.

### 1b. Upstream dependency mutation matrix

For every **derived / cached financial value** the change produces or reads, write the
matrix explicitly:

```text
dependency                    mutation / refresh paths
-------------------------------------------------------
security currency             UI / AI / MCP / API
settlement account currency   UI / AI / MCP / API
exchange rate                 cron / manual refresh / provider refresh
persisted schedule            create / update / override
```

For each row trace the full chain and confirm each link exists:

```text
mutation -> invalidation -> in-flight invalidation -> component / read-model refresh
```

A missing link (e.g. no `scheduled:` cache invalidation after a manual FX refresh) is a
discovery candidate.

### 1c. Shared-surface pass

Any AI tool that reads or aggregates data must be implemented **once** and adapted by both
the AI executor and the MCP tool layer (project rule). If the change adds or edits a tool
on only one layer, that is a candidate. Likewise grep the bulk / AI-action / MCP routes to
the same write whenever a single-path refusal or restriction is added.

## Phase 2 — Mandatory finding-admission gate (precision)

**Every** candidate from Phase 1 must pass this gate before it can be called a finding.
Answer all six, in writing, per candidate:

1. What concrete **input state** triggers the failure?
2. What value / behavior is **currently** produced?
3. What value / behavior is **required**?
4. Is the scenario **reachable** through the current code?
5. Is there **material impact** on a user, data, security, or operations?
6. Does the problem exist **now**, or only after a hypothetical future change?

If you cannot construct a present-day failure scenario, classify the candidate as
`DESIGN RISK` — **not** a confirmed finding.

## Phase 3 — PR causality classification

Assign exactly one before deciding severity or merge-gate impact:

```text
INTRODUCED_BY_PR
EXPOSED_OR_AMPLIFIED_BY_PR   <- e.g. PR changed "persisted amount" to "effective/current amount",
                                making a previously-correct consumer semantically incomplete
PRE_EXISTING_BUT_IN_SCOPE
PRE_EXISTING_UNRELATED       <- reject from the merge gate for this PR
```

## Phase 4 — Contract-precedence gate

Before proposing that two branches be unified, or that a path adopt a shared helper:

```text
implementation -> issue acceptance criteria -> repository specification -> regression tests (historical edge cases)
```

> A shared helper is not automatically the canonical behavior. Before consolidating two
> branches, prove that their input semantics and user-intent contracts are identical. A
> deliberate exception documented by a specification or regression test takes precedence
> over structural similarity.

A path that *looks* duplicated may carry deliberately different semantics (Monize is full
of these: per-ledger reconciliation vs shared VOID boundary, register-order tiebreaks,
FX-resolution-only-on-structural-change). Do not "fix" it for DRY.

## Phase 5 — Performance-finding calibration

> Do not report "N+1" or sequential async work by label alone. Show the actual per-row
> calls and a realistic `N/S/K` model. If the operational effect cannot be bounded or
> demonstrated, classify it as an optimization opportunity rather than a defect.

Acceptable (concrete): `50 schedules, same settlement tuple, ~303 repeated account/security
lookups`. Not acceptable: `this loop is sequential`.

## Phase 6 — Consolidation: one finding per violated invariant

> When multiple consumers violate the same semantic invariant for the same root cause,
> consolidate them into one finding and enumerate affected surfaces. Do not inflate the
> finding count by reporting each consumer separately.

`AI / MCP / dashboard / budget / report / CSV/PDF` reading a raw persisted amount where the
effective current amount is required is **one** finding listing six surfaces.

## Phase 7 — External-review ingestion (if any prior human/model review exists)

Do not inherit its severity, root cause, or suggested fix. Independently reconstruct each
scenario from code and classify:

```text
CONFIRMED
CONFIRMED_WITH_DIFFERENT_ROOT_CAUSE   <- symptom right, scope/cause wrong
DESIGN_RISK
PRE_EXISTING
REJECTED
```

## Phase 8 — Fix-review interaction test

For every remediation you propose, answer first:

> Which previous regression, documented exception, or explicit user-intent behavior would
> this suggested fix break?

Then re-check historical regression tests, the spec, edge-case comments, and adjacent paths
that use similar-but-deliberately-different logic. A fix that reintroduces a bug a prior
commit removed is worse than the finding it closes.

## Output

Produce, in this order:

1. **Scope** — target resolved, base revision, contracts/invariant IDs in play.
2. **Confirmed findings** — most severe first. Each: title; affected surfaces (consolidated);
   causality class; the six admission-gate answers; contract/invariant reference; minimal
   suggested fix with its Phase-8 interaction check; the regression test that should fail on
   the original mistake (Monize prefers a source-scanning guard for mechanical mistakes).
3. **Design risks** — reachable-but-no-present-failure concerns, kept separate from findings.
4. **Rejected / downgraded hypotheses** — a mandatory table, even if every row is a rejection:

   | Candidate | Evidence considered | Why rejected / downgraded | Final classification |
   |---|---|---|---|

Do not modify any source file unless the user explicitly asks for the fixes to be applied —
`/audit` reports; it does not commit.
