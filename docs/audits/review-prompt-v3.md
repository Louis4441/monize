# Monize Comprehensive Review Prompt — V3

**Status:** active · **Supersedes:** V2 (unversioned, not committed) · **Executable form:** `/audit` (`.claude/commands/audit.md`)

This document carries the provenance and rationale for the comprehensive-review ("audit")
prompt. The **operational prompt is `.claude/commands/audit.md`**, and it is self-contained —
it holds the full text of all ten rules, not a summary of them. Read this document when a
rule's intent is unclear or when revising the prompt.

## Why V3 exists

After the last review round, V2 was clearly better: it helped find problems in secondary
consumers, in cache dependencies, and two material performance problems. The lesson was
therefore **not** "add more bug classes". V3 instead improves **finding calibration,
false-positive rejection, and the distinction between defects and design risks**.

The governing rule:

> Find hidden consumers and dependencies aggressively, but require a concrete present-day
> failure scenario before promoting a concern to a confirmed finding.

Rigorous in two directions at once:

```text
higher recall:
find more hidden consumers, dependencies and semantic migrations

higher precision:
do not promote design smells or hypothetical future drift without a realistic current failure
```

V3 must reduce false alarms **without** losing the ability to find:

- secondary raw-vs-effective consumers;
- derived-cache invalidation omissions;
- in-flight cache/state races;
- repeated semantic DB derivation;
- serial provider amplification.

V3 deliberately does **not** add further sections of the form `check X / check Y / check Z`.
That was V2's breadth, and it was already sufficient.

## The ten rules

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
| 9 | External-review ingestion protocol | Inheriting another reviewer's severity / root cause / fix — including the `CONFIRMED_WITH_DIFFERENT_ROOT_CAUSE` case, where the symptom is right and the scope or cause is wrong. |
| 10 | Fix-review interaction test | A remediation that closes a new finding by reverting an older fix (mechanically moving Manual Post onto `decideSplitProvenance()` would have reverted R10-F2). |

## On the example labels

`C1`, `C3`, `C4`, `S1–S7`, `K2`, `R10-F2` and `PostTransactionDialog` come from the V2 review
round that motivated V3. They are retained because they are the *calibration examples* — each
names a concrete case where a rule fires — and not because they resolve to files in this
repository. `R10-F2` is a contract identifier from that round's task series.

## Monize grounding

The prompt's rules are repository-independent; its "Monize grounding" section names where each
one bites here, and adds targets without granting exemptions:

- **Contracts to name** — `docs/system-invariants.md` (with its `enforced` / `partial` /
  `unenforced` status), the financial, concurrency, external-side-effect, RLS and verification
  contracts, and `docs/adr/`.
- **Consumers to enumerate (Rule 4)** — backend services, the AI executor
  (`backend/src/ai/query/tool-executor.service.ts`), MCP tools (`backend/src/mcp/tools/*`),
  dashboard, budgets, built-in reports, CSV/PDF export, `frontend/src/types/*`; plus the
  repository's own findings that a completeness flag omitted by a frontend type ships a subtotal
  under a total's caption, and that the compact LLM shape dropping a flag makes AI/MCP quote a
  subtotal as settled.
- **Shared-surface pass** — every AI tool is implemented once on a domain service and adapted by
  both the AI executor and the MCP layer; when a refusal is added on one path, the bulk,
  AI-action and MCP routes to the same write are checked too.
- **Deliberate look-alikes (Rule 2)** — per-ledger reconciliation vs the shared VOID boundary;
  `applyRegisterOrder`'s credits-before-debits tiebreak; FX re-resolution only on structural
  change; netting within one category but never across two, with the payee surfaces
  deliberately not netting.
- **Test obligation** — name the test that fails on the *original* mistake; prefer a
  source-scanning guard for a mechanical mistake; treat a green suite after a behavior change as
  a finding in itself.

## Usage

```text
/audit                 # working-tree diff vs merge-base with origin/main
/audit 1234            # PR #1234
/audit my-branch       # git diff origin/main...my-branch
/audit backend/src/... # audit a path as it currently stands
```

`/audit` reports; it does not commit. Apply fixes only when explicitly asked.

## Revising this prompt

V3's value is its calibration, and calibration degrades by paraphrase. When editing:

- keep the source numbering 1–10 and every verbatim quote block intact;
- keep the vertical `text` blocks vertical — they are read as structure, not prose;
- keep the calibration examples; a rule without its example is weaker than it looks;
- prefer adding to "Monize grounding" over rewriting a rule.
