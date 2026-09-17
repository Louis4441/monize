# Spec: the portfolio's result over a period

Status: **proposed.** Scope from kenlasko/monize#1392 ("Portfolio value over time:
change for the period counts deposits as gain"), part of the #1387 family.

Owner: net-worth. Related: `docs/specs/portfolio-movement-notifications.md` (the
same measure, asked per day), `docs/financial-calculation-contract.md` (a
subtotal is not a total), `docs/time-series-contract.md` (period boundaries),
INV-PORTRESULT-001.

---

## 1. The defect this exists to remove

The Portfolio Value Over Time report prints a "Period Change" of `last - first`
over the plotted series, and a "Period Return" of that difference over the first
point. Both count the reader's own deposits as gain.

The reproduction from the issue, with a price that never moves:

| Date | Event | Portfolio value |
| --- | --- | --- |
| 2026-01-02 | deposit 10,000; buy 100 units at 100 | 10,000 |
| 2026-06-01 | deposit 10,000; buy 100 units at 100 | 20,000 |

Over `2026-01-02 .. today` the report says **+10,000 / +100%**. The market did
nothing; the reader moved 10,000 of their own money in. A figure captioned
"Return" that reports a transfer as a gain is the #1387 class of defect: a
plausible number nobody can tell from a real one.

## 2. The measure

Let `A` be the scope's investment accounts (both sleeves; resolved by
`resolveInvestmentScopeAccountIds`, never by an account-type predicate --
INV-REPORT-001), `b` the baseline date and `e` the end date.

- `MV(t)` -- the scope's market value plus cash at the close of day `t`, in the
  reporting currency, from `NetWorthService.getDailyInvestments`: the same series
  the chart draws, with the same completeness bits (`fxComplete`,
  `pricesComplete`, `cashComplete`). Never a second valuation.
- `valueChange = MV(e) - MV(b)`.
- `netExternalFlows` -- the net cash that crossed `A`'s boundary from outside `A`
  on the days `(b, e]`, converted per day at that day's rate and summed in the
  reporting currency. Which rows are external flow is
  `loadExternalFlowSubtotals` (`backend/src/securities/external-flow.util.ts`),
  the classifier the daily notification and the calendar already share: a
  deposit, a withdrawal, or a transfer leg whose counterparty is outside `A`.
  Investment-linked cash (BUY, SELL, DIVIDEND, interest, fees), a transfer
  between two accounts of `A`, and a VOID row are internal and are not flows.
- `investmentResult = valueChange - netExternalFlows`.
- `returnPercent = investmentResult / MV(b) * 100`, method `simple`, computed
  only when `MV(b) > 0`.

The lower bound is **exclusive**: `MV(b)` is the close of day `b` and already
contains every flow that landed on `b`. Counting those flows again would subtract
them from a starting value that already holds them.

### 2.1 Why `simple` and not TWR or Modified Dietz

`simple` divides the whole period's result by the value at the start. It ignores
*when* a flow arrived, so it understates the return of a period whose money
arrived late and overstates one whose money arrived early. It is named on the
wire (`returnMethod: "simple"`) precisely so a later time-weighted figure is a
new member of that union rather than a silent change of meaning under the same
caption.

Modified Dietz would weight each flow by the fraction of the period it was
invested for, and a true time-weighted return would chain sub-period returns
across every flow date. Both need a complete value on every flow date, not only
on the two boundaries, and both need a decision about a sub-period whose value is
unknown -- neither of which this change makes. Claiming "TWR" over an
unweighted ratio would be the `docs/financial-calculation-contract.md` section
8.4 defect: a second figure inheriting a denominator it does not describe.
`calculateTWR()` elsewhere in the codebase is not reused here; it answers a
different question over a different input.

## 3. Invariants

- **INV-PORTRESULT-001 (a period change is not a return).** Any surface that
  prints what a portfolio did over a period reports `valueChange`,
  `netExternalFlows` and `investmentResult` as three separate named figures, and
  prints a percentage only over `investmentResult`. A single "change" derived
  from the value series alone is a contribution reported as performance.
- **INV-PORTRESULT-002 (both boundaries complete, or no change).** `valueChange`
  is a value only when `MV(b)` and `MV(e)` are both complete
  (`fxComplete !== false && pricesComplete !== false && cashComplete !== false`).
  A subtotal minus a total is not a difference.
- **INV-PORTRESULT-003 (an unconvertible flow withholds the result, never
  shrinks it).** A flow subtotal with no rate for its day makes
  `netExternalFlows` `null` and `investmentResult` `null`, with the pair named.
  Dropping that currency would report the reader's own deposit as a gain, which
  is the defect this spec removes, in a second form.
- **INV-PORTRESULT-004 (zero start has no percentage).** `MV(b) = 0` yields
  `returnPercent: null` with reason `zeroStart`; the money figures are still
  reported.

Every completeness read is `=== false` (absent is no information), and every
withheld figure names its cause at the surface that withholds it.

## 4. Truth table

| MV(b) | MV(e) | flows | MV(b) value | valueChange | netExternalFlows | investmentResult | returnPercent | reasons |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| complete | complete | complete | > 0 | number | number | number | number | -- |
| complete | complete | complete | 0 | number | number | number | `null` | `zeroStart` |
| incomplete | complete | complete | any | `null` | number | `null` | `null` | the point's own causes |
| complete | incomplete | complete | any | `null` | number | `null` | `null` | the point's own causes |
| complete | complete | incomplete | any | number | `null` | `null` | `null` | `missingRatePairs` |
| no series | -- | -- | -- | `null` | `null` | `null` | `null` | `noValueSeries` |

A point's own causes are `incompletePrices` (a held position with no accepted
close), `incompleteCash` (a scoped cash account with no balance for the day) and
`missingRatePairs` (a component that did not convert), each carried with the ids
or pairs behind it.

## 5. Numerical examples

All in the reporting currency; the price never moves unless stated.

1. **The issue.** `MV(b) = 10,000` on 2026-01-02 (the deposit and the buy are
   both inside that close), `MV(e) = 20,000`, one 10,000 deposit on 2026-06-01.
   `valueChange = 10,000`, `netExternalFlows = 10,000`,
   `investmentResult = 0`, `returnPercent = 0`.
2. **A real gain beside a deposit.** Same as (1) but the price rises to 110 by
   `e`: `MV(e) = 22,000`, `valueChange = 12,000`, flows `10,000`,
   `investmentResult = 2,000`, `returnPercent = 20%` over the 10,000 start.
3. **A withdrawal.** `MV(b) = 10,000`, a 3,000 withdrawal, price flat:
   `MV(e) = 7,000`, `valueChange = -3,000`, `netExternalFlows = -3,000`,
   `investmentResult = 0`, `returnPercent = 0`.
4. **An internal transfer.** 5,000 moved from the cash sleeve to the brokerage,
   both in scope: `netExternalFlows = 0`, and the result is whatever the market
   did.
5. **A flow with no rate.** A 1,000 EUR deposit into a EUR account with no
   EUR->USD observation within `FX_MAX_RATE_AGE_DAYS` of its day:
   `netExternalFlows = null`, `investmentResult = null`,
   `missingRatePairs: ["EUR->USD"]`; `valueChange` still reported.
6. **A flow on the baseline day.** A 10,000 deposit dated `b` is already in
   `MV(b)`: it is **not** a flow of this period, and the result is unchanged.

## 6. Missing-data policy

`null` with a reason, never a substituted number. Specifically: never a value
change computed from a subtotal boundary; never a flow total that silently drops
an unconvertible currency; never a rate of 1 for a failed lookup; never a
percentage over an incomplete result; never `0` where the answer is unknown. A
known zero -- a period in which nothing moved, a scope with no flows -- is a
number and is reported as one.

The partial flow sum, when a rate is missing, is returned beside the `null` under
its own name (`knownFlowSubtotal`) rather than under `netExternalFlows`.

## 7. Where it is computed, and by whom

One answer, on the server:
`backend/src/net-worth/portfolio-period-result.service.ts` computes it and
`backend/src/net-worth/portfolio-period-result.util.ts` holds the pure decision
(`decidePeriodResult`), table-tested without a database exactly as
`decideDailyMovement` is. `GET /net-worth/investments-period-result` serves it
for the same scope, range and display currency the chart asked for, plus an
explicit `baselineDate` for the ranges measured from the prior close (1d, 1w,
mtd). The client chooses the dates; it does no arithmetic over them.

## 8. Test matrix

Backend unit (`portfolio-period-result.util.spec.ts`,
`portfolio-period-result.service.spec.ts`):

| Case | Expected |
| --- | --- |
| the issue's two deposits, flat prices | result `0`, percent `0`, flows `10,000` |
| a market gain beside a deposit | result is the market's part only |
| a withdrawal | flows negative, result `0` |
| an internal transfer between two scoped accounts | flows `0` |
| a flow day with no rate | flows and result `null`, pair named |
| first point incomplete | `valueChange` and result `null`, the point's causes |
| last point incomplete | `valueChange` and result `null`, the point's causes |
| `MV(b) = 0` | percent `null`, reason `zeroStart`, money reported |
| empty series | every figure `null`, reason `noValueSeries` |
| an explicit `baselineDate` | the baseline's close is the start, flows after it |

Frontend (`PortfolioValueReport.test.tsx`): the KPI cards show value change, net
deposits and withdrawals, and the investment result as three separate figures;
each relabels through `PartialTotal` / the unknown marker when the server
withholds it, reading every flag as `=== false`.

The adversarial case, per `docs/financial-calculation-contract.md` section 8:
example (1). A naive `last - first` passes every other case in this matrix and
fails exactly that one.
