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
- **Choose the basis per series, never per row.** An adjusted-close column is
  typically nullable and typically written by one source only, so a per-row
  `COALESCE(adjusted, raw)` reads like "adjusted, falling back where the
  provider gave none" and is in fact a splice: every row some other writer
  inserted -- a transaction-derived price, an import, a seed -- lands raw
  inside an adjusted history. Around a split that is a several-hundred-percent
  return and a drawdown that never happened, on any instrument the user has
  ever traded. Decide once per instrument over the window being read: adjusted
  rows only where any exist, raw throughout where none do, never both.

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

### 2.1 One door, not one constant

A named window constant is not enough on its own. Turning a stored observation
into a value-for-a-date must go through a **shared helper that applies the
window**, and every site that needs such a value must use it -- the chart, the
position valuation, the backfill check, the signal, all of them. Adding a
second unbounded path beside the bounded one is how the rule ends up with a
constant, a docstring, and three call sites that ignore both.

In practice that bans, outside the helper itself:

- a nearest-observation lookup with no age test;
- `ORDER BY <date column> DESC LIMIT 1` (or `DISTINCT ON`) with no lower bound
  on the date;
- reading a stored rate or price "latest" and using it in a reported figure.

Where a module has such a helper, a scanning test should fail on a new call
site that bypasses it, in the manner of
`frontend/src/test/ui-conventions.test.ts`.

### 2.2 An exchange rate is a price

Everything above applies to currency conversion unchanged. A total built from
a fresh price and a nine-month-old rate is no more knowable than one built
from a stale price, and it fails more quietly, because no figure on the page
is denominated in a rate. A conversion feeding a number the user acts on takes
a bounded rate or returns unknown.

### 2.3 A boundary needs two observations, not two lookups

When a span's two ends are bounded independently, both can resolve to the
*same* observation -- necessarily so whenever the span is shorter than the
window. The arithmetic then returns exactly zero change, which is
indistinguishable from a market that went nowhere and counts itself as a fully
covered period. Require the two ends to be **different observations**, and
distinguish the two reasons a span has none: a gap in the history, versus a
period that has not yet produced a second close. They are answered differently
-- the first breaks the chain, the second has simply not happened yet.

### 2.4 Two boundaries say nothing about the interior

A metric that depends on the *path* between boundaries -- drawdown, intraperiod
extremes, anything "worst" or "peak" -- is only measurable where the
observations between them are actually consecutive. Boundaries that satisfy
the window rule are no evidence about the middle: a month-long hole is stepped
straight over, and the walk reports a calm zero for a period that may have
halved. Check the spacing of the observations inside the span, and return
`null` when any stride exceeds the window.

## 3. Missing returns are never zero

- A period with no usable prices has `return: null`. Never `0`.
- A gap must not be bridged by assuming the portfolio value was flat across
  it. If the value at the start or end of a period is unknown, the period
  return is unknown.
- Interpolation across a gap is only acceptable when the calculation
  explicitly documents it, the interpolated span is flagged in the output,
  and the affected periods are identified -- never silently.
- **The rule survives to the pixel.** A `null` the server took care to produce
  is undone by a chart that bridges it (`connectNulls` and its equivalents),
  by a bar rendered at zero width beside an unknown label, or by a row that
  vanishes instead of showing an unknown marker. A straight segment across
  four unobserved months is indistinguishable from measured data, and a
  tooltip admitting "unknown" under the cursor does not undo it. Whoever adds
  the `null` owns its rendering.

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
