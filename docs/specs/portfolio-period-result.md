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
- `netExternalFlows` -- the net cash that crossed the boundary of `C` from
  outside it on the days `(b, e]`, converted per day at that day's rate and
  summed in the reporting currency. **`C` is not `A`**: it is the subset of `A`
  whose ledger cash `MV` actually values -- the cash sleeves and the standalone
  investment accounts, `isValuationCashAccount`
  (`backend/src/net-worth/net-worth.service.ts`) -- and the same set is used on
  both sides of a transfer. One boundary, or a deposit posted straight to a
  brokerage row is subtracted from a value change that never held it. Which rows
  are external flow is
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
- **INV-PORTRESULT-005 (a movement the classifier cannot count withholds the
  result).** When the window holds an investment action settled outside `C`, or
  a split parent mixing an investment line with ordinary cash, `investmentResult`
  and `returnPercent` are `null` with the reason `externallySettledTrade` or
  `mixedSplit`. `valueChange` and `netExternalFlows` are both still measured;
  what is unknown is whether their difference is the market's.

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
| complete | complete | complete, but a movement is uncountable | any | number | number | `null` | `null` | `externallySettledTrade`, `mixedSplit` |
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

### 6.1 The two movements the flow classifier cannot count

Both are the coarse cases `external-flow.util.ts` documents. Each moves value
across the boundary of `C` without producing a countable flow, so the difference
`valueChange - netExternalFlows` stops being the market's. Each is **counted**
per window -- one `COUNT(*)` beside the flow query, in
`PortfolioPeriodResultService.countUnmeasuredFlows` -- and a count above zero
withholds `investmentResult` and `returnPercent` with the reason named. Counting
is deliberate: measuring either is a line-granular rewrite of the classifier, and
a count is all that withholding needs.

1. **`externallySettledTrade`.** An investment action in the window, on an
   account of `A`, whose settlement cash is outside `C`: an explicit
   `funding_account_id` naming an account outside it, a generated cash leg
   (`transaction_id`) posted to an account outside it, or an embedded investment
   split whose parent sits on one. A 10,000 BUY funded from a chequing account
   raises `MV` by 10,000 and leaves no cash leg in `C` at all, so the flow query
   reports zero and the naive subtraction calls the reader's own money a hundred
   per cent gain -- the defect of section 1, reached by a second route.
   The same reason covers an action that moved SHARES with no cash leg of any
   kind -- `TRANSFER_IN`, `TRANSFER_OUT`, `ADD_SHARES`, `REMOVE_SHARES` -- unless
   its linked leg is on an account of `A`, which makes it a move inside the
   portfolio rather than across its boundary. Shares arriving from outside are
   value entering with no cash to net it against.
   A brokerage account with no linked cash sleeve settles its own trades on
   itself, which is outside `C` by construction; such a scope reports
   `valueChange` and withholds the result, which is the honest answer while its
   cash is not valued.
2. **`mixedSplit`.** A split parent in the window, on an account of `C`, that
   carries BOTH an investment-linked line and an ordinary one. The flow sum is
   over `t.amount`, so the classifier drops such a parent WHOLE: its ordinary
   cash is in `MV` and in no flow.

Neither is a boundary nobody can fix: recording the trade's cash inside the
portfolio, or splitting the mixed parent into its two rows, makes the period
measurable again. The surface says which one it hit.

## 7. Where it is computed, and by whom

One answer, on the server:
`backend/src/net-worth/portfolio-period-result.service.ts` computes it and
`backend/src/net-worth/portfolio-period-result.util.ts` holds the pure decision
(`decidePeriodResult`), table-tested without a database exactly as
`decideDailyMovement` is. `GET /net-worth/investments-period-result` serves it
for the same scope, range and display currency the chart asked for, plus an
explicit `baselineDate` for the ranges measured from the prior close (1d, 1w,
mtd). The client chooses the dates; it does no arithmetic over them.

## 8. The batch route: six windows, one valuation

The Investments page reports the result over six trailing windows at once (1D,
1W, 1M, 3M, YTD, 1Y). Six calls to the single-range route would rebuild the
daily valuation six times -- `NetWorthService.getDailyInvestments` is the
expensive part -- and the one-year series already contains every shorter
window's points, so `GET /net-worth/investments-period-results` builds the
series ONCE for the widest window asked for and derives each preset by slicing
it (`backend/src/net-worth/portfolio-period-results-batch.service.ts`).

The route takes `periods` (a comma-separated subset of the closed set
`1d,1w,1m,3m,ytd,1y`; all of them when omitted), plus the same `accountIds` and
`displayCurrency` as the single-range route, and answers
`{ currency, asOf, periods: { [preset]: PortfolioPeriodResult } }`. An unknown
preset is a 400: the windows are the server's own arithmetic
(`backend/src/net-worth/portfolio-period-presets.util.ts`), which is what keeps
the Investments page, the chart and any later surface from disagreeing about
where a month begins.

**What is sliced, and what is not.** Nothing is recomputed: the same
`decidePeriodResult` decides every figure, from the same series, the same flow
classifier and the same per-day conversion.

| Per preset | Taken from the one wide load |
| --- | --- |
| MV(e) | the series' last point, shared by every preset |
| MV(b) | the last point on or before the prior-close baseline (1d, 1w), else the first point inside the window |
| flows | the per-day subtotals dated strictly after that preset's own lower bound, folded against one rate index (`backend/src/net-worth/period-flow-fold.util.ts`) |
| unmeasurable movements | the per-day counts over the same days (`backend/src/net-worth/unmeasured-flows.util.ts`) |

Slicing is equivalent because neither input depends on how wide a window was
asked for: a day is valued from the latest accepted close on or before it, and
`buildRateIndex` loads enough rows that a date resolves the same in any window
(issue #1390 is the defect that established the second). The equivalence is
asserted rather than assumed:
`backend/src/net-worth/portfolio-period-results-batch.service.spec.ts` runs the
batch route and the single-range route over one fixture and compares them
preset by preset, giving the single route exactly the dates the client computes
(`usesPriorCloseBaseline`, `previousCalendarDay`).

**A window the series does not reach back to** -- a portfolio three days old
asked for its year -- is every figure `null` with `noValueSeries`, and the
surface reads it as "n/a". Measuring from the first day the scope held anything
would put a number under a caption promising a year of it, which is the
security performance card's "n/a rather than 0%" rule, for the same reason.

## 9. Test matrix

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
| a BUY settled outside `C` | result and percent `null`, reason `externallySettledTrade` |
| a mixed split parent in the window | result `null`, reason `mixedSplit` |
| the flow query's account set | the valued cash accounts, not the whole scope |

Backend unit
(`backend/src/net-worth/portfolio-period-results-batch.service.spec.ts`):
equivalence with the single-range route for every preset, the series built once
over the widest window, a flow counted in the windows that contain it and in no
other, a window an uncountable movement withholds while its neighbours stay
measurable, a short history, a currency override and an empty scope.

Backend unit (`portfolio-period-results-batch.service.spec.ts`): equivalence
with the single-range route for every preset, the series built once over the
widest window, a flow counted in the windows that contain it and in no other, a
window an uncountable movement withholds while its neighbours stay measurable,
a short history, a currency override and an empty scope.

Frontend (`PortfolioValueReport.test.tsx`): the KPI cards show value change, net
deposits and withdrawals, and the investment result as three separate figures;
each relabels through `PartialTotal` / the unknown marker when the server
withholds it, reading every flag as `=== false`.

The adversarial case, per `docs/financial-calculation-contract.md` section 8:
example (1). A naive `last - first` passes every other case in this matrix and
fails exactly that one.
