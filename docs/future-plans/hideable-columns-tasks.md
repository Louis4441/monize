# Hideable Table Columns: Agent Task List

> Companion to [`hideable-columns.md`](./hideable-columns.md) (the plan, which carries the decisions, the data contract and the truth table). This file breaks the work into tasks sized for one AI-agent session each. Do the tasks in dependency order; never start a task whose dependencies are unmerged. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a scope violation -- stop and leave a note on the task's issue instead.
- **The plan is the authority on every contract.** The hideable sets are plan section 3, decision 3; the wire shape and validation are section 5; every derived figure (`colSpan`, `colCount`, the phone grid, the sort fallback) is section 6. If the code and the plan disagree, the plan is changed first, in its own commit, with the reason.
- **Two rules apply to every table task:** hidden means absent from the DOM, never a visibility class (decision 4); and with a stored `{}` the rendered DOM is byte-identical to today, which the existing suites pin.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `npm run test:changed`.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:changed`, `npm run build`.
  - `docs/`: `node scripts/check-docs-manifests.mjs` and, in `backend/`, `npm run test:unit -- doc-paths instruction-files`.
  - Stage new files before running a guard (`git add -N` is enough).
  - New user-facing strings: English catalogs only, then `npm run i18n:pseudo`. The full-locale pass is Q.
  - The doc line each task names lands in the same PR.
- **Terminology:** "the plan" = `hideable-columns.md`; "the register" = `TransactionList` + `TransactionRow`; "the holdings table" = `GroupedHoldingsList`; "the brokerage register" = `InvestmentTransactionList`; "the menu" = `ColumnChooserMenu`; "the hook" = `useHiddenColumns`. Section references point at the plan. Re-locate code by symbol, never by line.

## Deployment safety

| Class | Meaning |
| --- | --- |
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Ships a column or an accepted field that changes nothing until a client sends it. |
| **neutral** | Rewrites a live render path. Behaviour-preserving with the default `{}`; the touched component's suites and DOM pins are the gate. |

B1 is the only migration: an expand-only column with a default, safe under a rolling deployment. No task is "change": a deployment with no stored hidden columns renders every table as today.

## Task graph

| ID | Issue | Task | Depends on | Deploy class | Status | PR |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | #1701 | Migration, `schema.sql`, entity column, support-backup rule | -- | inert | [x] | #1712 |
| F1 | #1702 | `lib/hidden-columns.ts`, the frontend types, the hook; nothing mounted | B1 | none | [x] | #1715 |
| B2 | #1703 | Backend id constant, validator, DTO field, service block, contract spec against F1's file | B1, F1 | inert | [x] | #1717 |
| F2 | #1704 | The menu, the header sheet hook, the `hide` glyph, `SortableHeader.pressHandlers`, the shared toolbar-button class, `common.columns.*` strings; nothing mounted | F1 | none | [x] | #1720 |
| F3 | #1705 | The register: headers, cells, `colCount`, chip strip, the phone card, the sort fallback, the guard cases, the doc section | B2, F2 | neutral | [x] | #1721 |
| F4 | #1706 | The holdings table: headers, three row kinds, the account-total `colSpan`, the phone-grid helper | B2, F2 | neutral | [x] | #1724 |
| F5 | #1707 | The brokerage register: headers, cells, `colCount`, the empty row, the card body | B2, F2 | neutral | [x] | #1725 |
| F6 | #1708 | E2E: hide through the menu, reload, restore | F3 | none | [x] | #1726 |
| Q | #1709 | Acceptance: every locale, release note, tracker closed, plan status | F3, F4, F5, F6 | none | [x] | (this PR) |

**Why B2 waits for F1:** the contract spec reads `frontend/src/lib/hidden-columns.ts` by path and the parity it pins is the point of the task; filed against a missing file it would only prove the file is missing.

**Why F2 is separate from F3:** the menu and the header sheet are tested once, in isolation, and F4 and F5 then proceed in parallel on them.

**Why F3 to F5 are neutral, not none:** each rewrites a live table's render path. The gate is the component's existing suite plus its DOM pins staying green with no baseline edit.

---

## Task details

### B1 -- The column

**Files:** `database/migrations/<UTC timestamp>_user_preferences_hidden_table_columns.sql` (new; `touch "database/migrations/$(date -u +%Y%m%d%H%M%S)_user_preferences_hidden_table_columns.sql"`), `database/schema.sql`, `backend/src/users/entities/user-preference.entity.ts`, `backend/src/backup/support-backup/support-backup-rules.ts`.

- The migration: a header comment, then `ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS hidden_table_columns JSONB NOT NULL DEFAULT '{}';`, the shape of `090_user_preferences_dashboard_widget_config.sql`. `schema.sql` gains the same column beside `dashboard_widget_config` in the same commit, with a trailing comment naming the three keys.
- The entity: a `jsonb` column `hiddenTableColumns`, typed as `dashboardWidgetConfig` is and with its comment (a loose record so `DeepPartial` still works).
- The support-backup rule: `hidden_table_columns: keep` (column ids, no personal data). The golden in `backend/test/integration/support-backup.integration.spec.ts` fails until the line exists.
- Acceptance: `npm run migration:lint:test && npm run migration:lint`; `scripts/verify-schema.sh` and `node scripts/check-migration-prefixes.mjs` from the repository root; `npm run build && npm run test:integration` (entity and migration changed; the support-backup golden).

### F1 -- The pure module, the types, the hook

**Files:** `frontend/src/lib/hidden-columns.ts` and `frontend/src/lib/hidden-columns.test.ts` (new), `frontend/src/hooks/useHiddenColumns.ts` and `frontend/src/hooks/useHiddenColumns.test.tsx` (new), `frontend/src/types/auth.ts`, the test fixtures that build a full `UserPreferences` (`frontend/src/components/auth/ProtectedRoute.test.tsx`, `frontend/src/components/settings/PreferencesSection.test.tsx`, `frontend/src/components/settings/SecuritySection.test.tsx`, `frontend/src/components/settings/NotificationsSection.test.tsx`, `frontend/src/components/transactions/RecentTransactionsPopover.test.tsx`; grep `recentTransactionsLimit:` for any other).

- `hidden-columns.ts` exactly as plan section 7: `HIDDEN_COLUMN_TABLES`, `HIDEABLE_COLUMNS` as an `as const` object literal of quoted ids (B2's contract spec parses that shape), the three types, `hiddenColumnsFor` (drops unknown ids, tolerates `undefined`, never throws), `visibleColumns` (order preserved), `withHiddenColumns` (dedupes and canonicalises to the kind's order). The type-level pin that `HIDEABLE_COLUMNS.transactions[number]` extends `RegisterColumnId`; a type-only import of `register-columns.ts` is acceptable, and if lint objects the constant moves into `register-columns.ts` and is re-exported.
- `types/auth.ts`: `hiddenTableColumns` on `UserPreferences` (required, the wire type) and `UpdatePreferencesData` (optional).
- The hook copies `frontend/src/hooks/useWidgetConfig.ts` in shape: read with a store selector on the kind's entry; memoise the set on that reference; write by reading `usePreferencesStore.getState()` fresh, optimistic `updatePreferences({ hiddenTableColumns })`, `userSettingsApi.updatePreferences` with the whole map, adopt the saved map, revert to the pre-edit map and `toast.error` on failure (`common.columns.saveFailed` is F2's string; this task uses the key and F2 lands the catalog line, or this task lands the one line itself). `isVisible` is a stable `useCallback`, true for anything not hideable.
- Acceptance: `hidden-columns.test.ts` covers unknown ids dropped, `undefined` tolerated, order kept, duplicates removed, the table keys equal to `HIDDEN_COLUMN_TABLES`; the hook test (model `useWidgetConfig.test.tsx`) covers the optimistic update, the payload being the whole map, adoption of the response, revert and toast on failure, `isVisible` on a structural id.

### B2 -- The boundary

**Files:** `backend/src/users/hidden-table-columns.ts` (new), `backend/src/users/validators/is-hidden-table-columns.validator.ts` and its spec (new), `backend/src/users/dto/update-preferences.dto.ts` and `backend/src/users/dto/update-preferences.dto.spec.ts`, `backend/src/users/users.service.ts` and `backend/src/users/users.service.spec.ts`, `backend/src/users/hidden-table-columns.contract.spec.ts` (new).

- `hidden-table-columns.ts`: `HIDDEN_COLUMN_TABLES` and `HIDEABLE_TABLE_COLUMNS` with contents identical to F1's literal, and the kind type.
- The validator per plan section 5, modelled on `is-dashboard-widget-config.validator.ts`: `undefined` and `null` pass; an array or a non-object fails; every key in `HIDDEN_COLUMN_TABLES`; every value an array of strings each in that kind's list, no duplicates, length at most the list's length; `defaultMessage` names the field. Refuse, never drop (decision 6).
- The DTO: `@ApiPropertyOptional` with the section 5 example, `@IsOptional() @IsObject()` and the new decorator; the DTO spec gains accepted cases (`{}`, each kind with its full list, omitted) and refused cases (unknown kind, unknown id, duplicate, non-array value, array top level, `__proto__` key, and an unknown field still refused).
- The service: the `if (dto.hiddenTableColumns !== undefined)` patch block beside `dashboardWidgetConfig`'s, with the same cast; an explicit case in the service spec (the `it.each` table casts through `any`, so the explicit case documents the cast).
- The contract spec in the shape of `backend/src/transactions/register-sort.contract.spec.ts`: read the frontend file, assert the `HIDEABLE_COLUMNS = { ... } as const` match is non-null first, parse the `key: [...]` entries, assert the keys and each list equal the backend constant in order.
- Acceptance: the four specs; `TZ=UTC npm run test:unit -- users` green; the array-bound guard untouched (the bounds live in the validator).

### F2 -- The menu, the header sheet, the strings

**Files:** `frontend/src/components/ui/ColumnChooserMenu.tsx` and its test (new), `frontend/src/hooks/useColumnHeaderActions.tsx` and its test (new), `frontend/src/components/ui/row-actions/ActionIcon.tsx` and `frontend/src/components/ui/row-actions/rowAction.ts` (the `hide` glyph), `frontend/src/components/ui/SortableHeader.tsx` and its test, `frontend/src/components/ui/ListTopToolbar.tsx` (the exported toolbar-button class), `frontend/src/i18n/messages/en/common.json` (`common.columns.*`: button, menuLabel, showAll, hideColumn, sheetSubtitle, saveFailed; grep each key first), then `npm run i18n:pseudo`.

- The menu per plan section 7: trigger with `aria-haspopup="menu"` and `aria-expanded`, the toolbar-button class, a count badge (a plain `tabular-nums` span or `Badge`, never a hand-rolled pill) when anything is hidden; `role="menu"` with one `role="menuitemcheckbox"` and `aria-checked` per column; toggling keeps the menu open; "Show all" last, disabled when nothing is hidden; Escape and click-outside through `useClickOutside` as `ActionMenu` does, focus returned to the trigger. No fingerprint the `ui-conventions.test.ts` baselines ban (the divide pair, a bare `focus:` ring, a transition without `motion-reduce:transition-none`).
- `useColumnHeaderActions` per plan section 7: `useLongPress` over the hideable ids, one `RowActionSheet` titled with the column's label and one action "Hide column" with the `hide` glyph; `headerHandlers(id)` undefined for a structural id. `SortableHeader.pressHandlers`: when present, spread them and drop the header's own `onClick`; keep `onKeyDown`.
- Nothing mounts any of it in this task.
- Acceptance: the menu test (checkbox roles and states, stays open on toggle, Show all disabled when nothing hidden, Escape closes and refocuses, click-outside closes, the badge); the header test (`contextmenu` on a hideable header opens the sheet with the label, "Hide column" calls `onHide`, a plain click still reaches `onHeaderClick`, a structural id gets `undefined`); the `SortableHeader` test (with `pressHandlers` a click reaches `onSort` once, keyboard sort unchanged); `npm run i18n:check`.

### F3 -- The register

**Files:** `frontend/src/components/transactions/TransactionList.tsx`, `frontend/src/components/transactions/TransactionRow.tsx`, `frontend/src/components/transactions/register-columns.guard.test.ts`, `frontend/src/components/transactions/TransactionList.test.tsx`, `frontend/src/components/transactions/TransactionList.mobileWrapped.test.tsx`, `frontend/src/components/transactions/TransactionRow.test.tsx`, `frontend/src/lib/transaction-sort.ts` and `frontend/src/lib/transaction-sort.test.ts`, the Transactions page (route /transactions) and its test, `docs/frontend/tables-and-registers.md` (a section under the column contract), `frontend/CLAUDE.md` (one Need/Use row: hiding a column is the hook and the menu, never a class or a local state).

- `TransactionList`: the hook for `transactions`; `useColumnHeaderActions` with the five labels, `onHide` the hook's `hide`, `onHeaderClick` the sort callback; the sheet rendered beside the row action sheet. Each hideable header wrapped in `isVisible('<id>') && (` with `pressHandlers` from `headerHandlers('<id>')` (`RegisterHeader` forwards it on both branches); every `registerColumnClass('<id>')` literal stays in place and in order; the `{!isSingleAccountView && (` literal untouched. `colCount` subtracts the hidden count; `sortChipFields` filters hidden fields; the menu first in the toolbar's `actions`; the row receives the `hidden` set as a prop.
- `TransactionRow`: the prop; each hideable tier cell wrapped the same way, the Description cell keeping `REGISTER_DESCRIPTION_CELL_FLEX` on its line; the phone card gates the status pill, the attachment badge and the tags line.
- `resolveRegisterSort(sort, isSingleAccountView, hidden)`: a usable sort whose field is hidden falls back to the default, storage untouched (decision 8), with the Account rule's comment extended. The page passes the hook's set.
- The guard cases per plan section 8.
- Measure the Description-hidden layout at 1536 and 1920 before merging (plan section 13) and note the result on the PR.
- Acceptance: with the store seeded `{ transactions: ['status'] }` no Status `columnheader`, no status cell, the today-divider `colSpan` one less, the chip strip without Status, the card without the pill; `tags` hidden removes the card's third line; the sort fallback case; the guard's new cases fail on a hideable cell left ungated and on a structural cell gated; every existing register suite green with no baseline edit; `e2e/tests/transactions.spec.ts` still finds Balance, Date and Payee by role.

### F4 -- The holdings table

**Files:** `frontend/src/components/investments/GroupedHoldingsList.tsx` and `frontend/src/components/investments/GroupedHoldingsList.test.tsx`, `frontend/src/lib/holdings-phone-grid.ts` and `frontend/src/lib/holdings-phone-grid.test.ts` (new).

- The hook for `investmentHoldings`; the header sheet with the seven labels and no `onHeaderClick`; the menu at the right of the title and summary block (`flex items-start justify-between gap-3 flex-wrap`); the sheet once at the component root.
- The seven `<th>` gated and carrying `headerHandlers`; the figure cells of the holding row, the cash row and the account-total row gated; the account-total label `colSpan` per plan section 6; the holding row takes the set and a placement record as props.
- `holdingsPhonePlacement(hidden)` per plan section 6 with every reachable class a literal in the file (Tailwind must see complete class names); the three row kinds read it.
- Acceptance: the phone-grid test pins the all-visible output to today's literal classes and covers three hidden cases; the component test covers a hidden `avgCost` (no caption, header or cell; account-total `colSpan` 3), everything hidden (Symbol alone, label `colSpan` 1), and the existing captions and FX cases green unchanged; `InvestmentDetailView.test.tsx` green.

### F5 -- The brokerage register

**Files:** `frontend/src/components/investments/InvestmentTransactionList.tsx`, `frontend/src/components/investments/InvestmentTransactionListParts.tsx`, `frontend/src/components/investments/InvestmentTransactionList.test.tsx`, `frontend/src/components/investments/InvestmentTransactionList.mobileWrapped.test.tsx`.

- The hook for `investmentRegister`; the header sheet with the three labels; the three headers and cells gated (the viewport visibility classes stay, decision 10); `colCount` subtracts the hidden count and the empty row reads `colCount` in place of its literal (both mount surfaces pass edit and delete, so the default is unchanged; replace the literal's comment with that reason); the menu in `ListTopToolbar`'s `actions` and before the density toggle in the branch that does not own paging; the card body takes the set and omits line 2 when Shares and Price are both hidden, the status button when Status is.
- Acceptance: a hidden `status` removes the header, the cell and the card's status button; hidden shares and price remove the card's second line; the empty row's `colSpan` equals `colCount`; the mobile-wrapped suite and the DOM pins green with no edit; `InvestmentRegisterPanel.test.tsx` and the Investments page test green.

### F6 -- End to end

**Files:** `e2e/tests/transactions.spec.ts`.

- One case: open "Columns" by role, uncheck Status by its `menuitemcheckbox` name, assert the Status `columnheader` absent, reload, assert still absent, re-check, assert present. A fresh user per test needs no cleanup.
- Grep `e2e/` for every accessible name F2 and F3 introduced; the spec must match them.
- Acceptance: the spec green against `docker-compose.e2e.yml`.

### Q -- Acceptance

**Files:** every locale's `common.json` under `frontend/src/i18n/messages/`, `docs/release-notes/` (one entry), `docs/future-plans/hideable-columns.md` (status line and section 14), the tracking issue.

- Translate `common.columns.*` into every locale; `npm run i18n:pseudo`; `messages.parity.test.ts` green.
- The release note names the three tables, the two ways to hide and the one way to restore, and that the choice follows the account.
- The plan's status line becomes done; section 14 records each answer; the tracker's task table carries every PR; the tracker is closed.
