# Hideable table columns

Design for letting a user hide the inessential columns of the transaction
register, the holdings table and the brokerage register, as a preference
stored on the account. Proposed in Discussion #1686 for the register alone;
widened here to the two Investments tables, which hard-code their columns
today. The task list is
[`hideable-columns-tasks.md`](./hideable-columns-tasks.md).

Status: **approved-to-build**; decisions agreed in the planning session of
2026-10-12 and recorded on the tracking issue #1700. Each task is a sub-issue
(#1701 to #1709), one PR each.

## 1. Goal

- A reader who never uses Ref #, Tags or Attachments can turn them off, on
  the register they spend the most time on, and the choice follows them to
  every device because it is about their data, not their screen.
- The same control exists on the two Investments tables, with the same
  mechanics, the same menu and the same stored shape.
- Nothing structural can be hidden. A register still says what happened,
  to whom, for how much and where; a holdings row still says which security.
- The existing width tiers keep deciding when a column that is *shown* fits
  (`frontend/src/components/transactions/register-columns.ts`), so a phone
  never ends up with an unusable table; hiding only removes a column.
- Sorting is untouched, as the Discussion said. One rule is added for a
  remembered sort on a column that is now hidden (decision 8).

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
| --- | --- | --- |
| The register's column contract | `frontend/src/components/transactions/register-columns.ts`: `REGISTER_COLUMN_ORDER`, `REGISTER_COLUMN_PRIORITY`, `registerColumnClass`; the guard `frontend/src/components/transactions/register-columns.guard.test.ts` | Order and width tiers stay the one contract. The guard reads the two register files in source order, so every `registerColumnClass('x')` literal stays where it is and hiding is a wrapper around the cell, never a class. |
| The register's two files | `frontend/src/components/transactions/TransactionList.tsx` (header, `colCount`, the toolbar, the phone sort-chip strip), `frontend/src/components/transactions/TransactionRow.tsx` (tier cells, the phone card) | Mounted from eight surfaces; all of them follow the one stored set. |
| The holdings table | `frontend/src/components/investments/GroupedHoldingsList.tsx` | Eight hard-coded `<th>`; three row kinds (holding, cash, account total) repeat the eight positions; the phone grid places every cell with literal `col-start` / `row-start` classes; the account-total label is `colSpan={4}`. Mounted by the Investments page (route /investments) and `frontend/src/components/accounts/investment-detail/InvestmentDetailView.tsx`. |
| The brokerage register | `frontend/src/components/investments/InvestmentTransactionList.tsx`, `frontend/src/components/investments/InvestmentTransactionListParts.tsx` (the phone card body) | Nine hard-coded columns with viewport visibility classes (outside the register guard's scope); `colCount` for the today divider and a literal `colSpan` on the empty row. Mounted by the Investments page and `frontend/src/components/investments/InvestmentRegisterPanel.tsx`. |
| A cross-device display preference | `dashboard_widget_config` (JSONB) and `frontend/src/hooks/useWidgetConfig.ts` | The write pattern copied in full: optimistic store update, `userSettingsApi.updatePreferences`, adopt the response, revert with a toast on failure. |
| The preference row end to end | `backend/src/users/entities/user-preference.entity.ts`, `backend/src/users/dto/update-preferences.dto.ts`, `backend/src/users/users.service.ts` (`updatePreferences` writes one patch block per field), `backend/src/users/validators/is-dashboard-widget-config.validator.ts`, `backend/src/backup/support-backup/support-backup-rules.ts`, `frontend/src/types/auth.ts`, `frontend/src/store/preferencesStore.ts` | The map-valued-preference precedent; the validator is the model for the new one. |
| The list toolbar | `frontend/src/components/ui/ListTopToolbar.tsx` (`actions` slot) | Both registers compose it; the menu goes in `actions`. The holdings table has no toolbar, so its header block takes the menu. |
| The press-and-hold sheet | `frontend/src/hooks/useLongPress.ts`, `frontend/src/components/ui/row-actions/RowActionSheet.tsx` | Every row opens it by long-press or right-click; a column header does the same. |
| A sortable header | `frontend/src/components/ui/SortableHeader.tsx`, `RegisterHeader` in `TransactionList.tsx` | Owns its own `onClick`; gains a prop so the long-press handlers can take the click over without a second sort firing. |
| A two-layer list pinned equal | `backend/src/transactions/register-sort.contract.spec.ts` | The model for pinning the hideable-column ids equal across packages that cannot import each other. |
| The sort fallback precedent | `resolveRegisterSort` (`frontend/src/lib/transaction-sort.ts`) | A remembered sort on the Account column falls back to the date sort on a single-account view, storage untouched. The hidden-column rule is the same shape. |

## 3. Decisions

1. **Stored on the account, in one JSONB column keyed by table kind.**
   `user_preferences.hidden_table_columns JSONB NOT NULL DEFAULT '{}'`, keys
   `transactions`, `investmentHoldings`, `investmentRegister`, each a list
   of that table's hideable column ids. Rejected: a `TEXT[]` per table (the
   Discussion's sketch), because the third table would be the third
   migration. Rejected: browser-local storage like density, because the
   Discussion's case is "how you like your data, not your screen", and
   `dashboard_widget_config` is the precedent for that class.
2. **One set per table kind, read everywhere that table is mounted.** The
   register's eight surfaces, the holdings table's two and the brokerage
   register's two each follow the one set. Rejected: a set per page, which
   makes the same register look different on the account page from the
   Transactions page.
3. **The hideable sets are these and no others.** Register: description,
   refNumber, tags, attachments, status. Holdings: shares, avgCost, price,
   costBasis, mktValue, gainLoss, portfolioPercent. Brokerage register:
   shares, price, status. Category is structural on the register by the
   maintainer's call: its cell carries the transfer arrow, the split marker
   and the linked-investment pill, so hiding it would hide what a row *is*.
   Date, payee, amount, account, balance, actions and the three FX columns
   are structural as the Discussion said; symbol, date, action, total and
   actions likewise on the Investments tables.
4. **Hidden means absent at every width, the phone card included.** The
   cell is not rendered; nothing is hidden by class. The width tiers,
   density and the Account rule go on deciding what is left exactly as
   today, and density still never changes which columns exist.
5. **Two ways to hide, one way to restore.** A "Columns" checkbox menu in
   the list's toolbar (every hideable column, checked when shown, plus
   "Show all"), and a long-press or right-click on a hideable column header
   opening the shared action sheet with "Hide column". Restoring is through
   the menu, which also carries a count of hidden columns so a reader who
   hid Status can see where it went. Rejected: a hover glyph on each header
   (chrome on every header, nothing on a phone) and a Settings-page
   section (far from the table; may come later as a bulk restore).
6. **An unknown table key or column id is refused (400), never dropped.**
   The only writer is this repository's client, the boundary rule is
   `forbidNonWhitelisted`, and `default_map_provider` already refuses an
   unknown value. A silent drop would make a column reappear with no toast
   and nothing in the log. The one honest case for an unknown id, a newer
   client against an older server during a rollout, gets the toast and the
   revert. On the read side the client drops ids *it* does not know (an
   older client against a newer row) rather than failing to render.
7. **The ids are one list, declared in two layers and pinned equal.**
   `frontend/src/lib/hidden-columns.ts` holds `HIDEABLE_COLUMNS`; the
   backend holds the same literal beside its validator; a contract spec in
   the shape of `register-sort.contract.spec.ts` reads the frontend file and
   fails on any difference in keys, ids or order.
8. **A remembered sort on a now-hidden column falls back to the date sort,
   storage untouched.** The Account rule in `resolveRegisterSort` already
   chose this for the same shape; keeping the sort would leave the register
   ordered by a header nobody can see, with the running balance withheld
   and no control to change it back. Unhiding restores the remembered sort
   on the next render. The phone sort-chip strip omits a hidden column's
   chip the way it omits the Account chip.
9. **Hiding everything hideable is allowed.** The register keeps date,
   payee, category, amount, account or balance, and actions; the holdings
   table keeps Symbol, with the account header still carrying the totals.
   "Show all" is the way back. Rejected: a minimum of one, which has no
   rationale a reader would recognise.
10. **The brokerage register keeps its viewport visibility classes.**
    Converting it to the register's container tiers is a separate proposal;
    this plan only wraps its cells.
11. **The stored map is persisted in demo mode and read under delegation
    as every other display preference is**: a delegate acting for an owner
    sees the owner's hidden set.

## 4. Definitions

- **Table kind**: one of `transactions`, `investmentHoldings`,
  `investmentRegister`. A table kind is a component, not a route.
- **Hideable column**: an id in that kind's list (decision 3). **Structural
  column**: every other column the component draws.
- **Hidden set**: the stored list for a kind, read as a set after the ids
  this build does not know are dropped.
- **Visible**: a column is visible when it is structural, or hideable and
  not in the hidden set. The width tiers then decide whether a visible
  column *fits*; a hidden column is never asked.

## 5. Data contract

Wire shape, both directions, on `GET` and `PATCH /users/preferences`:

```json
{
  "hiddenTableColumns": {
    "transactions": ["refNumber", "attachments"],
    "investmentHoldings": [],
    "investmentRegister": ["status"]
  }
}
```

- Every key is optional; an older row lacks keys and reads as nothing
  hidden. `{}` is the default and the shape of a fresh row.
- Validation (`IsHiddenTableColumns`, modelled on
  `is-dashboard-widget-config.validator.ts`): an object, never an array;
  every key one of the three kinds (which also excludes `__proto__`,
  `constructor` and `prototype`); every value an array of strings each in
  that kind's list, no duplicates, length bounded by the list's length.
  Anything else is a 400 naming the field.
- The client always sends the whole map (as `useWidgetConfig` does), with
  each list deduplicated and in the kind's canonical order, so a duplicate
  cannot leave the client.
- Support backup: `hidden_table_columns` is `keep` (column ids, no personal
  data). Full backup and restore need no change (`SELECT *`; JSONB restored
  generically).
- No MCP tool, assistant tool or report reads the column.

## 6. Behaviour, as a truth table

| Stored for the kind | Column | Width tier says | Rendered |
| --- | --- | --- | --- |
| anything | structural | fits | yes |
| anything | structural | does not fit | no (tier class, as today) |
| not listed | hideable | fits | yes |
| not listed | hideable | does not fit | no (tier class, as today) |
| listed | hideable | fits | no: the cell is absent from the DOM |
| listed | hideable | does not fit | no |
| listed, but this build does not know the id | -- | -- | ignored; the column it would name is treated as not listed |
| listed | structural (impossible by validation) | -- | refused at the boundary; never reaches a render |

Derived figures that follow a hidden column:

| Site | With nothing hidden | With `n` hideable columns hidden |
| --- | --- | --- |
| Register today-divider `colSpan` (`colCount` in `TransactionList.tsx`) | as today | today's figure minus `n` |
| Register phone sort-chip strip | every sortable field but Account on a single-account view | the same, minus hidden fields |
| Register remembered sort on a hidden field | n/a | date sort, storage untouched |
| Holdings account-total label `colSpan` | 4 | 1 + the visible count of shares, avgCost, price |
| Holdings phone grid | the literal placements in the file today | row 1 Symbol + mktValue; row 2 packs the visible of shares, avgCost, price, portfolioPercent from column 1; row 3 packs the visible of costBasis, gainLoss; every rendered cell keeps an explicit position; an empty row does not exist |
| Brokerage `colCount`, the empty-row `colSpan` | 9 on both mount surfaces | `colCount` minus `n`, and the empty row reads `colCount` instead of its literal |
| Brokerage phone card line 2 (Shares, Price) | both | the visible one, or the line omitted when both are hidden |

## 7. Frontend structure

New, shared:

- `frontend/src/lib/hidden-columns.ts` (pure): `HIDDEN_COLUMN_TABLES`,
  `HIDEABLE_COLUMNS` (`as const`), the `HiddenColumnTable`,
  `HideableColumn<T>` and `HiddenTableColumns` types, `hiddenColumnsFor`,
  `visibleColumns`, `withHiddenColumns`. A type-level pin that the
  register's hideable ids are `RegisterColumnId`s.
- `frontend/src/hooks/useHiddenColumns.ts`: `useHiddenColumns(table)`
  returning `hidden`, `isVisible`, `hide`, `show`, `showAll`, `hideable`.
  `isVisible` is a stable callback; a memoised row takes the `hidden` set as
  a prop. The write is `useWidgetConfig`'s, field for field.
- `frontend/src/components/ui/ColumnChooserMenu.tsx`: a toolbar-sized
  trigger with a count badge, a `role="menu"` of `menuitemcheckbox` rows
  that stay open on toggle, "Show all" last, Escape and click-outside
  through `useClickOutside` as `ActionMenu` does. The export button's class
  string in `TransactionList.tsx` becomes an exported constant on
  `ListTopToolbar.tsx` so the two buttons share it.
- `frontend/src/hooks/useColumnHeaderActions.tsx`: `useLongPress` over the
  hideable ids and one `RowActionSheet` with "Hide column"; returns
  `headerHandlers(id)` (undefined for a structural id, so a call site can
  spread it unconditionally) and the `sheet` node. `SortableHeader` gains
  `pressHandlers`: when present the header spreads them and drops its own
  `onClick`, keeping its keyboard activation.
- `common.columns.*` strings in the `common` catalog.

Per table:

- Register: each hideable header and cell wrapped in
  `isVisible('<id>') && (`; `registerColumnClass('<id>')` literals and the
  `{!isSingleAccountView && (` literal untouched; `colCount` and the chip
  strip per section 6; the menu first in the toolbar's `actions`;
  `TransactionRow` takes the set as a prop and gates the card's status
  pill, attachment badge and tags line (description and ref # are not on
  the card). `resolveRegisterSort` takes the hidden set from the
  Transactions page, which already owns sort resolution.
- Holdings: the menu at the right of the title and summary block; the seven
  headers and the figure cells of all three row kinds gated; the phone
  placement from a pure helper (`frontend/src/lib/holdings-phone-grid.ts`)
  whose every reachable class is a literal, with a test pinning the
  all-visible output to today's classes.
- Brokerage register: the three headers and cells gated; `colCount` and the
  empty row per section 6; the menu in `ListTopToolbar`'s `actions` and in
  the branch that does not own paging; the card body takes the set.

## 8. Where each rule is held

| Rule | Held by |
| --- | --- |
| The hideable ids are the same list in both layers | the contract spec (decision 7) |
| An unknown key or id never reaches the row | `IsHiddenTableColumns` and the DTO spec |
| The register's hideable set is a subset of its column order, disjoint from the structural ids, in order | `register-columns.guard.test.ts`, new cases |
| Both register files gate exactly the hideable ids and nothing structural | `register-columns.guard.test.ts`: `isVisible('<id>') &&` present for each hideable id, absent for each structural id, in both files |
| One read per list, the row takes a prop | `register-columns.guard.test.ts`: the list calls `useHiddenColumns('transactions')`, the row does not |
| The default renders every table as today | the existing DOM pins: the brokerage mobile-wrapped suite, the tier tests, the holdings captions; the phone-grid test's all-visible case |
| The client never sends a duplicate | `hidden-columns.test.ts` on `withHiddenColumns` |
| A failed write reverts and tells the reader | `useHiddenColumns.test.tsx` |
| A hidden sort field falls back | `transaction-sort.test.ts` |
| The preference survives a reload | the E2E case in `e2e/tests/transactions.spec.ts` |

## 9. Order of work

B1 (column) before anything reads it; F1 (the pure module, the types, the
hook) before B2, whose contract spec reads F1's file; F2 (the shared menu,
the header sheet, the strings) before any table; F3, F4 and F5 in parallel
after B2 and F2; F6 after F3; Q last. Deploy classes are in the task list.
No task changes what a deployment does by default: a stored `{}` renders
every table as today.

## 10. What a reader sees

- A "Columns" button in the register's toolbar and the brokerage register's
  toolbar, and at the right of the holdings heading. With something hidden
  it carries the count.
- The menu lists each hideable column by its header label, checked when
  shown; a click toggles and the menu stays open; "Show all" is last.
- A long-press or right-click on a hideable header opens the sheet titled
  with the column's label and one action, "Hide column"; on a structural
  header nothing happens.
- A failed save puts the column back and shows the shared error toast.
- Hiding Status on the brokerage register removes that row's status-cycle
  control; hiding Attachments removes the badge (the form still shows
  them). Both are named here so nobody files them as defects.

## 11. Scope cuts

- Reordering columns (the Discussion said "could come later").
- A Settings-page section (decision 5).
- Converting the brokerage register to container tiers (decision 10).
- Per-page sets, or a set for the reconcile table, the scheduled list or any
  report table.
- Any change to sorting beyond decision 8.

## 12. Assumptions, restated for a fresh session

- `GET /users/preferences` returns the entity, so a new JSONB column reaches
  the client with no serializer change; `UserPreferencePatch` is
  `Partial<UserPreference>`, so the service block carries the same cast as
  `dashboardWidgetConfig`.
- Both brokerage mount surfaces pass `onPageChange`, so `ListTopToolbar`
  renders on both and the empty row's `colSpan` can read `colCount`.
- The array-bound DTO guard sweeps `@IsArray()` only; the bounds for this
  field live in its validator.
- No E2E spec names a hideable column's header by role; the three it names
  (Balance, Date, Payee) are structural.
- The register guard reads `registerColumnClass('x')` with a quoted literal
  and the cell-order from the file; a wrapper around the cell keeps both.
- Locales: English first in each task, `npm run i18n:pseudo` after editing
  `en/*`; the full-locale pass is Q.

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Description is the column that yields width; with it hidden at 1536px and above, nothing yields and the auto-layout table spreads the leftover in proportion to content, while `REGISTER_PAYEE_PRIORITY_SHARE` was tuned beside a Description | This is the state the register already renders below 1536px, so no new CSS state exists; F3 measures at 1536 and 1920, Compact, Account column showing, a 60-character payee, before merging; a fix, if one is needed, is a container variant keyed on a wrapper attribute, never a class in the row |
| A long-press on a sortable header both opens the sheet and flips the sort | `SortableHeader` drops its own `onClick` when `pressHandlers` is present; its unit test holds it |
| `frontend/CLAUDE.md` sits under a size ceiling | F3's new Need/Use row may shorten another; the ceiling spec says which |
| A memoised row re-renders on every list render because it receives a new function | Rows take the `hidden` set (a stable reference), not `isVisible` |
| A guard that walks `git ls-files` cannot see a new file | Stage with `git add -N` before running; the contract spec reads by path and fails loudly |

## 14. Open questions

The sub-issues implement the recorded decision for each; the maintainer may
reverse one on the sub-issue before it is dispatched.

1. Refuse or drop an unknown id on write (decision 6): refuse.
2. A remembered sort on a hidden column (decision 8): fall back to date.
3. Whether the holdings menu belongs in the heading block or in a new
   toolbar strip: the heading block, since the table has no pager and the
   toolbar convention is for lists that page.
