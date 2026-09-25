# Spec: intraday portfolio value uses each day's own positions

Status: approved for implementation on `claude/funny-wright-qpjpc0`.
Governs: INV-INTRADAY-001 (new), and extends INV-HOLDING-002 to the intraday
chart ranges (1D, 1W, MTD, 1M).

Read `docs/financial-calculation-contract.md` section 1 and
`docs/time-series-contract.md` first; this spec applies them to the intraday
series of the Portfolio Value Over Time chart.

## 1. The defect this replaces

`PortfolioService.loadIntradayData` built every bar of the 1D / 1W / MTD / 1M
series from two present-tense figures:

- the share count in `holdings.quantity` **today**, and
- the cash balance of each investment cash account **today**.

Both were applied to every bar in the window, however many days back it was.
The 3M and longer ranges (`NetWorthService.getDailyInvestments`) replay the
ledger day by day instead, which is why they reconcile with a brokerage
statement and the intraday ranges did not.

Observed on a CA RRSP holding XGRO and XCNS, with $2,000 deposited on Aug 28
and spent on XCNS on Aug 31, and again deposited Sep 14 and spent Sep 15:

| Day | Daily series (3M) | Intraday (1M) at the last bar | Why |
|---|---|---|---|
| Aug 26 | XCNS $89,741.98, cash $0.00 | XCNS $93,788.06, cash $0.06 | both later XCNS buys and today's cash applied backwards |
| Aug 28 | cash $2,000.00 | cash $0.06 | the uninvested deposit is missing |
| Sep 15 on | XCNS $92,237.26 | XCNS $92,237.26 | no activity after this day, so the two agree |

Two further effects of the same shortcut:

- A position sold inside the window vanished from the whole window, because a
  zero quantity today was skipped.
- A holding the intraday provider could not chart (a mutual fund, a failed
  fetch) was a flat line at `quantity today x latest close`.

And one that is not about positions at all: the last intraday bar of a session
is stamped with its **start** (15:45 on 15-minute bars) and carries the last
trade in that bar, not the official close. XGRO on Sep 2 closed at $38.58 while
the last 15-minute bar ended on $38.575; on 2,891.173 shares that is $14.46.
Yahoo's intraday closes also carry float noise (`38.66999816894531`), a cent on
a six-figure position.

## 2. Invariants

1. **A bar on calendar day D is valued at the positions held at the close of
   D**: the share count per security from the same ledger replay the daily
   series uses (`applyActionToQuantity`, INV-HOLDING-002) and the cash each
   investment cash account held at the end of D (`loadDailyCashBalances`).
   Neither is ever read from today's `holdings` row or today's balance for a
   past day.
2. **A finished session ends on the daily series' figure for that day.** For
   every day D in the window before today, the series carries one point after
   D's last bar whose `value` and `securitiesValue` are exactly
   `getDailyInvestments`' `value` and `securitiesValue` for D -- the same
   accepted closes, the same rate index, the same cash. It is stamped at the end
   of the last bar (last bar + grid step), so a 15-minute series ends each day
   at 16:00.
3. **Today's session is live**: it ends on its latest bar, with no synthetic
   close point, because today's close is not a fact yet.
4. **A holding with no intraday bars is valued per day** at that day's quantity
   times the accepted close on or before that day (`positionCloseAsOf`), not at
   today's quantity times the latest close.
5. **The security set is every security held on any day of the window**, not
   the set held today, so a position sold mid-window keeps its bars up to the
   sale and is zero after it.
6. **The previous day's close stays the baseline.** Nothing here removes the
   first day's closing point; the 1M chart collapses its first day to that point
   (`trimIntradayToFirstDayClose`), and 1D / 1W / MTD measure their change from
   the prior close through the period-result service. Both now read a closing
   figure that equals the daily series.

## 3. Numerical examples

XGRO only, 2,891.173 shares, no activity, CAD display:

| | Last intraday bar (15:45) | Session close point (16:00) | Daily series |
|---|---|---|---|
| Sep 2 | 38.575 -> $111,527.00 | $111,541.46 | $111,541.46 |
| Sep 24 | 38.6699981 -> $111,801.65 | $111,801.66 | $111,801.66 |

RRSP above, Aug 28 bars: XCNS valued at the pre-Aug-31 share count, cash
$2,000.00 on every bar of the day, and the 16:00 point equals the daily
series' Aug 28 total ($930,475.80).

## 4. Missing-data policy

- The per-day positions come from `NetWorthService.getDailyInvestmentPositions`,
  which is the daily fold itself with its per-day inputs recorded. A day the
  fold has no row for falls back to nothing: the bar is valued at no positions
  rather than at today's.
- A cash account with no balance row for a day contributes nothing to that
  day's bars, exactly as the daily fold reports it (`cashComplete: false`).
- An unpriced position on a day (no accepted close on or before it) contributes
  nothing to that day's close point or to a no-intraday holding's bars, as in
  the daily fold (`pricesComplete: false`). A position that has intraday bars
  is valued from them regardless.
- A pair with no rate follows INV-FX-001 unchanged: the contribution is left
  out and the currency named in the log, never valued at 1:1.

## 5. Test matrix

| Case | Expectation |
|---|---|
| Buy on day 2 of a 3-day window | day-1 bars exclude the new shares; day-2 and day-3 bars include them |
| Full sale on day 2 | day-1 bars include the position; bars after the sale do not; the security is fetched although today's holding is zero |
| Cash deposit on day 2 | day-1 bars exclude it |
| XGRO Sep 2 fixture | 15:45 bar $111,527.00; 16:00 close point $111,541.46, equal to the daily series |
| No-intraday holding | each day valued at that day's close, not a flat latest close |
| Today's session | no synthetic close point after its last bar |
| Breakdown view | the close point carries per-security bands at the daily closes, summing to the daily total within rounding |
