# Register Sorting: Agent Task List

> Companion to [`register-sorting.md`](./register-sorting.md) (the design and approved spec, issue #521). This file breaks the plan into tasks sized for one AI-agent session each. Do the tasks in dependency order; never start a task whose dependencies are unmerged. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a scope violation -- stop and leave a note instead.
- **The governing invariants apply to every task:** a request without sort parameters is byte-identical to today's (design I9), and a row's running balance is the same figure whichever way the date register runs (design I1). A task that changes the default register's SQL, payload or markup is wrong -- stop.
- **The order and its page window are written once** (design I3). A task that finds itself writing `.limit(skip)` beside a `select("t.id")`, an `ORDER BY` on `createdAt`, or a second running-balance walk in a component is off the plan; put it in `applyRegisterOrder`, `restrictToRowsNewerThanPage` or `walkRunningBalances` and read it.
- **Withhold, never zero** (design I2). Under a non-date order the seed is absent and `startingBalanceWithheld: "sort"` says why; nothing defaults a balance to 0 or walks it against a non-date neighbour.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `TZ=UTC npm run test:unit -- --coverage`; plus `npm run build && npm run test:integration` when a query changed (B1, B2, B3). Database access stays inside the existing `withScopedDb` block of `findAll`; no `with-context` import is needed.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:cov`, `npm run build`.
  - Stage new files before running a guard (`git add -N` is enough); `doc-paths.spec.ts` and the register-order scan walk `git ls-files`.
  - New user-facing strings: English catalogs only, then `npm run i18n:pseudo` in the layer. The full-locale pass is Q3, once, at acceptance -- or per task, in which case Q3 verifies (say which in the PR).
  - The doc line each task names lands in the same PR.
  - The PR body follows `.github/pull_request_template.md`, links issue #521 (label `approved-to-build`), names INV-REGISTER-001 (from Q1 on) and INV-BALANCE-001, and discloses AI assistance.
- **Terminology:** "the design" = `register-sorting.md`; section references point there. Re-locate code by symbol, never by line.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Ships real code that changes nothing until a user clicks a header (the default sort is date desc, which is today's order). Verify the per-task acceptance that proves inertness. |
| **neutral** | Rewrites a live code path (the controller's parameter list, the balance window). Designed behaviour-preserving; the touched module's full unit suite plus the integration suite is the gate. |

Every task is safe to merge in any order that respects its dependencies: the query parameters are optional with today's defaults, the response field is additive, the list props are optional, and no task changes a write path.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Record the decisions on issue #521; the design doc merged | -- | none | [ ] |
| B1 | `TRANSACTION_SORT_FIELDS`, `registerPrimaryOrder`, `applyRegisterOrder` field API and date second leg, `parseTransactionSort`, controller params, AI/MCP enums from the constant | S1 | neutral | [ ] |
| B2 | `RegisterPageWindow`, `isNewestPage`, `restrictToRowsNewerThanPage` at the three windows and four shortcuts; `startingBalanceWithheld`; `calculateTargetPage` direction; target + non-date refusal | B1 | neutral | [ ] |
| B3 | PG integration suite: balance parity, joined-column pagination, the withheld flag, the target page | B2 | none | [ ] |
| F1 | `lib/transaction-sort.ts` (+ contract spec), `lib/running-balance.ts`, `SortableHeader.controls`, `TransactionList` sort props and desktop sortable headers, balance gate, hint, client params and types | B1 (types only) | inert | [ ] |
| F2 | Page wiring: the hook, request key and page reset, deep-link reset, per-row `isFuture` and the divider | F1, B2 | inert | [ ] |
| F3 | Phone chip strip in the slim header | F1 | inert | [ ] |
| Q1 | Guards re-pinned (`register-order.spec.ts`, `ui-conventions.test.ts`), docs, INV-REGISTER-001, verification-contract row | B2, F2 | none | [ ] |
| Q2 | Playwright: sort journeys, balance parity, the phone strip | F2, F3 | none | [ ] |
| Q3 | Full-locale i18n pass (frontend `transactions.json`, backend `errors.json`, both pseudo-locales) | all above | none | [ ] |
| R1 | Report: the target-page comparison and its filters (design 14, R1) | -- | none | [ ] (report only) |
| R2 | Report: the account export's hand-written order (design 14, R2) | -- | none | [ ] (report only) |
| R3 | Report: filters the balance windows ignore (design 14, R3) | -- | none | [ ] (report only) |
| R4 | Report: the divider's source of today (design 14, R4) | -- | none | [ ] (report only) |
| R5 | Report: the LLM rows discard the seed (design 14, R5) | -- | none | [ ] (report only) |

**Why F1 depends on B1 for types only:** F1 mirrors the field constant and adds optional client parameters nothing sends; it renders identically until F2 passes `sort`. It can be built in a parallel session and meets B2 at F2.

**Why B2 is its own PR:** it is the only task that rewrites live balance arithmetic. Its DESC branch is today's code moved behind a helper, and the existing starting-balance describe blocks are the proof; keeping it apart from B1's parameter plumbing keeps that proof readable.

---

## Task details

### S1 -- Record the decisions

Comment on issue #521 linking `register-sorting.md`, summarising decisions 1 to 15 and the two contracts (the two query parameters, the `startingBalanceWithheld` flag), and stating the v1 cuts (section 12). The issue already carries `approved-to-build`; the maintainer's acceptance of the KMyMoney rule is on the issue. No code.

### B1 -- Sort field constant, order API, controller parameters, AI/MCP enums

**Files:** `backend/src/transactions/register-order.ts`, `backend/src/transactions/register-order.spec.ts`, `backend/src/transactions/register-sort-param.ts` + `.spec.ts` (new), `backend/src/transactions/transactions.controller.ts`, `backend/src/transactions/transactions.controller.spec.ts`, `backend/src/transactions/transactions.service.ts` (the type of `sortBy`; the `applyRegisterOrder` call in `findAll` passes the field and `{ account: "account", category: "category" }`; `getLlmTransactionRows`'s type), `backend/src/ai/query/tool-input-schemas.ts`, `backend/src/ai/query/tool-definitions.ts`, `backend/src/ai/query/tool-executor.service.ts`, `backend/src/mcp/tools/transactions.tool.ts`, `backend/src/i18n/locales/en/errors.json` (`transactions.invalidSortBy`, `transactions.invalidSortDirection`) + the regenerated pseudo-locale, `docs/backend/transactions-and-money.md` (one paragraph beside the register-order sentence: the sort field, the date second leg, `NULLS LAST`, what the paginated-join path allows).

- Implement design 6.2 except the window: `TRANSACTION_SORT_FIELDS`, `isTransactionSortField`, `RegisterSortAliases`, `registerPrimaryOrder` (throws for `account` / `category` without the alias), and `applyRegisterOrder`'s fourth parameter changed from a column name to a `TransactionSortField`, with `transactionDate` (list direction) inserted before `createdAt` whenever the field is not `date`. Replace the ternary in `findAll` with the field and alias map. The three balance-window calls keep passing only the alias and direction.
- `parseTransactionSort(sortBy, sortDirection)` per design 6.1: `assertStringParam` first, the allowlist, case-insensitive direction, defaults `date` / `DESC`, `BadRequestException` through `tr(...)` naming the accepted values. The controller reads `@Query("sortBy")` and `@Query("sortDirection")`, adds `@ApiQuery` for both, and passes the parsed pair where `undefined, undefined` sit today.
- AI and MCP in the same PR (`docs/backend/ai-and-payees.md`, "Shared AI tools"): `z.enum(TRANSACTION_SORT_FIELDS)` in both zod schemas, `enum: [...TRANSACTION_SORT_FIELDS]` in the JSON tool definition, the executor's cast widened to `TransactionSortField`; the descriptions list the fields.

**Red first:** in `register-order.spec.ts`, the "keeps the tiebreaks when the user sorts by amount or payee" case now expects `t.payeeName` with `NULLS LAST`, then `t.transactionDate`, then the three legs; a new case that `registerPrimaryOrder("category", "t")` throws without an alias and that `applyRegisterOrder(qb, "t", "DESC", "category", { category: "category" })` orders by `category.name`; the recorded builder gains a `nulls` argument. In `transactions.controller.spec.ts`, the `findAll` pins replace the two `undefined`s with `"date", "DESC"`; a case that `?sortBy=tags` is 400 and `?sortBy=category&sortDirection=asc` reaches the service as `"category", "ASC"`. `register-sort-param.spec.ts`: an array value is 400; `AMOUNT` and `Asc` are accepted; an unknown field is 400; absent gives the defaults. `transactions.service.spec.ts`'s `getLlmTransactionRows` cases stay green as written.

**Acceptance:** a request without sort parameters records exactly today's `orderBy` / `addOrderBy` calls in the service spec's `findAll` mock (I9). `npm run build && npm run test:integration` green (a query changed; the existing running-balance cases in `backend/test/integration/transactions.integration.spec.ts` pass untouched). `register-order.spec.ts`'s "written once" scan still counts four `applyRegisterOrder(` sites (the count moves in B2).

### B2 -- Direction-aware balance window, withheld flag, target page

**Files:** `backend/src/transactions/register-order.ts` (`RegisterPageWindow`, `isNewestPage`, `restrictToRowsNewerThanPage`, the header comment gains the ASC window argument), `backend/src/transactions/register-order.spec.ts`, `backend/src/transactions/transactions.service.ts` (`findAll`'s balance dispatch and `PaginatedTransactions`; `calculateStartingBalance`, `calculateUnfilteredBalance`, `calculateDateFilteredBalance`, `calculateContentFilteredBalance`, `calculateMultiAccountContentFilteredBalance`, `computeNewerRowsSum` take a `RegisterPageWindow` in place of `(safePage, skip)`; `calculateTargetPage` takes the direction), `backend/src/transactions/transactions.service.spec.ts`, `backend/src/i18n/locales/en/errors.json` (`transactions.targetRequiresDateSort`) + pseudo-locale.

- In `findAll`, after `getManyAndCount`, build `window = { skip, limit: safeLimit, total, direction: sortDirection }`. When `sortBy !== "date"`: run no balance query and set `startingBalanceWithheld: "sort"` iff the regime predicate (single account with rows; several or all accounts with content filters and rows) holds. Otherwise compute as today with `window`.
- The three window sites replace `.limit(skip)` + `applyRegisterOrder(q, "t", "DESC")` with `restrictToRowsNewerThanPage(q, "t", window)`; the four `safePage === 1` shortcuts become `isNewestPage(window)`. The DESC branch of the helper is the moved code, unchanged.
- `calculateTargetPage(..., sortDirection)`: under ASC the three comparison operators flip. The refusal for `targetTransactionId` with a non-date `sortBy` sits in `findAll` before any query, through `tr("errors.transactions.targetRequiresDateSort", ...)`.
- Re-pin the "written once" scan in the same PR (Q1 restates it): exactly one `applyRegisterOrder(` and three `restrictToRowsNewerThanPage(` in the service, the `createdAt` ban kept, plus a ban on `.limit(` or `.offset(` beside `select("t.id")` in the service.

**Red first (write these before touching the service):** in `transactions.service.spec.ts`, in each of the four starting-balance describe blocks, an ASC twin of one existing page-2 case whose recording mock expects `offset(skip + limit)`, no `limit(...)`, `orderBy(..., "ASC")`, and the same `getRawOne` sum subtracted (design examples 1 and 3); an ASC newest-page case (`skip + limit >= total`) that issues no window query; a non-date case expecting `startingBalance` undefined, `startingBalanceWithheld: "sort"` and no balance query; a non-date case on all accounts without content filters expecting neither field; a target + non-date case expecting `BadRequestException`; a `calculateTargetPage` ASC case pinning the flipped SQL. In `register-order.spec.ts`: table B row by row (DESC skip 4 -> `limit(4)`; ASC skip 4 limit 2 -> `offset(6)`; ASC skip 0 limit 50 total 5 -> newest page) and the `isNewestPage` truth table. Every existing DESC case is untouched (I9).

**Acceptance:** the whole `transactions.service.spec.ts` green with the DESC cases unedited; the re-pinned scan fails on a planted fourth `applyRegisterOrder(` and on a planted `.limit(skip)`; `npm run build && npm run test:integration` green.

### B3 -- Integration property suite

**Files:** `backend/test/integration/register-sort.integration.spec.ts` (new; fixtures through `createTestUserDirect`, `createTestAccount` and `service.create` under `withUserContext`, as `backend/test/integration/transactions.integration.spec.ts` does).

- **Balance parity (I1):** opening 1000; eleven rows across six dates including a VOID row, a split parent with two lines (the parent counted once), a same-day credit and debit written in one transaction (one `created_at`), and a future-dated row; page size 3. Walk every page under DESC and under ASC with the client's rule (newest-first from `startingBalance`; VOID and children contribute 0; the ASC page reversed first) and assert `balance(ASC)[id] === balance(DESC)[id]` for every id, and that the oldest row's balance minus its amount is 1000. Repeat under (a) an `endDate` filter, (b) a payee filter (zero-based; the anchor is 0), (c) two accounts with a category filter that matches one line of the split parent (`computeSplitAwareSum` on the window, design example 4).
- **Joined-column pagination (design 6.3):** for each field in `TRANSACTION_SORT_FIELDS` and each direction, page size 2 over five rows including a split parent (`categoryId` NULL), a transfer leg with no payee and two rows sharing a category: the pages are disjoint, their union is the set, `pagination.total` equals the row count, NULL names come last in both directions, rows tied on the primary come out in date order.
- **Withheld:** `sortBy: "amount"` on a single account returns `startingBalance` undefined and `startingBalanceWithheld: "sort"`; on all accounts unfiltered it returns neither (table A).
- **Target page:** the same target resolves to mirrored pages under DESC and ASC (from `total` and `limit`); target with `sortBy: "payee"` rejects.

**Acceptance:** `npm run build && npm run test:integration` green, one worker. Once by hand, change `restrictToRowsNewerThanPage`'s ASC branch to `.limit(...)` and confirm the parity case fails; note it in the PR.

### F1 -- Lib helpers, list props, desktop sortable headers

**Files:** `frontend/src/lib/transaction-sort.ts` + `.test.ts` (new), `frontend/src/lib/running-balance.ts` + `.test.ts` (new), `backend/src/transactions/register-sort.contract.spec.ts` (new; reads the frontend file and compares the two constants), `frontend/src/components/ui/SortableHeader.tsx` + `frontend/src/components/ui/SortableHeader.test.tsx` (the `controls` slot), `frontend/src/components/transactions/TransactionList.tsx` + `frontend/src/components/transactions/TransactionList.test.tsx`, `frontend/src/lib/transactions.ts` (`TransactionsGetAllParams`; `getAll` sends `sortBy` / `sortDirection` only when set), `frontend/src/types/transaction.ts` (`startingBalanceWithheld`), `frontend/src/i18n/messages/en/transactions.json` (`list.sort.hint`, `list.sort.stripLabel`) + pseudo-locale, `frontend/CLAUDE.md` (one row: a register's running balance is `walkRunningBalances`).

- Implement design 6.4 and section 10's `TransactionList` bullets except the phone strip. The `runningBalances` memo becomes `walkRunningBalances(...)`, extracted verbatim then given the direction. The eight sortable `<th>`s render through one small helper in the file: `SortableHeader` (with the same class literals inline, in today's order, so `register-columns.guard.test.ts` keeps reading them) when `sort` is supplied, the plain `<th>` otherwise. Date passes `CompactDatesToggle` through `controls`. `account` is omitted from the record's rendered output on a single-account view.
- The hint renders in `ListTopToolbar`'s `actions` slot iff `startingBalanceWithheld === 'sort'`.

**Red first:** `running-balance.test.ts` reproducing examples 1 to 4 both ways, VOID and child rows contributing 0, an absent seed giving an empty map; `transaction-sort.test.ts` for table D (date starts desc, others asc, same field toggles), `resolveRegisterSort`, `isSortedByDate(undefined) === true`; `SortableHeader.test.tsx`: a control in the slot does not change `aria-sort` on click or Enter; `TransactionList.test.tsx`: with `sort`, one `columnheader` with `aria-sort` per field (one fewer on a single-account view); `sort.field === 'amount'` with `isSingleAccountView` renders no Balance header; the hint iff the flag; without `sort` the existing header assertions hold unchanged; the contract spec fails when one entry is removed from the frontend array.

**Acceptance:** every one of the seven `TransactionList` mounts renders unchanged without `sort` (inert); `register-columns.guard.test.ts`, `density-preference.guard.test.ts`, `interactive-row.guard.test.ts` green. `ui-conventions.test.ts`'s balance-expression regex is re-pinned here to the new literal (it still contains `startingBalance !== undefined`; Q1 restates it) and its "supplies `startingBalance` wherever `isSingleAccountView` is set" case is untouched.

### F2 -- Page wiring, deep link, divider

**Files:** `frontend/src/app/transactions/page.tsx`, `frontend/src/app/transactions/page.test.tsx`, `frontend/src/hooks/useTransactionFilters.ts` (only if the deep-link reset is cleaner beside `targetTransactionIdRef`), `frontend/src/components/transactions/TransactionList.tsx` (per-row `isFuture`, the divider), `frontend/src/components/transactions/TransactionList.test.tsx`, `docs/frontend/tables-and-registers.md` (the Balance-column paragraph gains the sort rule and the withheld flag).

- `useSortableTable<TransactionSortField>(TRANSACTION_SORT_STORAGE_KEY, DEFAULT_TRANSACTION_SORT)`; `handleSort` sets `filters.isFilterChange.current = true` and `setSort(prev => nextTransactionSort(prev, field))`; `effectiveSort = resolveRegisterSort(sort, isSingleAccountView)`; `loadTransactions` sends `sortBy: effectiveSort.field, sortDirection: effectiveSort.direction` and lists `effectiveSort` in its dependencies; `setStartingBalanceWithheld` in the same block as `setTransactions`, `setPagination`, `setStartingBalance`.
- Deep link: beside each place that sets `targetTransactionIdRef.current` (mount and the soft-navigation watcher), when `sort.field !== 'date'` call `setSort({ field: 'date', direction: sort.direction })` (design decision 11).
- Divider: `isFuture = tx.transactionDate > today` per row; the divider index per table C; the same source of today as now.

**Red first:** page tests with a `useState`-backed `useLocalStorage` override in their describe: clicking Amount calls `getAll` with `sortBy: 'amount', sortDirection: 'asc'` and `page: 1` while on page 3 (I6); clicking Date twice yields `asc`; `getAllPages` is never called with `sortBy` (I7); a `targetTransactionId` URL under a persisted amount sort requests `sortBy: 'date'`; a persisted `account` sort on a single account requests `date`. List tests: table C row by row; `isFuture` per row under ASC.

**Acceptance:** the default state is byte-identical (`page.test.tsx`'s existing cases untouched, the default request carries `sortBy: 'date', sortDirection: 'desc'` and nothing else new); `balance-cache.guard.test.ts` green; `persisted-storage.guard.test.ts` green with no entry (the key is not a zustand store and is not in the pre-login footprint).

### F3 -- Phone chip strip

**Files:** `frontend/src/components/transactions/TransactionList.tsx`, `frontend/src/components/transactions/TransactionList.mobileWrapped.test.tsx`, `docs/frontend/tables-and-registers.md` (the register clause of "A header that holds controls is replaced, never hidden").

- In the `wrapped` branch, when `sort` is supplied, a second `<tr>` (`flex flex-wrap gap-x-2 gap-y-1 px-4 py-2`, `aria-label` `list.sort.stripLabel`) of `SortableHeader` chips with `PHONE_HEADER_CLASS` from `Object.values(columns)` follows the slim control row, which keeps select-all and the date toggle. No `registerColumnClass` on a chip.

**Red first:** with `sort`, every field has a chip and the slim row still has the toggle and select-all; without `sort` the existing one-cell assertion holds; a chip click calls `onSortChange` with its field; the `account` chip is absent on a single-account view.

**Acceptance:** at 320px the strip wraps and the `overflow-x-auto` wrapper's `scrollWidth === clientWidth` (the measurement rule in `docs/frontend/tables-and-registers.md`); the existing mobile tests are untouched; `ui-conventions.test.ts`'s "mobile-table chrome constants live once" block green (the class is imported, never spelled).

### Q1 -- Guards, docs, invariant

**Files:** `backend/src/transactions/register-order.spec.ts` (restate the B2 re-pin if B2 landed without it), `frontend/src/test/ui-conventions.test.ts` (restate the F1 re-pin), `docs/system-invariants.md` (index row and the entry), `docs/verification-contract.md` (a matrix row), `docs/backend/transactions-and-money.md`, `docs/backend/entities-and-dtos.md` (the `applyRegisterOrder` sentence gains "and the sort field; the page window is `restrictToRowsNewerThanPage`"), `docs/frontend/tables-and-registers.md`, `backend/CLAUDE.md` (the register-order row names the window helper), `docs/guard-tests.md` (only if a new recipe is needed).

- **INV-REGISTER-001 -- a row's running balance is the same figure whichever way the date register runs, and no balance is shown under any other order.** Statement, source of truth (the ledger rows in `applyRegisterOrder`'s total order; `AccountsService.getProjectedBalance`), enforcement (`restrictToRowsNewerThanPage` the one window, `walkRunningBalances` the one walk newest-first, `startingBalanceWithheld` set in `findAll` and read by `showRunningBalance`; the three guards: `register-order.spec.ts` one plus three sites, `ui-conventions.test.ts` the balance expression, `register-sort.contract.spec.ts` one field list), concurrency scope (none: reads), retry semantics (idempotent reads), failure response (the seed absent, the column withheld, never a zero), required tests (unit `register-order.spec.ts` and `running-balance.test.ts`; PG integration `register-sort.integration.spec.ts`, required; E2E Q2), status `enforced` once B3 has landed.

**Acceptance:** each guard fails on a planted offender (a fourth `applyRegisterOrder(` in the service; `showRunningBalance` without the sort term; a field removed from the frontend constant) and passes on the tree. `git add -N` then `npm run test:unit -- doc-paths` and `node scripts/check-docs-manifests.mjs` green.

### Q2 -- Playwright

**Files:** `e2e/tests/transactions.spec.ts`, `e2e/tests/mobile.spec.ts`, `e2e/helpers/` (only if a factory is missing).

Seed one account with rows through the API: distinct dates and amounts, one VOID, more rows than the page size so page 2 exists. Journeys: click the Amount `columnheader` -> rows in amount order, no Balance header, the hint visible; click Date -> the Balance is back, record each row's figure; click Date again -> `aria-sort="ascending"`, the same figure beside the same row, the oldest row first; reload -> the sort persists; go to page 2 under ascending -> its first balance continues page 1's last. Mobile: at a phone viewport at Normal density the chip strip is present, a chip sorts, and the year toggle still works without sorting. Selectors by role and label, never by class.

**Acceptance:** `npm test -- tests/transactions.spec.ts` and `npm test -- tests/mobile.spec.ts` green against `docker-compose.e2e.yml`.

### Q3 -- Full-locale i18n pass

**Files:** `frontend/src/i18n/messages/*/transactions.json` (`list.sort.hint`, `list.sort.stripLabel`), `backend/src/i18n/locales/*/errors.json` (`transactions.invalidSortBy`, `transactions.invalidSortDirection`, `transactions.targetRequiresDateSort`), both regenerated `xx` pseudo-locales.

Translate every key the tasks added, in one commit, or verify that the tasks translated per task and say so here. `messages.parity.test.ts`, `locales.parity.spec.ts` and `npm run i18n:check` in both layers green.

### R1 to R5 -- Report, do not build

File each item in design section 14 with the maintainer as its own proposal, naming the files and the fix sketched there. R1 (the target-page comparison) is the one that unlocks a deep link under any sort; R3 (filters the balance windows ignore) is the one most likely to be reported by a user as a wrong balance. This plan changes none of them.
