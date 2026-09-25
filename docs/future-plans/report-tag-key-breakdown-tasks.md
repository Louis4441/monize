# Tasks: report breakdown by tag key

Task list for `docs/future-plans/report-tag-key-breakdown.md`. Phase 1 is the
current work; Phases 2-3 are stubs. Check a box only when its gate (the plan's
"What to run") passes and is quoted in the commit/PR.

## Phase 1 -- Income vs Expenses + Cash Flow

### Backend

- [ ] Add `tagKey?: string` to `IncomeVsExpensesQueryDto` (bare tag key; trim;
      no value list from the client). Validate as an optional bounded string.
- [ ] Thread `tagKey` through `built-in-reports.controller.ts` (both
      `income-vs-expenses` and `cash-flow`) into
      `IncomeReportsService.getIncomeVsExpenses` `options`.
- [ ] In `getIncomeVsExpenses`: when `tagKey` absent, return today's response
      unchanged. When present, additionally compute per-value buckets, the
      untagged bucket, and All, each through the existing per-currency +
      completeness path.
- [ ] Compute `taggedInflows` / `taggedOutflows` per period + value from transfer
      legs (parent `is_transfer = true` or split `transfer_account_id IS NOT
      NULL`) carrying `K:value`, excluding VOID and investment-linkage rows;
      never fold into income/expenses/net (INV-REPORT-003).
- [ ] Reuse the value/key SQL expressions (the `getTransactionBreakdownByTagKey`
      shape) and the split-tag subquery from `buildTagKeyFilterClause`; do NOT
      re-spell them. Keep `investmentExclusionSql` on every branch.
- [ ] Extend the response types in `built-in-reports/dto/` additively
      (`tagKey`, `buckets[]` with per-bucket `data`/`totals`/`taggedInflows`/
      `taggedOutflows`/`missingCurrencies`/`excludedCount`).

### Backend tests

- [ ] Parity spec (I1): no-`tagKey` response deep-equals the pre-feature response.
- [ ] Value-partition spec (B1-B4): household / stall / both / untagged fixture;
      All equals the un-partitioned report; multi-valued row in both buckets.
- [ ] Split-tag attribution + no fan-out (B4, I7).
- [ ] Transfer visibility (I2, I3): self-transfer truth table 3.1; double-count
      case 3.2 gives income 100 not 200; untagged transfer appears nowhere.
- [ ] VOID (I6) and investment-linkage (I5, issue #1257) guards.
- [ ] FX-completeness per bucket (I4).

### Frontend

- [ ] "Break down by tag key" `Select` in `IncomeVsExpensesReport` and the Cash
      Flow report; populate via `collectTagKeys`; hide with no `KEY:VALUE` tags;
      default "None" sends no `tagKey`.
- [ ] Render value buckets + untagged bucket (i18n label) + tagged flows as a
      distinct labelled pair; per-bucket completeness treatment.
- [ ] `built-in-reports.ts` API client passes `tagKey`; mirror response types in
      `frontend/src/types/built-in-reports.ts`.
- [ ] Frontend tests: selector hidden/shown; "None" renders today's report;
      buckets + flows render; incomplete bucket treatment.

### i18n

- [ ] Add `reports.tagBreakdown.*` keys to `en`; `npm run i18n:pseudo`; translate
      every locale as the final commit.

### E2E

- [ ] Smoke: tag two transactions under `scope`, open Income vs Expenses, switch
      the breakdown to `scope`, see value tabs + a tagged-transfer flow figure.

## Phase 2 -- Spending by Category + Income by Source (stub)

- [ ] Reuse the Phase 1 DTO mixin, bucket shape, control and i18n; value
      partitioning only (no transfer flows).

## Phase 3 -- Budget vs Actual (stub)

- [ ] Design note first (budgets module, budget-period + category based).
