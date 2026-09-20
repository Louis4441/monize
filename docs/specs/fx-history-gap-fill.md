# Spec: FX history is filled over the span the currency is used

Status: approved, implemented alongside this document.

Related: `docs/specs/exchange-rate-canonical-orientation.md` (INV-FX-003),
`docs/financial-calculation-contract.md`, `docs/time-series-contract.md`
section 2.2, `docs/backend/securities-and-providers.md`.

## 1. What this changes, and why

A currency pair's stored history normally begins the day the nightly refresh
first ran. The cron writes today's spot rate only, and
`ExchangeRateService.backfillHistoricalRates` skips a pair the moment it holds
any row in either direction. Every report dated before that reports a missing
rate, correctly and permanently.

The user-facing door for this was `POST /currencies/exchange-rates/extend-history`,
which fetched the calendar year immediately before the earliest stored rate.
Walking back twenty years meant pressing a button twenty times, and it could
only extend the lower bound: a hole in the middle of the stored span, which is
what a partial on-demand fill leaves behind, was unreachable from any screen.

This replaces it with a fill that takes its span from the user's own data and
targets the holes:

- `GET /currencies/exchange-rates/stored?code=EUR` lists what is stored, so the
  holes are visible rather than inferred from an observation count.
- `POST /currencies/exchange-rates/fill-gaps` fetches the windows that are
  missing between the first date the currency is used and today.

## 2. Definitions

**Reporting currency.** The caller's `user_preferences.default_currency`,
resolved server-side by `resolveUserDefaultCurrency`. A request names a
currency code, never a pair.

**The pair.** `code -> reportingCurrency`. The same-currency case is a 400: 1 is
not a stored observation.

**Display direction.** Units of the reporting currency per 1 unit of `code`.
A row stored in the other orientation is shown as `roundFxRate(1 / rate)` and
flagged `inverted`.

**Unresolvable date.** A date for which `resolveFxRate` in `historical` mode
can find no admissible observation: no stored observation for the pair, in
either stored direction, dated within `FX_MAX_RATE_AGE_DAYS` (45) before it.
Never a date merely lacking a row of its own.

**Gap.** A maximal run of consecutive unresolvable dates.

**Span.** `[spanStart, today]`, where `spanStart` is the day after the provider
floor when one is recorded for this pair, and otherwise `firstUse`, the
earliest date the currency appears in the caller's data (section 4).

**Window.** One provider request: a contiguous date range of at most
`GAP_WINDOW_MAX_DAYS` (365).

**Provider floor.** The latest date the provider has been found to have no
rate for a pair. Recorded on `currencies` as `provider_missing_through`, with
`provider_missing_against` naming the other side of the pair it was
established against.

## 3. Invariants

This spec introduces no new invariant ID. It is bound by three existing ones.

### INV-FX-001 -- an unavailable rate is not 1:1

The fill never invents a rate. A window the provider has no data for leaves
those dates unresolvable, and every surface continues to withhold the figure
with its cause. `stored: 0` is reported as "the provider carries nothing that
far back", never as success and never as a reason to substitute 1.

### INV-FX-003 -- a pair is stored in one orientation

The fill adds no writer: it reaches the provider through
`ExchangeRateService.fillRateWindow`, whose `persistRateSeries` already orients
every row through `canonicalRateRow`. The listing is a read, which the
orientation guard deliberately does not police.

The contract half of INV-FX-003 has not shipped, so a date written before that
change may still be held in both orientations. The listing shows such a date
**once**, keeping the canonical row, which is the same row the pending contract
migration keeps when the two disagree. The listing therefore needs no change
when that migration lands.

### The report-facing rule this exists to serve

A figure withheld for a missing rate names what is missing and where to get it
(`docs/financial-calculation-contract.md` section 1.3). This is the "where to
get it": the screen that reports the gap and the button that closes it.

## 4. The span

`firstUse` is the earliest of:

- the earliest `transactions.transaction_date` and non-VOID
  `investment_transactions.transaction_date` in any account whose
  `currency_code` is the requested code, and
- the earliest non-VOID `investment_transactions.transaction_date` for any
  security whose `currency_code` is the requested code and which is held in one
  of the caller's accounts.

This is the shape `backfillHistoricalRates` already uses, with one deliberate
difference: **closed accounts, inactive securities and zero-quantity holdings
count.** That backfill primes rates for current positions, so it filters them
out; a history fill must not, because "net worth over time" and "portfolio
value over time" cover the years a since-closed account was open.

An account or security with no postings falls back to its own creation date
rather than dropping out of the answer: an account holding an opening balance
and nothing else is still reported by "net worth over time", and telling its
owner that nothing of theirs uses the currency would leave them no way to fetch
the rates their own balances need. That is the fallback
`resolveInvestmentInception` already uses for an account with neither ledger.

`firstUse` of `null` therefore means no account and no security of the caller's
is denominated in the currency at all. There is then no report that needs the
rate, so the response says so and no provider call is made.

A non-positive stored rate is not an observation. `resolveFxRate` discards it,
so the gap planner must discard it too: counting it would leave the 45 days
after it looking answerable while every report over them still refuses to
convert.

### The provider's floor bounds the span from below

A provider's history starts where it starts and nothing the reader does moves
it: Yahoo carries no `USDCAD=X` before December 2003, against a ledger that may
open in 1996. Those seven years are not a gap anybody can fill, so the span
opens the day after the recorded floor rather than at `firstUse`.

The floor is **a property of the pair, not of the currency**: Yahoo's history
for USD/CAD and for USD/PLN begins on different days. It is stored on
`currencies` alongside the counter-currency it was established against, and is
honoured only when that matches the reader's own reporting currency. A
deployment whose readers report in different currencies therefore gives the
hint to the first pair that wrote it and no hint at all to the others, which
costs a re-discovery rather than hiding anybody's history. Moving the floor to
its own per-pair table is the cleaner shape and is deliberately left for the
day a second reporting currency makes it matter.

The floor only ever moves forward, and a write never overwrites one another
pair established.

The query runs under the caller's identity through `withScopedDb`: accounts,
transactions, securities and investment transactions are per-user tables, while
`exchange_rates` is RLS-exempt shared reference data read in the same scope.

## 5. Truth tables

### `planRateGapWindows(storedDates, spanStart, spanEnd)`

| Stored observations in the span | Windows planned |
|---|---|
| none | one gap covering the whole span, chunked |
| daily, no run of 46+ unresolvable days | none |
| daily except a 10-day hole | none; carry-forward answers those days |
| daily except a 60-day hole | one window over the hole, padded back |
| two 60-day holes, whatever separates them | two windows |
| one hole spanning 900 days | three windows of at most 365 days |

### One window's provider outcome

| `fillRateWindow` returns | Meaning | Response |
|---|---|---|
| `stored > 0, answered: true` | rates written | counted in `stored` |
| `stored: 0, answered: true` | the provider has nothing there | window remembered empty; on the oldest window, reported as `providerHasNothingBefore` |
| `stored: 0, answered: false` | no answer (transport, or the breaker refused) | 503 when nothing at all was stored; otherwise reported as windows left over |

### The request as a whole

| Condition | Result |
|---|---|
| `code` is the reporting currency | 400 |
| currency not used by any of the caller's data | 200, `usedFrom: null`, no fetch |
| no gap in the span | 200, `windowsPlanned: 0`, no fetch |
| more windows than the cap or the budget allows | 200, `windowsRemaining > 0`; pressing again continues |
| some windows unanswered, others stored rates | 200, the unanswered ones counted in `windowsRemaining` |
| first window got no answer, nothing stored | 503 |

## 6. Missing-data policy

A rate that cannot be fetched stays absent. Nothing in this path writes a
substituted, interpolated or carried-forward row: carry-forward is a read-time
rule in `resolveFxRate` with a 45-day bound, and writing it into the table
would turn a bounded inference into a stored fact.

Where the provider's history simply starts later than the user's data, the
response names the earliest date it carries so the reader learns the figure is
unobtainable rather than unfetched.

## 7. Numerical examples

Reporting currency PLN, code EUR, so the pair is `EUR->PLN` and the canonical
orientation is `EUR->PLN` (`E` < `P`).

1. **Inversion.** Reporting currency USD, code PLN. Canonical orientation is
   `PLN->USD` (`P` < `U`), so a stored `PLN->USD` row of `0.25` is the display
   direction already: 1 PLN buys 0.25 USD. For code USD with reporting currency
   PLN the same row is shown inverted: `roundFxRate(1 / 0.25) = 4`.
2. **Inversion precision.** A stored `0.7325` inverts to `1.3651877133`, not
   `1.3652`: the reciprocal is struck at the rate column's ten decimals
   (`roundFxRate`), never at money's four.
3. **A weekend is not a gap.** Observations on Friday the 4th and Monday the
   7th leave the 5th and 6th without rows, but both resolve to the 4th's
   observation, 1 and 2 days old, well inside 45.
4. **A 46-day hole is a gap.** Last observation 1 March, next 20 April. 16
   April is 46 days after 1 March, so 16 to 19 April are unresolvable and form
   a gap; 2 March to 15 April resolve by carry-forward.
5. **Window padding.** A gap of 16 to 19 April is fetched as 2 to 19 April:
   `BOUNDARY_LAG_DAYS` (14) of lead, so the gap's first day has an observation
   to carry forward from even if the provider's first bar lands late.
6. **Chunking.** A gap from 2010-01-01 to 2012-06-30 (911 days) becomes three
   windows of at most 365 days, because one deep request comes back as monthly
   bars.

## 8. Concurrency and idempotency

The write is the existing idempotent upsert on the natural key
`(from_currency, to_currency, rate_date)`, mechanism 4 of
`docs/concurrency-and-idempotency.md`, so two concurrent fills of the same pair
converge rather than duplicate.

`ExchangeRateHistoryService.inFlight` coalesces a double-clicked button into one
fetch. It is a coalescer, not a guard: it gates no row, coordinates nothing
across replicas, and losing it costs a round trip. It is keyed by **caller and
pair**, not by pair alone, because the summary describes the caller's own data:
two people sharing a reporting currency would otherwise both be handed the
first one's span and a window count computed for somebody else.

`EmptyWindowMemory` remembers a window the provider answered nothing for, for
thirty minutes. Also a cache, not a guard, in the category
`docs/cron-jobs.md` allows process-local state to sit in: a replica that has not
seen the miss simply makes the call again.

Windows are fetched **sequentially**, for two reasons that are both recorded
defects elsewhere. A burst of windows from inside one HTTP request is what
rate-limits everybody (`series-rate-fill.ts`). And only one concurrent call can
hold the circuit breaker's half-open probe, so parallel windows get refused and
read as empty years (`market-index.service.ts`).

Rate limiting needs nothing else: `YahooFinanceService.throttledFetch` caps
concurrency at five, leaves a 100 ms inter-request gap, retries 429 and 503
honouring `Retry-After`, and sits behind `ProviderHealthService`'s breaker. The
route keeps the 6-per-minute throttle its predecessor had.

## 9. Bounds, and what they cost

| Bound | Value | Why |
|---|---|---|
| `GAP_WINDOW_MAX_DAYS` | 365 | a wider request returns monthly bars, and `persistRateSeries` has no daily-spacing guard |
| `MAX_GAP_WINDOWS` | 8 | one press is a bounded number of provider calls |
| | | applied **after** dropping windows already known empty, never by the planner |
| `GAP_FILL_BUDGET_MS` | 20000 | a person is waiting on the request |
| `STORED_RATE_ROW_CAP` | 2000 | the listing is a scrollable dialog, not an export |

What a bound leaves out is reported (`windowsRemaining`, `truncated`), never
silently dropped. Pressing the button again continues from where the last press
stopped, because the plan is recomputed from what is stored.

**A window the provider has already answered with nothing must not consume the
budget.** It cannot be filled by asking again, so counting it against the cap
lets a pair whose history starts long after the reader's data does spend every
press skipping the same dead years, fetching nothing and never reaching the
windows that would answer. The planner therefore plans the whole span and the
service drops the known-empty windows before taking its `MAX_GAP_WINDOWS`.

A twenty-six-year gap is therefore roughly twenty-six windows, or four presses.
That is the accepted cost of daily bars.

## 10. What gets overwritten

`persistRateSeries` upserts with
`ON CONFLICT ... DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source`,
so every stored row inside a fetched window is replaced by the provider's value,
including a rate imported from Money.

This is why the fill targets gap windows rather than re-fetching the span, and
why nothing joins two gaps into one request. Two gaps are always separated by
an observation and the 45 days it reaches over, so joining them would re-fetch
and overwrite at least 47 days of stored rows to save one provider call. The
saving is not worth the rows.

## 11. Test matrix

| Claim | Where | Kind |
|---|---|---|
| a weekend is not a gap; a 46-day hole is | `rate-gap-plan.spec.ts` | unit |
| two holes stay two windows, never one re-fetching what is between them | `rate-gap-plan.spec.ts` | unit |
| a window is padded by the boundary lead | `rate-gap-plan.spec.ts` | unit |
| a multi-year gap splits into 365-day chunks | `rate-gap-plan.spec.ts` | unit |
| the cap keeps the oldest windows and reports the remainder | `rate-gap-plan.spec.ts` | unit |
| first use spans accounts and securities, closed ones included | `exchange-rate-history.service.spec.ts` | unit |
| an account with no postings still dates a use, from its creation date | `exchange-rate-history.service.spec.ts` | unit |
| an unanswered window is reported as still to do | `exchange-rate-history.service.spec.ts` | unit |
| two callers sharing a reporting currency get their own summaries | `exchange-rate-history.service.spec.ts` | unit |
| a known-empty window costs no place in the budget, so the next press reaches new ones | `exchange-rate-history.service.spec.ts` | unit |
| the floor names the end of the dead run, not of its first window | `exchange-rate-history.service.spec.ts` | unit |
| the span opens at a recorded floor rather than at first use | `exchange-rate-history.service.spec.ts` | unit |
| the floor is read and written per pair, and only ever moves forward | `exchange-rate-history.service.spec.ts` | unit |
| an unused currency makes no provider call | `exchange-rate-history.service.spec.ts` | unit |
| the same-currency case refuses before any query | `exchange-rate-history.service.spec.ts` | unit |
| no answer and nothing stored is a 503 | `exchange-rate-history.service.spec.ts` | unit |
| an empty window is remembered and skipped | `exchange-rate-history.service.spec.ts` | unit |
| windows are fetched oldest first, sequentially | `exchange-rate-history.service.spec.ts` | unit |
| a reverse-orientation row lists inverted at rate precision | `exchange-rate-history.service.spec.ts` | unit |
| a non-positive legacy rate lists as unknown | `exchange-rate-history.service.spec.ts` | unit |
| a date held in both orientations lists once, canonical row winning | `fx-rate-coverage.integration.spec.ts` | integration |
| a reverse-only pair lists inverted against real rows | `fx-rate-coverage.integration.spec.ts` | integration |
| dates come back as `YYYY-MM-DD` in any process time zone | `fx-rate-coverage.integration.spec.ts` | integration |
| a failed list read is not rendered as an empty history | `RateHistoryCoverage.test.tsx` | unit |
| a response for a previous currency never renders | `RateHistoryCoverage.test.tsx` | unit |
| each fill outcome reaches the reader as its own message | `RateHistoryCoverage.test.tsx` | unit |

## 12. Decisions

| # | Question | Answer |
|---|---|---|
| 1 | Does the button still mean "one more year"? | No. It fills the gaps over the span the currency is used. |
| 2 | What defines a gap? | Unresolvable under the 45-day carry-forward bound, not "a day with no row". |
| 3 | Do closed accounts count towards first use? | Yes. Historical reports cover the years they were open. |
| 4 | How deep may one provider request go? | 365 days, or the bars stop being daily. |
| 5 | Is the whole span filled in one press? | No. A bounded number of windows, with the remainder reported. |
| 6 | Where does the list render? | The dedicated rate history dialog only, not the currency edit form. |
| 7 | Which row wins when a date is held in both orientations? | The canonical one, matching the pending contract migration. |
| 8 | Where is the provider's floor remembered? | On `currencies`, with the counter-currency it was established against. Process memory alone lost it on every restart. |
| 9 | Does a known-empty window count against the budget? | No. It cannot be filled, so it would starve the windows that can. |
