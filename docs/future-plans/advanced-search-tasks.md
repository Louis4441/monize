# Advanced Transaction Search: Agent Task List

> Companion to [`advanced-search.md`](./advanced-search.md) (the plan, which carries the decisions, the grammar, the data contract and the truth tables). This file breaks the work into tasks sized for one AI-agent session each. Do the tasks in dependency order; never start a task whose dependencies are unmerged. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a scope violation -- stop and leave a note on the task's issue instead.
- **The plan is the authority on every contract.** The grammar is plan section 4.1; the field-to-column partition is 4.2; operators and the reference key are 4.3; grain is 4.4; the wire shape is section 6; the truth tables are section 8. If the code and the plan disagree, the plan is changed first, in its own commit, with the reason.
- **Two rules apply to every backend task:** escaping happens once, inside the builder (INV-SEARCH-001); and a single bare word matches exactly what it matches today (INV-SEARCH-002).
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `npm run test:changed`; `npm run build && npm run test:integration` where a query changed.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:changed`, `npm run build`.
  - `docs/`: `node scripts/check-docs-manifests.mjs` and, in `backend/`, `npm run test:unit -- doc-paths instruction-files`.
  - Stage new files before running a guard (`git add -N` is enough).
  - New user-facing strings: English catalogs only, then `npm run i18n:pseudo`. The full-locale pass is Q.
- **Terminology:** "the plan" = `advanced-search.md`; "the parser" = `parseTransactionSearch`; "the builder" = the clause builder in `transaction-search.util.ts`; "the helper" = `applyTransactionSearch`; "the echo" = `searchInterpretation`. Section references point at the plan. Re-locate code by symbol, never by line.

## Deployment safety

| Class | Meaning |
| --- | --- |
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Ships a response field or a description that changes no result. |
| **neutral** | Rewrites a live path; behaviour-preserving, with the touched suites as the gate. |
| **change** | Alters what an existing request returns. Named in the PR body and the release note. |

There is no migration. B3 is the only **change**, and it swaps every call site in one PR, so the register, its totals, bulk update and the AI tools never read one search string two ways on the same deployment.

## Task graph

| ID | Issue | Task | Depends on | Deploy class | Status | PR |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | | The parser and its spec; nothing calls it | -- | none | [ ] | |
| B2 | | The builder over the parsed terms, `referenceKey`, the helper; nothing calls them | B1 | none | [ ] | |
| B3 | | Swap every call site to the helper; controller hardening; remove `sanitizeLikePattern`; the guard; the integration spec; the invariant entries | B2 | change | [ ] | |
| B4 | | The echo on `GET /transactions`; the MCP and assistant `searchText` descriptions; the backend search doc | B3 | inert | [ ] | |
| F1 | | `quoteSearchValue` and the two report deep links | B3 | neutral | [ ] | |
| F2 | | Syntax help, interpretation line, placeholder, header help; the client type for the echo | B4 | none | [ ] | |
| F3 | | E2E: `#10` finds one cheque | F2 | none | [ ] | |
| Q | | Every locale, release note, plan status | F1, F2, F3 | none | [ ] | |

**Why B1 and B2 are separate:** the parser is pure and needs only a unit spec that walks the grammar exhaustively. The builder is SQL and needs the reference-key comparison checked against PostgreSQL. Each is reviewable on its own.

**Why B3 swaps every site at once:** the Transactions page shows a list and its totals from two endpoints. If they read the string differently even for one deployment, a multi-word search would show rows whose total disagrees.

**Why F1 waits for B3:** `payee:="Name"` means nothing to a server that predates the syntax. On such a server it would be a substring search for the literal text and would find nothing.

---

## Task details

### B1 -- The parser

**Files:** `backend/src/transactions/transaction-search-query.util.ts` and `backend/src/transactions/transaction-search-query.util.spec.ts` (new).

- `parseTransactionSearch(raw, formats)` and the types of plan section 6, exactly. The grammar is section 4.1 and the fields and aliases are section 4.2 (aliases are normalised: `desc` becomes `memo`, `category` becomes `cat`).
- Amount and date values are read through the existing helpers in `transaction-search-parse.util.ts`, exported from there if they are not already. Never write a second number or date parser. A partial ISO date becomes the period of plan section 7, carried as `between`.
- Caps: cut the input at 200 characters before tokenising. More than 12 terms throws `BadRequestException` with `tr("errors.transactions.searchTooManyTerms", ...)`; the key goes in every backend locale's `errors.json` in the same PR, because `locales.parity.spec.ts` requires it, then run `npm run i18n:pseudo`.
- Malformed and empty values follow decision 6.
- Acceptance: the parser row of plan section 10, written as one `it.each` table of input, expected terms. Also: `#` alone, `-` alone, `"` alone, and a 200-character run with no whitespace.

### B2 -- The builder and the helper

**Files:** `backend/src/transactions/transaction-search.util.ts` and `backend/src/transactions/transaction-search.util.spec.ts`, `backend/src/transactions/apply-transaction-search.ts` and its spec (new).

- The builder takes `(terms, aliases, grain, paramPrefix)` and returns `{ sql, params }`.
  - Its `any` arm is today's `buildTransactionSearchClause` body, moved, not rewritten, with the grain rule of section 4.4 applied to its split arms.
  - Each field's arms are the partition of section 4.2.
  - The `is:uncategorized` and `has:attachment` predicates are called from where the existing filters define them, never restated.
  - Parameters are named `${paramPrefix}${index}${suffix}`; the spec proves two calls with different prefixes never collide.
- `referenceKey` (TypeScript) and its SQL twin, per section 4.3, live in one file. The SQL is built from one template string, so the two cannot drift silently.
- The helper loads the formats from `UserPreference` (lift the duplicated private `resolveSearchTerm` into it), calls the parser, applies the builder with `andWhere`, and returns the parsed terms. A blank string adds nothing and returns `undefined`.
- `buildTransactionSearchClause` keeps its signature in this task, because B3 removes its callers. Nothing calls the new code yet.
- Acceptance:
  - The builder row of plan section 10.
  - The helper spec with a typed `UserPreference` mock covers both number formats.
  - An integration case runs `referenceKey`'s SQL against PostgreSQL on the section 8 reference values and compares with the TypeScript twin.

### B3 -- Every call site, one PR

**Files:**
- `backend/src/transactions/transactions.service.ts` (`findAll`, `buildFilteredIdsSubquery`, the `RegisterRowFilters` search fields)
- `backend/src/transactions/transaction-analytics.service.ts` (`createFilteredAnalyticsQuery`, `getLlmGroupedBreakdown`, `getLlmQueryTransactions`, `getLlmListTransactions`; delete `sanitizeLikePattern`)
- `backend/src/transactions/transaction-bulk-update.service.ts`
- `backend/src/transactions/transactions.controller.ts`
- `backend/src/transactions/transaction-search.util.ts` (delete `buildTransactionSearchClause`)
- `backend/src/transactions/transaction-search.guard.spec.ts` (new)
- `backend/test/integration/transaction-search.integration.spec.ts` (new)
- each touched service's spec
- `docs/system-invariants.md` (a "Search" section with INV-SEARCH-001 to 005, and their index rows)

Work:
- Each site becomes one helper call with its own prefix and grain. Record the grain decision in a one-line comment at each call. `findAll` and `buildFilteredIdsSubquery` must read the string identically, so the target-page lookup and the running balance agree with the listed rows (INV-REGISTER-001).
- While swapping `findAll`, record in the PR whether today's `splits` alias filter trims the drawn splits (plan section 4.4). If it does, the integration spec gains a case showing the register now draws every split of a matched transaction.
- The controller: `/summary`, `/grouped-totals`, `/tag-key-breakdown` and `/monthly-totals` get the same `assertStringParam` and 200-character cut that `findAll` already has.
- Delete `sanitizeLikePattern`. The LLM paths pass the raw string, as the rows path already does (INV-SEARCH-005).
- The guard: no import of the builder or the parser outside the util and the helper, and no `%${` template next to a search identifier in `backend/src/transactions/`. Its failure message names the helper.
- The integration spec is the integration row of plan section 10.
- The PR body states the multi-word change (decision 2) and names INV-SEARCH-001 to 005 and INV-REGISTER-001.
- Acceptance: both truth tables of plan section 8, at both grains, through real PostgreSQL; the INV-SEARCH-002 parity cases per site; every existing transactions, analytics and bulk-update suite green, with each expectation edit justified in the PR as one of the cases decision 2 changes.

### B4 -- The echo and the tool descriptions

**Files:**
- `backend/src/transactions/transactions.service.ts` (the `findAll` return)
- the paginated response type
- `backend/src/transactions/transactions.controller.ts` (Swagger)
- `backend/src/mcp/tools/transactions.tool.ts`
- `backend/src/ai/query/tool-definitions.ts`
- the tool-definition specs
- `docs/backend/ai-and-payees.md` (a "Transaction search syntax" section: the grammar summary, the one-door rule, the grain rule, a pointer to the plan's tables)

Work:
- `searchInterpretation` is exactly the shape of plan section 6. It is present when a non-blank search was sent, and absent otherwise.
- `searchText` in both adapters gets one description: the qualifiers, `:=`, `*`, `-`, quotes, `#n`, the amount and date operators, and that bare words are AND-ed. Keep it within the budget the existing tool-description tests enforce; do not raise the budget.
- Acceptance:
  - The controller spec asserts the echo's presence and absence and one echoed `malformed` term.
  - Both tool specs assert the shared description.
  - `npm run test:unit -- doc-paths instruction-files` passes.

### F1 -- Exact payee deep links

**Files:** `frontend/src/lib/search-query.ts` and `frontend/src/lib/search-query.test.ts` (new), `frontend/src/components/reports/DuplicateTransactionReport.tsx`, `frontend/src/components/reports/SpendingAnomaliesReport.tsx`, and their tests.

- `quoteSearchValue(field, value)` returns `field:="value"`, escaping `\` first and then `"`. Both reports build their `?search=` with it and `encodeURIComponent`.
- Acceptance: the quoting cases (spaces, `"`, `\`, `#`, a leading `-`); each report's link test asserts the new href.

### F2 -- Syntax help and the interpretation line

**Files:**
- `frontend/src/components/transactions/SearchSyntaxHelp.tsx` and `SearchSyntaxHelp.test.tsx` (new)
- `frontend/src/components/transactions/SearchInterpretationLine.tsx` and `SearchInterpretationLine.test.tsx` (new)
- `frontend/src/components/transactions/TransactionFilterPanel.tsx` and its test
- `frontend/src/components/layout/AppHeader.tsx` and its test
- `frontend/src/lib/transactions.ts` (the response type)
- the Transactions page (route /transactions), which passes the echo down to the panel
- `frontend/src/i18n/messages/en/transactions.json` (`filter.search.*` keys; grep each key first), then `npm run i18n:pseudo`

Work:
- Read `docs/frontend/ui-conventions.md` first. The popover follows `RecentTransactionsPopover` for opening, anchoring, Escape and click-outside. Its examples are buttons, each with an accessible name equal to the example text. Clicking one writes the example through the same setter as typing (`handleSearchChange` in the panel; the header's own input state in the header), then closes the popover.
- The interpretation line renders one phrase per term from translated templates keyed by field and op. A negated term reads "not ...", and an ignored term is struck through with its reason. It renders nothing when the echo is absent, and it is `aria-live="polite"`.
- Extend `filter.placeholders.search`.
- Acceptance: the frontend row of plan section 10. The search chip and the URL, storage and debounce behaviour are unchanged, and the existing panel and header suites pass without edits.

### F3 -- End to end

**Files:** `e2e/tests/transaction-search.spec.ts` (new).

- Seed cheques 10, 100 and 1010 in one account. Type `#10` in the filter box and assert exactly one row and the interpretation line's text. Open the help, click the `ref:=10` example, and assert the input holds it.
- Grep `e2e/` for every accessible name F2 introduced.
- Acceptance: the spec passes against `docker-compose.e2e.yml`.

### Q -- Acceptance

**Files:** every locale's `transactions.json` under `frontend/src/i18n/messages/` `docs/release-notes/` (one entry), `docs/future-plans/advanced-search.md` (status line and section 13), the tracking issue.

- Translate every new key, then run `npm run i18n:pseudo`; both parity specs must pass.
- The release note gives three examples (`#10`, `payee:costco -cat:gas`, `date:2026-03 amount:>100`) and states the multi-word change in one sentence.
- In the plan, the status line becomes done and section 13 records each answer. The tracker's task table lists every PR, and the tracker is closed.
