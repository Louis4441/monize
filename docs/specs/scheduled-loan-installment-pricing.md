# Spec: scheduled loan installment pricing

Status: implemented on `claude/issue-1253-6e3rel`.
Governs: issue #1253 -- scheduled loan payment interest drifts from the
amortization report -- including the two residual findings from the audit of
the first proposed fix (PR #1254): a split resolved too early goes stale, and
a report anchored on today disagrees with a bill anchored on its due date.
Registered as INV-LOAN-006 in `docs/system-invariants.md`.

Read `docs/financial-calculation-contract.md` sections 1, 7 and 8, and
`docs/specs/account-balances-as-of.md`, before changing anything here.

## 1. The invariant

For a scheduled loan installment due on date `d`:

```text
debt(d)   = max(0, -(opening_balance + SUM(amount)
              over transactions WHERE account_id = loan
                AND (status IS NULL OR status <> 'VOID')
                AND parent_transaction_id IS NULL
                AND transaction_date <= d))
interest  = roundMoney(debt(d) * periodicRate)
principal = payment - interest, through allocateLoanPayment's waterfall
```

The ledger expression is the canonical as-of balance
(`docs/specs/account-balances-as-of.md` section 3, INV-BALANCE-001's source),
with the installment's due date in place of today. The periodic-rate rules are
unchanged: nominal annual rate over periods per year for loans and
non-Canadian mortgages, the semi-annual-compounding effective rate for a
Canadian fixed-rate mortgage, `periodsPerYearForStoredFrequency` for the
count in both spellings of the frequency column.

Two sources are explicitly **not** inputs:

- **The previously stored split.** `next = prev_interest - prev_principal *
  rate` is algebraically equivalent to pricing from balance only at full
  precision; stored splits are money already rounded to 4dp, so the recurrence
  carries the discarded fraction into every later bill (the issue's 98.0101
  versus 98.0000).
- **`accounts.current_balance`.** It is a through-today read model and
  deliberately excludes future-dated rows, so after a future-dated payment
  posts it repeats the old balance and the old interest.

## 2. Where it is priced

`ScheduledTransactionLoanService.resolveInstallment` is the one pricing path.
Three consumers resolve through it, and they must, because each one answered
differently is a reported drift:

| Consumer | Boundary `d` | When |
| --- | --- | --- |
| `recalculateLoanPaymentSplits` | the schedule's `next_due_date` (already advanced) | after each posting; writes the template for the next occurrence |
| `resolvePostingAllocation` | the occurrence's own due date | inside the posting transaction, under the parent lock, immediately before the financial write |
| `getLoanProjectionAnchor` | the schedule's `next_due_date` | on demand, for the amortization report's projection (`buildLoanProjectionInput`'s `anchor`) |

The posting-boundary resolution is what makes the stored split safely a
**template**: a principal-only payment, void, delete or import committed
between occurrences changes what the next posting writes without any of those
mutation paths having to know about loan templates. When nothing moved, the
resolution reproduces the persisted amounts exactly (same balance, same rate,
same waterfall), so the common case is byte-identical.

## 3. What does not re-resolve

- **An inline amount or a stored override amount** is the user's explicit
  statement for that one occurrence and is posted as given.
- **A template shape the resolver cannot account for** (an escrow line, no
  identifiable interest line) declines -- the posting proceeds on the
  persisted amounts and the recalculation writes nothing, exactly as the
  recalculation has always declined, because repricing only the managed lines
  leaves the parent unequal to the sum of its children and the split
  validator then refuses every occurrence.
- **A debt already retired through the boundary** resolves nothing: the
  recalculation deactivates the schedule; the posting proceeds unchanged and
  the following recalculation deactivates.
- **FX schedules, transfers and investments** do not carry the loan template
  shape and never reach the resolver.

## 4. Report parity

`GET /scheduled-transactions/loan-anchor/:accountId` answers
`{ nextDueDate, debt }` -- the due date of the earliest active schedule with a
transfer split into the loan, and `debt(nextDueDate)`. The Loan Amortization
Report fetches it inside the same request key as the loan's history (a failed
fetch reaches the report's error state; "no anchor" is not a fallback for an
outage) and hands it to `buildLoanProjectionInput`, so the first projected
row is the next bill: same date, same balance, same interest.

Both fields null means the loan has no active scheduled payment; there is no
bill to be in parity with, and the projection keeps its today-anchored
fallback (`advanceDate(today)` against `history.currentBalance`). The other
projection surfaces (loan detail payoff, Debt Payoff Timeline, Overpayment
Simulator) deliberately keep that today-anchored semantics -- they project "if
you keep paying from where you stand today" and print no per-installment
parity claim against the bill.

## 5. Numerical examples

6% nominal, monthly (periodic rate 0.005), configured payment 1,500:

| Ledger through `d` | debt(d) | interest | principal |
| --- | --- | --- | --- |
| opening -200,000, nothing else | 200,000 | 1,000.00 | 500.00 |
| + principal-only +1,500 dated before `d` | 198,500 | 992.50 | 507.50 |
| + another +500 dated exactly on `d` | 198,000 | 990.00 | 510.00 |
| + 1,500 dated after `d` | unchanged | unchanged | unchanged |
| + a VOID row, any date | unchanged | unchanged | unchanged |
| + a split child dated before `d` | unchanged (its parent already counts) | | |

The issue's own rounding case: debt 19,600, stored splits -399.99 / -100.01.
The recurrence gives `100.01 - 399.99 * 0.005 = 98.0101`; the invariant gives
`19,600 * 0.005 = 98.0000`.

## 6. Test matrix

- Unit (`scheduled-transaction-loan.service.spec.ts`): prior rounded splits
  deliberately inconsistent with the balance; the dated query bounded by
  `next_due_date` with its parameters asserted; posting-boundary resolution
  (stale template repriced, idempotence, decline on unmanaged shape, null on
  retired debt, extra-principal line); Canadian and non-Canadian mortgage
  rates unchanged; LINE_OF_CREDIT still supported; final-payment and
  extra-principal clamps unchanged; anchor endpoint shapes.
- Unit (`scheduled-transactions.service.spec.ts`): `post()` writes the
  ledger-derived allocation with the parent re-summed; posts the persisted
  amounts byte-identically when the ledger did not move; honours an override
  amount.
- PG integration (`scheduled-loan-dated-balance.integration.spec.ts`): the
  as-of SQL against a real database -- boundary inclusive, later rows
  excluded, VOID excluded, split children excluded -- through all three
  consumers.
- Frontend (`loan-history.test.ts`, `LoanAmortizationReport.test.tsx`): the
  anchored projection starts at the anchor's debt on the anchor's date and
  its first row's interest equals the bill's; `{null, null}` keeps the
  fallback; a retired anchored debt refuses the projection; the report calls
  the anchor endpoint inside the history request key.
