# Calendar View: Agent Task List

> Companion to [`calendar-view.md`](./calendar-view.md) (the design and approved spec). This file breaks the plan into tasks sized for one AI-agent session each. Do the tasks in dependency order; never start a task whose dependencies are unmerged. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a scope violation -- stop and leave a note instead.
- **The governing invariant applies to every task:** Table mode is byte-identical after your change (design I9). Every new branch is entered only when the surface's view is `calendar`. If your change alters table-mode behaviour, the task is wrong -- stop.
- **Every figure is the server's** (design I1). A task that finds itself summing amounts, walking a recurrence or deciding "projected" from the browser clock in a component is off the plan; put the rule in the endpoint the design names and read it.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `TZ=UTC npm run test:unit -- --coverage`; plus `npm run build && npm run test:integration` when a query or an entity changed. New DB access is `withScopedDb`; the three read models need no `with-context` import.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:cov`, `npm run build`.
  - Stage new files before running a guard (`git add -N` is enough).
  - New user-facing strings: English catalogs only, then `npm run i18n:pseudo`. The full-locale pass is Q3, once, at acceptance.
  - The doc line each task names lands in the same PR.
- **Terminology:** "the design" = `calendar-view.md`; section references point there. Re-locate code by symbol, never by line.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Ships real code or endpoints that change nothing until a user toggles Calendar (or until a later task calls them). Verify the per-task acceptance that proves inertness. |
| **neutral** | Rewrites a live code path (an extraction, an additive response field). Designed behaviour-preserving; the full unit suite of the touched module is the gate. |

Every task is safe to merge in any order that respects its dependencies: the endpoints are additive, the toggle defaults to `table`, and no task changes a write path.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Discussion agreeing `calendar-view.md`; label `approved-to-build` | -- | none | [ ] |
| F1 | `lib/calendar-month.ts`, `MonthGrid`, `ViewModeToggle`, `viewModeStore` (+ guard entries) | S1 | inert | [ ] |
| B1 | `rate-index.util.ts` extraction + `GET /accounts/daily-balance-totals` | S1 | inert (extraction neutral) | [ ] |
| B2 | `investments-daily`: `pricesComplete` / `unpricedSecurityIds` (additive) + client type | S1 | neutral | [ ] |
| B3 | `external-flow.util.ts` extraction + `GET /portfolio/daily-movements` and `/detail` | S1, B2 | inert (extraction neutral) | [ ] |
| F2 | Transactions page: calendar wiring, Transactions layer, day panel, `TransactionForm.defaultDate` | F1 | inert | [ ] |
| F3 | Transactions page: Balances layer + banner | F2, B1 | inert | [ ] |
| F4 | Investments page: calendar wiring, Transactions and Values layers, `InvestmentTransactionForm.defaultDate` | F1, B2 | inert | [ ] |
| F5 | Investments page: Daily change layer + `DailyMovementDialog` | F4, B3 | inert | [ ] |
| F6 | Phone layout, keyboard navigation and screen-reader pass across both calendars | F3, F5 | inert | [ ] |
| Q1 | `calendar.guard.test.ts` + the `ui-conventions.test.ts` month-grid block | F1 | none | [ ] |
| Q2 | Backend integration suite `calendar-read-models.integration.spec.ts` | B1, B3 | none | [ ] |
| Q3 | Playwright `tests/calendar.spec.ts` | F3, F5 | none | [ ] |
| Q4 | Full-locale i18n pass (acceptance, final commit) | all above | none | [ ] |
| M1 | Migrate `app/bills/page.tsx` and `UpcomingBillsReport.tsx` onto `MonthGrid`; shrink the baseline | F1, Q1 | neutral | [ ] (optional, separate proposal) |
| R1 | Report: `investments-daily.value` should be `null` on an unpriced day (design 6.2) | B2 | none | [ ] (report only; not built here) |

**Why F1 and the B tasks have no dependency on each other:** the grid, the toggle and the store are layout and preference; the read models are pure additions. They can be built in parallel sessions and meet at F3/F5.

---

## Task details

### S1 -- Proposal

Open a Discussion linking `calendar-view.md`, summarising decisions 1-11 and the three endpoints, and asking the maintainer to confirm two choices explicitly: the app-palette colouring (decision 4, not Quicken's three families) and the net-of-flows daily change (decision 8, not price-only). Record the answers as edits to the design before F1 starts.

### F1 -- Grid, toggle, store

**Files:** `frontend/src/lib/calendar-month.ts` + `.test.ts` (new), `frontend/src/components/ui/MonthGrid.tsx` + `.test.tsx` (new), `frontend/src/components/ui/ViewModeToggle.tsx` + `.test.tsx` (new), `frontend/src/store/viewModeStore.ts` + `.test.ts` (new), `frontend/src/store/persisted-storage.guard.test.ts` (one entry with its reason), `frontend/src/i18n/messages.ts` (register `calendar`), `frontend/src/i18n/messages/en/calendar.json` (new), `docs/frontend/ui-conventions.md` (entry "A month grid is `MonthGrid`"), `frontend/CLAUDE.md` (one row).

- `monthGridDays(month, weekStartsOn)` returns 35 or 42 `YYYY-MM-DD` strings; pure string and integer arithmetic, no `Date` at the boundary (`docs/testing-contract.md`, dates: test the string through the function, never a pre-normalised `Date`).
- `classifyCalendarDay(date, today)` -> `'past' | 'today' | 'future'`; `today` is a required argument.
- `MonthGrid` per design section 10: `role="grid"`, rotated `common.weekdaysMin` headers, roving tabindex, arrow keys, `aria-current="date"`, phone cell variant. It renders whatever `renderDay` returns and knows nothing about money.
- `ViewModeToggle` copies `InvestmentViewToggle`'s segmented control (`aria-pressed`), labels `calendar.view.table` / `calendar.view.calendar`.
- `viewModeStore`: `{ surfaces: Record<ViewModeSurface, { view, layers }> }`, key `monize-view-mode`, `merge` discards junk, default `table` with the Transactions layer on. Reason line in the guard: authenticated only; which view and layers a screen shows, a fact about the screen, survives logout like density.

**Acceptance:** nothing renders the toggle yet (inert). `calendar-month.test.ts` covers every `weekStartsOn` 0..6 and the dates table (`2024-02-29`, `2100-02-28`, `2025-01-31`, `2025-12-31`). `MonthGrid.test.tsx` proves arrow-key navigation and that a 400px viewport does not overflow. `persisted-storage.guard.test.ts` green with the new entry and the pre-login footprint unchanged.

### B1 -- Rate index extraction + daily balance totals

**Files:** `backend/src/common/time-series/rate-index.util.ts` + `.spec.ts` (new, extracted from `NetWorthService.buildRateIndex` and `convertCurrency`), `backend/src/net-worth/net-worth.service.ts` (call the util; no behaviour change), `backend/src/accounts/daily-balance-totals.service.ts` + `.spec.ts` (new), `backend/src/accounts/dto/daily-balance-totals-query.dto.ts` + `.spec.ts` (new; `IsCalendarDate`, CSV UUIDs, `CALENDAR_RANGE_MAX_DAYS = 93`), `backend/src/accounts/accounts.controller.ts` (static route declared before the `:id` routes, `@AllowDelegate`, the joint-id widening `daily-balances` uses), `backend/src/accounts/accounts.module.ts`, `frontend/src/lib/accounts.ts` (`getDailyBalanceTotals`, cache key `accounts:daily-balance-totals:`), `frontend/src/types/account.ts` (`DailyBalanceTotalsResponse`), `docs/backend/transactions-and-money.md` (entry).

Implement design section 6.1. The extraction lands first as its own commit; the net-worth unit suite must pass without edits.

**Acceptance:** spec covers table A on a two-currency scope, the single-currency scope with `missingRatePairs` always empty, the projection withheld whole when one account's forecast is incomplete with `gaps` unioned, `today` echoed, and the DTO rejecting a 94-day range and `2100-02-29`. Example 1 and example 2 reproduce to the cent. Nothing calls the client function yet (inert). `cache-prefix-classification.guard.test.ts` green.

### B2 -- `investments-daily` completeness flags

**Files:** `backend/src/net-worth/net-worth.service.ts` (`getDailyInvestments`), `backend/src/net-worth/net-worth.service.spec.ts`, `frontend/src/types/net-worth.ts` (`DailyInvestmentValue` gains `pricesComplete`, `unpricedSecurityIds`), `docs/system-invariants.md` (INV-HOLDING-002 entry notes the flag).

Additive only: `value` is not changed (design 6.2). A held position whose `positionCloseAsOf` returns null sets `pricesComplete: false` and names the security.

**Acceptance:** a new spec case with one unpriced holding shows the flags and the unchanged `value`; every existing net-worth spec passes untouched (neutral). Frontend `type-check` green with no consumer change.

### B3 -- External flow extraction + daily movements

**Files:** `backend/src/securities/external-flow.util.ts` + `.spec.ts` (new, extracted from `PortfolioMovementAlertService.externalFlow`), `backend/src/notification-center/portfolio-movement-alert.service.ts` (call the util), `backend/src/securities/daily-movement.service.ts` + `.spec.ts` (new; `decide` is a pure exported function beside `decideMovement`'s pattern), `backend/src/securities/dto/daily-movements-query.dto.ts` + `.spec.ts` (new), `backend/src/securities/portfolio.controller.ts` (two routes, `@AllowDelegate` + `@DelegateRequiresSection("investments")`), `backend/src/securities/securities.module.ts`, `frontend/src/lib/investments.ts` (`getDailyMovements`, `getDailyMovementDetail`, key `investments:daily-movements:`), `frontend/src/types/investment.ts` (the response types), `docs/backend/securities-and-providers.md` (entry).

Implement design section 6.3. The trading-day query generalises `getFirstPricedDay`'s subquery to a date set; do not add a second replay: the detail endpoint reads quantities through the same `applyActionToQuantity` replay and closes through `positionCloseAsOf` (INV-HOLDING-002).

**Acceptance:** `decide` table test covers every row of truth table B; the service spec reproduces examples 3, 4, 5 and 6; the detail spec reproduces table D including `remainder` reconciling and `change: null` on a missing rate; `portfolio-movement-alert.service.spec.ts` passes untouched after the extraction (neutral). Nothing calls the client functions yet (inert).

### F2 -- Transactions page: calendar wiring and Transactions layer

**Files:** `frontend/src/app/transactions/page.tsx`, `frontend/src/hooks/useTransactionFilters.ts` (expose the filter signature the request key needs; no behaviour change), `frontend/src/lib/calendar-rows.ts` + `.test.ts` (new), `frontend/src/lib/scheduled-effective-amount.ts` (`occurrenceTouchesAccounts`) + `.test.ts`, `frontend/src/hooks/useCalendarMonthData.ts` + `.test.ts` (new), `frontend/src/components/calendar/CalendarToolbar.tsx`, `CalendarDayCell.tsx`, `CalendarDayPanel.tsx`, `CalendarBanner.tsx`, `TransactionsCalendarView.tsx` + tests (new), `frontend/src/components/transactions/TransactionForm.tsx` (`defaultDate`) + test, `frontend/src/i18n/messages/en/calendar.json`, `docs/frontend/financial-figures.md` (entry: calendar figures).

- The toggle sits in the `PageHeader` actions; `view === 'calendar'` swaps the register card and `ListBottomPager` for `TransactionsCalendarView` and hides the date-range selector; every other filter still reaches the request.
- Rows: `transactionsApi.getAllPages` for the grid's range with the page's filters; occurrences: `getOccurrences({ through: gridEnd })` filtered by `dueDate >= gridStart` and `occurrenceTouchesAccounts`. Over `CALENDAR_MAX_ROWS` the layer withholds with the notice (table C).
- Chips per table C; the day panel lists rows and occurrences with `usePayeeDisplay`, `CategoryPill`, `formatCurrency(amount, currencyCode)`; a row opens the page's `handleEdit`; an occurrence links to `/bills?highlight=`; "New transaction on this day" calls `openCreate` with `defaultDate`.
- `useCalendarMonthData` keys on month, scope, filter signature; the stale month stays on screen `aria-busy` and non-actionable; a failure renders the retryable error.

**Acceptance:** table-mode snapshot of the page unchanged (inert). Component tests cover every row of table C, the row cap, and the request-key matrix. `scheduled-effective-amount.guard.test.ts` green with no new exemption. `balance-cache.guard.test.ts` green. Grep `e2e/` for any control name touched (none should be renamed).

### F3 -- Transactions page: Balances layer

**Files:** `frontend/src/hooks/useDailyBalanceTotals.ts` + `.test.ts` (new), `frontend/src/components/calendar/TransactionsCalendarView.tsx`, `CalendarDayCell.tsx`, `CalendarDayPanel.tsx`, `CalendarBanner.tsx` + tests, `frontend/src/i18n/messages/en/calendar.json`.

Implement table A: the cell prints `total` through `balanceColor`, italic with the clock marker when `isProjected`; `null` prints the unknown marker; the panel prints the per-account rows, "Projected" with the occurrences that moved the day, the missing pairs or gaps with their fix; the banner composes every cause in the month. `knownSubtotal` appears only under a "partial" caption in the panel.

**Acceptance:** tests cover every row of table A; example 1 and example 2 render as described; a projected day is decided from `response.today` with the client clock mocked to a different day (I2); a request failure leaves the Transactions layer intact and the Balances layer in the error state.

### F4 -- Investments page: calendar wiring, Transactions and Values layers

**Files:** `frontend/src/app/investments/page.tsx`, `frontend/src/hooks/useInvestmentData.ts` (expose scope and `writeRefreshKey`; no behaviour change), `frontend/src/components/calendar/InvestmentCalendarView.tsx` + test (new), `frontend/src/lib/calendar-rows.ts` (`dedupeInvestmentLegs`, brokerage chip), `frontend/src/components/investments/InvestmentTransactionForm.tsx` (`defaultDate`) + test, `frontend/src/i18n/messages/en/calendar.json`.

- The toggle sits beside `InvestmentViewToggle`; calendar mode replaces both registers.
- Transactions layer: brokerage rows via `getAllTransactionPages`, cash rows via `getAllPages` for the linked cash sleeves, deduped per I5; brokerage chips read symbol, action label and total.
- Values layer: `netWorthApi.getInvestmentsDaily` for the grid range clamped to today; `pricesComplete === false` or `fxComplete === false` renders unknown with the security ids / pairs in the panel; days after today print nothing (decision 7).

**Acceptance:** table-mode snapshot unchanged (inert). I5 cases; example 6 renders unknown on every day; the Values layer stops at today with the client clock mocked ahead of the server's.

### F5 -- Investments page: Daily change layer and popup

**Files:** `frontend/src/hooks/useDailyMovements.ts` + `.test.ts` (new), `frontend/src/components/calendar/InvestmentCalendarView.tsx`, `CalendarDayCell.tsx`, `DailyMovementDialog.tsx` + tests (new), `frontend/src/i18n/messages/en/calendar.json`.

Implement table B and table D on the client: the cell reads `complete` and `reasons` only; the percentage through `formatPercent` and `gainLossColor`, neutral at exactly zero; blank and unknown never share markup; clicking the percentage opens `DailyMovementDialog` (`Modal`, read-only) with the gains, losses, unchanged count and the remainder line, sorted as the server sent them.

**Acceptance:** every row of table B and table D; example 3's popup sums to its headline; a Saturday is blank while an `unpricedHolding` day shows the marker; no arithmetic in the component (`calendar.guard.test.ts` from Q1 must stay green).

### F6 -- Phone, keyboard and screen reader

**Files:** `frontend/src/components/ui/MonthGrid.tsx`, `frontend/src/components/calendar/*.tsx` + tests.

Phone cell variant (dots and count), the day panel as `Modal` below `lg`, arrow-key and Home/End navigation, `aria-busy` while a month loads, `aria-current`, `aria-selected`, focus returned to the cell when the panel closes, `motion-reduce:transition-none` on every transition.

**Acceptance:** tests at 400px and 1280px; an axe run in the component tests reports no violations; the page body never scrolls horizontally.

### Q1 -- Guards

**Files:** `frontend/src/components/calendar/calendar.guard.test.ts` (new), `frontend/src/test/ui-conventions.test.ts` (new block), `docs/guard-tests.md` (if a new recipe is needed).

Per design I1 and I6 and section 11: no `.reduce(`/`+=` over an amount, balance, value or movement under `components/calendar/`; no recurrence walk; no colour literal outside the named maps; no `toISOString().slice`; completeness reads are `=== false` / `=== true`; one month grid, with `app/bills/page.tsx` and `UpcomingBillsReport.tsx` as a shrink-only baseline. Each block pairs "no offenders" with a self-check that the pattern still matches.

**Acceptance:** each guard fails on a planted offender in the test's own fixture and passes on the tree.

### Q2 -- Backend integration suite

**Files:** `backend/test/integration/calendar-read-models.integration.spec.ts` (new).

The three endpoints under RLS enforcement: an owner sees their scope; a delegate with the investments section sees the owner's investment scope and nothing else; a joint grantee sees the shared account's balances; a foreign account id in `accountIds` returns nothing and leaks nothing (404-vs-empty per the existing `daily-balances` behaviour).

**Acceptance:** `npm run build && npm run test:integration` green, one worker.

### Q3 -- Playwright

**Files:** `e2e/tests/calendar.spec.ts` (new), `e2e/helpers/factories.ts` (only if a factory is missing).

The journeys in design section 11's e2e row, seeded through the factories, one fresh user per test, persistence proved by reload. Selectors by role and label; a Saturday cell located by its `aria-label`.

**Acceptance:** `npm test -- tests/calendar.spec.ts` green locally against `docker-compose.e2e.yml`.

### Q4 -- Full-locale i18n pass

**Files:** `frontend/src/i18n/messages/*/calendar.json` (every locale), regenerated `xx`.

Translate every key added under `calendar` in one commit; `messages.parity.test.ts` and `npm run i18n:check` green.

### M1 -- Migrate the legacy grids (optional, separate proposal)

**Files:** `frontend/src/app/bills/page.tsx`, `frontend/src/components/reports/UpcomingBillsReport.tsx`, `frontend/src/test/ui-conventions.test.ts` (baseline shrinks to empty), `frontend/src/lib/scheduled-effective-amount.guard.test.ts` (the bills-calendar exemption goes when the page reads `getOccurrences`), `frontend/src/i18n/messages/*/bills.json` (`calendar.days.*` retired in favour of `common.weekdaysMin`).

Both grids render through `MonthGrid` and honour `weekStartsOn`. The bills calendar switches from its browser-side recurrence walk to `getOccurrences`, which is what lets its guard exemption go. Behaviour otherwise unchanged; `bills.spec.ts` and `bills-filter.spec.ts` are the gate.

### R1 -- Report, do not build

`getDailyInvestments` returns a subtotal as `value` on an unpriced day (design 6.2). After B2 ships the flags, file the contract violation with the maintainer as its own proposal naming the four consumers (`InvestmentValueChart`, `PortfolioValueReport`, `PortfolioValueWidget`, `portfolio-change-baseline.ts`); this plan does not change `value`.
