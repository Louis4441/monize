# Time-Series and Backtest Contract

The canonical rules for any code that works with historical prices, period
returns, or backtests. `docs/financial-calculation-contract.md` defines how
missing values propagate through a point-in-time calculation; this document
defines what "missing" means along the time dimension, and what a calculation
over incomplete history is allowed to claim.

The core principle: **a missing price is missing data, not a price of zero
and not "no change".** Treating a gap in price history as a 0% return is a
specific and usually false financial assumption dressed up as neutral
handling.

## 1. Adjusted versus raw prices

- Return, performance, and backtest calculations use **adjusted** prices
  (adjusted for splits and, where available, distributions), so that a split
  does not appear as a crash and a dividend is not lost from the return.
- Position valuation ("what is this holding worth today") uses the raw close
  and the actual share quantity held.
- A single calculation must never mix adjusted and raw prices for the same
  instrument. State which series a function consumes in its contract.

## 2. Quote age and period boundaries

- A price used to value a period boundary (period start, period end, or
  "now") must be dated **within a bounded window** of that boundary. The
  window is a deliberate, documented constant of the calculation that uses it
  -- generous enough to span weekends and market holidays, tight enough that
  the quote still describes the boundary (for daily series, days, not
  months).
- An arbitrarily old quote must never be carried forward and treated as a
  current period-end value. The most recent price is not "the price" once it
  falls outside the window -- it is a stale price, and the boundary value is
  unknown.
- A period whose boundary has no price inside the window has an **unknown**
  boundary value, and every metric derived from it (that period's return, and
  any aggregate including that period) follows the missing-data rules below.

## 3. Missing returns are never zero

- A period with no usable prices has `return: null`. Never `0`.
- A gap must not be bridged by assuming the portfolio value was flat across
  it. If the value at the start or end of a period is unknown, the period
  return is unknown.
- Interpolation across a gap is only acceptable when the calculation
  explicitly documents it, the interpolated span is flagged in the output,
  and the affected periods are identified -- never silently.

## 4. Incomplete history: reject or disclose

A backtest or performance calculation whose price coverage is incomplete must
either be **rejected** or returned with an explicit incomplete state -- never
returned as if complete:

```typescript
status: 'complete' | 'incomplete';
missingPeriods?: string[];   // which periods lacked usable prices
```

- Affected metrics are `null`, not computed over the covered subset and
  presented as if they described the whole span.
- Aggregate metrics that a gap invalidates -- CAGR, cumulative return,
  volatility, drawdown, Sharpe-style ratios -- become `null` when any period
  they span is missing, because each assumes an unbroken chain of returns. A
  "normal-looking" CAGR over a history with holes is a fabricated number.
- Metrics that can be honestly restricted (e.g. best/worst *covered* period)
  may be returned, labelled as covering only the known periods.
- The instruments and date ranges responsible for the gaps must be
  identifiable from the response, so the consumer can fix the data instead of
  distrusting the feature.

## 5. Signal and simulation coherence

For strategies that materialize periodic signals and simulate acting on them:

- A simulation may only chain periods whose signals were produced under the
  same configuration revision (see the materialized-results rule in
  `docs/financial-calculation-contract.md`); a predecessor chain that crosses
  a configuration change is broken, not continuous.
- Calendar rules (which dates count as period boundaries, how non-trading
  days shift them) are part of the declared configuration -- changing them is
  a configuration change.

## 6. Testing

Time-series code inherits the testing requirements of
`docs/financial-calculation-contract.md` section 7. The adversarial cases
specific to this contract: a gap in the middle of a backtest, a stale quote
just outside the boundary window, a first period with no starting price, and
an instrument whose history starts after the requested range -- each must
produce `null`/`incomplete`, and a test must fail if it produces a number.
