# Monize Comprehensive Review Prompt — V3

**Status:** active · **Supersedes:** V2 (unversioned, not committed) · **Executable form:** `/audit` (`.claude/commands/audit.md`)

This is the canonical, versioned copy of the comprehensive-review ("audit") prompt used to
review Monize pull requests and changesets. The `/audit` slash command is the executable
form of the same prompt; when the two diverge, **this document is authoritative**.

## Why V3 exists

V2 was already wide enough to find new *classes* of problem: it surfaced issues in secondary
consumers, cache-dependency chains, and two real performance problems. The lesson from V2 was
therefore **not** "add more `check X / check Y / check Z` sections". V3 keeps V2's breadth and
instead sharpens **precision**: honest false-positive rejection, and a clean split between
**confirmed defects** and **design risks**.

The target invariant for the whole prompt:

> Find hidden consumers and dependencies aggressively, but require a concrete present-day
> failure scenario before promoting a concern to a confirmed finding.

Rigorous in two directions at once:

```text
higher recall:    find more hidden consumers, dependencies and semantic migrations
higher precision: do not promote design smells or hypothetical future drift without a
                  realistic current failure
```

## The prompt

The operational prompt is `.claude/commands/audit.md`, run as `/audit [target]`. Its phases
are summarised here so the rationale below is self-contained:

- **Phase 0 — Baseline & contract map.** Pin the base revision; name the touched Monize
  contracts and invariant IDs (`docs/system-invariants.md` and the financial/RLS/concurrency
  contracts).
- **Phase 1 — Aggressive discovery (recall).** Read-model semantic-migration pass; upstream
  dependency mutation matrix; shared AI/MCP surface pass.
- **Phase 2 — Mandatory admission gate (precision).** Six questions per candidate; no
  present-day failure scenario means `DESIGN RISK`, not a finding.
- **Phase 3 — PR causality classification.**
- **Phase 4 — Contract-precedence gate** (DRY does not beat a documented exception).
- **Phase 5 — Performance calibration** (`N/S/K` model or benchmark, never label-only).
- **Phase 6 — Consolidation** (one finding per violated invariant, surfaces enumerated).
- **Phase 7 — External-review ingestion** (reconstruct independently; never inherit).
- **Phase 8 — Fix-review interaction test** (a fix must not reintroduce a prior bug).
- **Output** — scope, confirmed findings, design risks, and a mandatory rejected-hypothesis
  table.

## The ten improvements over V2, and what each guards against

Each row maps a V2→V3 improvement to the phase that carries it and the failure it prevents.
The example labels (`C1`, `C3`, `C4`, `R10-F2`, `S1–S7`, `K2`) come from the V2 review round
that motivated V3; they are illustrative, not references to files in this repository.

| # | Improvement | Phase | Guards against |
|---|---|---|---|
| 1 | Mandatory finding-admission gate | 2 | Promoting a reachable-but-harmless concern to a confirmed finding (C4, S1–S7, K2). |
| 2 | Explicit contract-precedence gate | 4 | "Fixing" a deliberately-different path for DRY against a documented contract (C3 vs R10-F2). |
| 3 | PR causality classification | 3 | Charging a PR for a pre-existing `main` bug; **and** missing that a PR *exposed/amplified* a previously-correct consumer. |
| 4 | Read-model semantic-migration rule | 1a | Leaving old-scalar consumers semantically stale when a new `effective`/`current`/`complete` field is added (C1's real, wider scope). |
| 5 | Upstream dependency mutation matrix | 1b | Missing a cache-invalidation link (e.g. no `scheduled:` invalidation after a manual FX refresh). |
| 6 | Performance-finding calibration | 5 | Reporting "N+1" / "sequential async" by label without a call-count model or benchmark. |
| 7 | One finding per violated invariant | 6 | Inflating the count by reporting the same root cause once per surface. |
| 8 | Mandatory rejected-hypothesis table | Output | Silent false positives; unaccounted design risks, pre-existing issues, and external claims. |
| 9 | External-review ingestion protocol | 7 | Inheriting another reviewer's severity / root cause / fix, incl. the `CONFIRMED_WITH_DIFFERENT_ROOT_CAUSE` case. |
| 10 | Fix-review interaction test | 8 | A remediation that closes a new finding by reverting an older fix. |

## Monize-specific grounding

V3 is not generic. Discovery and precedence are anchored to this repository's contracts:

- **Semantic-migration pass (1a)** mirrors the project rule that a completeness flag the
  frontend type omits ships a subtotal under a total's caption — search old-field consumers
  across backend, the AI executor, MCP tools, dashboard, budgets, reports, CSV/PDF, and
  `frontend/src/types/*`.
- **Shared-surface pass (1c)** enforces "every AI tool is implemented once and adapted by both
  the AI executor and the MCP layer", and the "grep the bulk / AI-action / MCP routes" rule
  when a single-path refusal is added.
- **Contract-precedence (4)** protects Monize's deliberate look-alikes: per-ledger
  reconciliation vs the shared VOID boundary, register-order tiebreaks, and
  FX-resolution-only-on-structural-change.
- **Findings** should name the invariant ID from `docs/system-invariants.md` and, where the
  mistake is mechanical, propose a **source-scanning guard test** (the project's preferred
  regression form) rather than a single-case test.

## Usage

```text
/audit                 # working-tree diff vs merge-base with origin/main
/audit 1234            # PR #1234
/audit my-branch       # git diff origin/main...my-branch
/audit backend/src/... # audit a path as it currently stands
```

`/audit` reports; it does not commit. Apply fixes only when explicitly asked.
