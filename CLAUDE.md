# Monize

Personal finance manager (a Microsoft Money replacement): NestJS + TypeORM backend, Next.js App Router frontend, PostgreSQL, everything in Docker/Kubernetes.

Read `AGENTS.md` first: it holds the commands, the pre-push gate, the Git/PR workflow, the no-go areas and the autonomy rules for every agent. This file holds the rules those checks enforce, and what Claude Code specifically should do. The layer files are `backend/CLAUDE.md` and `frontend/CLAUDE.md` (indexes over `docs/backend/` and `docs/frontend/`), `database/CLAUDE.md` and `e2e/CLAUDE.md`.

## How the instruction files are organised

`AGENTS.md`, this file and the layer files are read on every task, so they hold only what nearly every task needs, each rule in one or two sentences naming the thing to use and the thing not to.

- **Reading.** Before working in a layer, read its `CLAUDE.md`, then only the rows of its "Read when the work touches it" table that match the task.
- **Writing a rule.** A new rule is one line in the layer index (or one sentence here) plus the full entry in the matching `docs/<layer>/*.md` or contract document. If it does not fit in a sentence, it belongs in `docs/`.
- **Never in an instruction file:** the history of the defect, issue and PR numbers, the mechanism of the guard that holds the rule, edge cases, worked examples. Those go in the `docs/` entry, the regression test's comment, or an ADR.
- **A rule the machine enforces needs no essay.** Where a type, a lint rule or a source-scanning test holds a rule, name the abstraction to use and stop; the guard's failure message says what to use instead. `docs/guard-tests.md` says how to write one. `backend/src/common/instruction-files.spec.ts` holds every instruction file under its size ceiling and every `docs/<layer>/*.md` reachable from its index.

## The contract documents

Cross-layer rules live in `docs/`. `docs/system-invariants.md` is the index: every invariant with a stable ID, the mechanism that enforces it, and an honest status of `enforced`, `partial` or `unenforced` (an `unenforced` entry describes something the system currently gets wrong; editing the document does not close the gap). Name the IDs your change touches in the PR.

| Document | Covers |
|---|---|
| `docs/system-invariants.md` | The invariant catalog and its enforcement status. |
| `docs/concurrency-and-idempotency.md` | Which mechanism to use when (atomic delta, unique index, CAS, lock, advisory lock, idempotency key), lock ordering, retry semantics. |
| `docs/financial-semantics.md` | Signs, transfer legs, FX rate direction and precision, per-field precision, split sum rules, commission basis, scheduled occurrences, loan interest. |
| `docs/financial-calculation-contract.md`, `docs/time-series-contract.md` | Cost basis, valuation, missing data, rejection before write, testing requirements, series sampling. Read both before writing or changing any financial calculation. |
| `docs/external-side-effects.md` | Per-provider lifecycle for anything PostgreSQL cannot roll back: attachments, backups, email, providers, id-sharded files on disk. |
| `docs/verification-contract.md`, `docs/testing-contract.md` | Which test kind each invariant requires, which CI job owns it, the adversarial inputs that have broken this codebase before, how to run the suites so a green branch does not read as red. |
| `docs/release-integrity.md` | Zero discovered tests is a failure; the tested, imaged and tagged revisions are one revision. |
| `docs/adr/` | Why a decision was made, and what was rejected. Supersede, never rewrite. |

Any use of "atomic", "single-use", "exactly once", "retryable", "cannot", "always", "complete" or "transactional" must name the mechanism that makes it true: the transaction, the index, the conditional `UPDATE`, the verified checksum. If the mechanism cannot be named, the wording is wrong, not merely vague.

A financial feature of any substance starts from a short approved spec (invariants, truth tables, numerical examples, missing-data policy, test matrix) committed before the implementation it guides; `docs/specs/` holds them.

## Database access (CRITICAL)

**All** database access goes through `withScopedDb` (`backend/src/common/db/scoped-db.ts`), the single RLS-compliant door. Never add an `@InjectRepository(...)` field, a `this.dataSource.createQueryRunner()` call, a `this.dataSource.transaction(...)` call, or a bare `this.dataSource.query(...)`; ESLint bans the first three (`backend/eslint.config.mjs`). `DataSource.transaction()` is banned for a reason the `createQueryRunner()` ban did not cover: it opens a transaction that knows nothing about the ambient scoped manager, so it carries no identity GUCs under enforcement and commits independently of the caller's rollback. Inject `DataSource`; get repositories from the transaction's `EntityManager`; helpers take an `EntityManager`, never a query runner.

```typescript
await withScopedDb(this.dataSource, async (m) => {
  const repo = m.getRepository(UserPreference);
  const row = await repo.findOne({ where: { userId } });
  // ...mutate + repo.save(row); every query shares the transaction and the tenant GUC.
});
```

`withScopedDb` throws without an ambient identity. Authenticated routes have one (`RequestContextInterceptor`); everything else seeds its own from `backend/src/common/db/with-context.ts`: `withUserContext(userId, fn)` for a cron's per-user body, a background write or a bearer-only route; `withSystemContext(fn)` for genuinely cross-user work (fan-outs, seeders, bootstrap hooks, admin); `withDelegateContext(owner, delegate, fn)` where the two ids must differ; `withPreserveTimestamps(fn)` only in the backup restore. A new call site of any of these is added to `WITH_CONTEXT_ALLOWLIST` in the same PR, as a reviewed decision. Nested `withScopedDb` calls join the ambient transaction, so a service calling another is safe. `docs/row-level-security-contract.md` is canonical for exempt tables and the one sanctioned direct-`DataSource` exception; `docs/backend/database-access-and-tenancy.md` has the details and the "whose row is it" table.

## Transactions (CRITICAL)

Any operation that touches multiple tables or does read-modify-write runs in one `withScopedDb` transaction; this is the most common source of bugs in this codebase. **A rejected command must not already have written**: every check that can refuse a request (ownership, tenant or scenario identity, revision, precondition) runs inside the same transaction as the mutation, under the same lock where concurrency matters. Pass the caller's expectation down so the operation can refuse before writing. `docs/financial-calculation-contract.md` section 7 has the rule and the test obligation.

## Financial math

Money is `decimal(20,4)`. In JavaScript, never accumulate floats: sum `Math.round(Number(x) * 10000)` and divide once, or `roundMoney` every result, including a delta (`newAmount - oldAmount` is what a balance moves by). Balance updates are atomic SQL: `UPDATE accounts SET current_balance = current_balance + $1 WHERE id = $2`.

One sentence each; the reasoning and the guard that holds each one are in the contract documents.

- **An exchange rate is not money.** Rates are `NUMERIC(20,10)`: `roundFxRate`, never `roundMoney` or `toFixed(4)`; convert with `applyFxConversion`, validate with `normalizeFxEntry` (`backend/src/common/fx-entry.util.ts`).
- **Rate 1 means "same currency", never "no rate found".** A failed lookup is unknown, not `1` and not the unconverted amount. Aggregate through `FxAggregate` (`backend/src/common/fx-aggregate.ts`); its `total` is `null` while `knownSubtotal` carries what converted.
- **A currency code is derived from the account**, never accepted from the request: `assertTransactionCurrencyMatchesAccount`.
- **A preview computes what the commit will do, through the same code.** Call the same resolver from both.
- **Ask which occurrence before asking how much.** Every surface reads a scheduled occurrence from `ScheduledOccurrenceService` (client: `nextOccurrenceEffectiveAmount`, `nextOccurrenceDueDate`, `occurrenceSettlementAccountId`), never `amount`, `nextDueDate`, `accountId` or `nextOverride?.amount ?? amount`. `null` means unknown and is never a licence to fall back to the snapshot. INV-OCCURRENCE-003.
- **The fix for one surface is not the fix.** When you fix a derived-figure defect, grep every consumer of the raw field (dashboard, reports, exports, AI assistant, MCP, notifications) in the same commit and give them one server-authoritative answer.
- **Convert before summing.** `FxAggregate` on the server, `sumConverted` / `sumEffectiveOccurrences` on the client; a total names its currency; a missing rate and an unknown component are two different reports with two different repairs.
- **The reporting-currency fallback is one constant.** `preferredCurrency` / `resolveUserDefaultCurrency` on the server, `preferredCurrency` on the client, `FALLBACK_DEFAULT_CURRENCY` the only literal per layer.
- **Withholding a figure is only honest if the reader learns why.** A withheld total names its cause at the surface; a bare `null` is a dead end.
- **A subtotal is not a total (CRITICAL).** A field named `total*`, `portfolioValue`, `gain`, `tax` or `estimated*` carries a value only when every component is known; otherwise it is `null` and the partial sum, if returned, goes in its own named field. Never default a price, cost basis or rate to `0` or `1`. **`null` is not the safe answer either**: empty accounts hold zero, move zero, owe zero. Decide which of the two each branch is in before writing it.
- **A completeness flag is read where the numbers are shown.** Track each cause (`fxComplete`, `pricesComplete`), give consumers one `valuationComplete`, carry it to every surface including the LLM shape, read it as `=== false` (absent means no information), and relabel a partial figure rather than leaving a total's caption over it. Zero needs no rate.
- **VOID means no balance moved, on every path that writes one**; inclusion is decided per row, and a cross-owner transfer's legs may hold different statuses. INV-TRANSFER-001.
- **A refusal is only worth as much as its least-guarded entry point.** When you refuse a state on one path, grep the bulk, AI-action and MCP routes to the same write in the same commit.
- **A deletion reverses only what the row contributed**: `deletionBalanceEffect` (`backend/src/common/deletion-balance.util.ts`), never a hand-rolled `-Number(row.amount)`.
- **A balance change is not finished until derived state is invalidated.** A helper returns the accounts it moved; the recompute is dispatched after the commit, never inside the transaction. INV-CACHE-001.
- **A change is a value difference, not a field being present.** Forms resend every field; compare against the row before repricing or re-resolving anything.
- **A share-count replay is written once**: `applyActionToQuantity` / `acquisitionCost` (`backend/src/securities/investment-replay.util.ts`).
- **A category's cost is its signed sum over rows of both signs**, netted within one category: `isNetSpending` / `NET_SPEND_AMOUNT` on the server, `netEntityTotal` on the client; never `totalIncome` or `totalExpenses` alone.
- **What a row is decides a report's filter, never its account type.** `investmentExclusionSql` / `applyInvestmentTransactionFilters` and `reportableTransactionAmountSql` (`backend/src/common/investment-filter.util.ts`). INV-REPORT-001.
- **Rows written in one transaction share `created_at`**, so a register order is `applyRegisterOrder` (`backend/src/transactions/register-order.ts`), never a hand-written `ORDER BY`.

## Follow the existing pattern, and pin it down when you miss it

Before writing a UI control, a data access path, or anything a user interacts with, find how the codebase already does it and do it the same way. This project has one way to make a table row clickable, one date input, one money formatter, one door to the database; the generic solution looks fine in isolation and wrong in place.

**When a human points out a defect in code an AI wrote, that is a missing rule, not just a bug.** Fix it, switch to the existing helper that should have been used, add a regression test that fails on the original mistake (a source-scanning guard where the mistake is mechanical), and write the rule down as one sentence in the right instruction file plus its full entry in `docs/`.

**Prefer the rule the machine can check.** Ranked by how well they hold: a type, a lint rule, a source-scanning test, a paragraph in an instruction file.

**A green suite after a behaviour change is a finding.** Either the change is a no-op or the suite had no case for it; say which, and add the case in the same commit.

**A list that means something is written once, in the place that can check it**: a SQL function the database evaluates, or one TypeScript constant checked against `database/schema.sql` in both directions. Two callers wanting slightly different answers derive one from the other.

**Bytes before the commit, deletes after it.** Object stores and filesystems do not roll back; order them so a failure leaves bytes nobody references, never a row promising bytes that are gone. Anything the server writes to disk goes through `shardedSegments` (`backend/src/common/shard-path.util.ts`), validated with `isShardableId` and asserted inside its base; sharding is storage distribution, never authorization. `docs/external-side-effects.md` and `docs/adr/0003-filesystem-objects-use-id-sharding.md`.

**A doc that names an identifier or a path is a claim about the source.** Renaming or deleting a field, helper or file means grepping `docs/` and every instruction file in the same commit; `backend/src/common/doc-paths.spec.ts` fails an unresolved path.

## Internationalization

Every user-facing string is translated: `useTranslations` on the client, `tr(key, fallback, args)` for exception messages and `emailTranslator(i18n, recipientLang)` for anything composed outside a request on the server. Develop English-first, regenerate the pseudo-locale with `npm run i18n:pseudo`, and translate every other locale as the final commit on the PR; never hand-edit `xx/*`. The locale lists in `frontend/src/i18n/config.ts` and `backend/src/i18n/config.ts` stay in sync. Grep for a key before adding it: `JSON.parse` keeps the last duplicate. A number a person reads is localized by its own preference, `useNumberFormat()` on the client and `backend/src/common/number-locale.util.ts` on the server (`docs/frontend/forms-and-formatting.md`).

## Claude Code specifics

- **Navigate with LSP** (`workspaceSymbol`, `findReferences`, `goToDefinition`, `hover`) before Grep or Read; check LSP diagnostics after every edit and fix them before moving on.
- **Run the safe local actions yourself**: `.claude/settings.json` pre-approves lint, type-check, unit tests, the repo-level check scripts and read-only git. Ask before anything `AGENTS.md` lists under "Ask first".
- **A subagent pays for itself only on a wide read-only sweep or an isolated parallel branch** (the "grep every consumer" fan-out across both layers is the case). A single-file change, a focused test run or a question you can answer from one file is cheaper in-context. Never spawn one to re-run a suite you have already run.
- **Verify, do not assert.** Before reporting done, run the layer's gate from `AGENTS.md` once and quote the result; "should pass" is not a result. Do not re-run the same suite hoping for a different outcome; find the cause.
- **Scope.** Change what was asked and the tests that prove it. A refactor, a new abstraction, a new dependency or a change under `.github/`, `helm/` or `database/migrations/` beyond the task is a separate proposal, stated to the user rather than done.
- **Output.** Report the diff and what you verified; no transcript, no restating the instructions, no emojis.
