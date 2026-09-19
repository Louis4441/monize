# Backend: securities, prices and outbound providers

What a stored price row means, daily-series integrity, history depth, and how every outbound provider call goes through the circuit breaker and is logged once. Read this before touching `src/securities/`, a price writer or any `fetch` to a third party.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## A stored price says which session it belongs to, not which minute it was fetched

`security_prices` holds one row per trading day, and that row is the **session**: official close, full-day volume, high/low, adjusted close. A live quote (`regularMarketPrice`) is a true statement about 14:42 and a false one about the day -- and the frontend auto-refreshes quotes through the session (`usePriceRefresh`), so a row for today exists long before the day is over. Three rules, each with a test:

- **"Has a price for today" is not "the day is settled".** Ask whether the *session* has ended -- `isSessionSettled` (`providers/settled-bar.util.ts`), on the market's own clock in the market's own zone, from the stored `market_timezone` / `market_close_time`. Never from the presence of a row or the server's clock.
- **The closing job settles the day from the daily bar, after the quote refresh.** `settleDailyBars` re-reads a bounded recent window and upserts the bars whose sessions have ended, so a missed run or provider outage repairs itself. The quote is what a still-open market can offer; the bar is what the finished session did, and the bar wins.
- **A calculated column needs a writer on the recurring path.** `adjusted_close` was populated only by the on-demand backfill, and because `loadPriceSeries` picks one basis per series and keeps only adjusted rows, that silently truncated every return series at the last backfill date. The quote path fills `adjusted_close` with the close it is writing -- definitional for the newest session (adjustment factor 1), but only where the series already carries an adjusted close; both conditions live in the `CASE ... EXISTS` inside the statement (an MSN-priced series given exactly one adjusted close flips `bool_or(...)` and collapses to that row).

A daily bar is not a quote, so settling clears `quoted_at`; and a `source = 'manual'` row is a user correction no provider write may overwrite -- the quote path and `bulkUpsertPrices` both carry `WHERE security_prices.source IS DISTINCT FROM 'manual'`, and the quote path treats the refusal as a successful no-op that reads back the winning row. The honest cost: a manual row on a provider-priced security has no adjusted close, so that day stays out of the adjusted series.

Related: **a bar's timestamp is the instant its session opened, so the day it belongs to is the exchange's calendar day.** `barDate` reads it in `meta.exchangeTimezoneName`, falling back to UTC; `setHours(0,0,0,0)` made `price_date` a function of the container's timezone.

## A price is a number in a currency, and only one side of that reaches the row

`security_prices` stores the number; the currency it is read in is
`securities.currency_code`. So the two have to be checked against each other
before the write, or a provider that answered about *another listing of the same
ticker* -- the LSE line of a US stock, a GBP share class of a USD fund -- writes
numbers understated by the exchange rate on every row, with nothing in the stored
series to show it. The exchange is not the answer either: a USD-denominated ETF
on the LSE is exactly the case an exchange guess gets wrong, which is why
`QuoteResult.currencyCode` exists and is read from the instrument.

**The comparison is one function.** `verifyProviderCurrency`
(`providers/quote-currency.util.ts`) normalizes both sides with
`normalizeQuoteCurrency` -- trim, upper-case, GBX/GBp to GBP -- and returns
accepted-and-verified, accepted-but-unverified, or refused.
`SecurityPriceService.refuseForeignCurrency` is the only caller shape: it returns
the `tr()` message to report, or `null` to proceed. Normalization is a comparison
and not a second conversion: both providers already divide pence into pounds
(`convertGbxToGbp`) before returning bars, so the function is idempotent and
"GBP" in gives "GBP" out.

**A historical payload carries its own metadata, because an array cannot.**
`fetchHistoricalSeries` (and the optional `fetchHistoricalWindowSeries`) return a
`HistoricalSeries` -- `prices` plus the `currencyCode`, provider symbol and
exchange the provider named -- and that is what every path writing into
`security_prices` calls. Yahoo's and MSN's `fetchHistorical` survive as
prices-only wrappers for the two callers that have no security to verify against:
the FX pair series and the market-index series. The bundle preserves the
load-bearing distinction the callers already depended on: `null` is no answer,
an empty `prices` is an answer with no bars.

**Where the check runs, and why it is not one place.** The shared acceptance
points are `fetchQuoteWithFallback` and `fetchHistoricalWithFallback`, where a
provider whose currency disagrees is *passed over* rather than accepted -- the
next provider gets its turn and faces the same check, and the last refusal is
what the caller reports. `fillPriceWindow` reaches `bulkUpsertPrices` through
neither, so it is an acceptance point of its own. And the group paths --
`refreshAllPricesGlobally`, `backfillHistoricalPrices`, `settleDailyBarsGlobally`
-- fetch once for a representative and write for every security sharing its
symbol and exchange, while `groupKey` holds no currency: a second user's row for
the same ticker can be recorded in a different currency and only one of them can
be right about the answer. So the check runs again per security immediately
before each `savePriceData` and `bulkUpsertPrices`, quietly (the fetch path has
already logged what it had to say).

**A group fetch is judged on the group, never on its representative.** The three
group paths pass the whole group into `fetchQuoteWithFallback` /
`fetchHistoricalWithFallback`, which accept the answer as soon as *one* member
could store it (`acceptedBySomeMember`). Judging the fetch on the representative
alone meant one user's mis-recorded currency marked every other holder of that
ticker failed, although the answer was storable for all but one of them. The
per-security check at the write is what decides who gets the answer; the fetch
only decides whether to keep looking for a provider.

**Unverifiable is accepted with a warning, and that is a decision, not an
oversight.** MSN's chart series reports no currency at all, so refusing every
silent provider would leave MSN-priced securities with no prices; the same goes
for a security with no recorded currency. Those store with a logged warning. What
this does not buy is auditability of what is already stored: a price row does not
record the currency it was written in, so rows written before this check cannot
be told apart from the database. That would be a column on `security_prices` and
a migration.

`fetchAuthoritativeCurrency`, which corrects the exchange-guessed currency at
security-create time, reads the same `normalizeQuoteCurrency`, so the currency a
security is created with is comparable letter for letter with the one every later
answer is measured against. INV-PRICE-001.

## A payload coarser than daily is a different series, not a sparse one

A provider asked for a long range may answer weekly or monthly bars; written into a daily table they overwrite the real daily rows on those dates, and under the one-basis-per-series rule monthly rows carrying adjusted closes made `loadPriceSeries` *drop every daily row around them*. `assertDailySeries` (`providers/daily-spacing.util.ts`) is the one test, and it runs inside `bulkUpsertPrices` -- not in its four callers, because a guard one caller forgets is not a guard (each caller already reports a failed security, so the throw surfaces as "this one did not update"). The threshold, the median (never the mean -- one long exchange closure must not make a daily series look weekly) and the minimum sample size live there too; `daily-spacing.util.spec.ts` fails on a second copy of any of them under `securities/`.

## History depth is a request, not a property of the holding

`backfillSecurityHoldingPeriod` clips its write to the first transaction date -- right for position valuation, wrong for backtests, the GEM report and performance comparison, which need prices from before the user bought. Both backfill endpoints take `range` (`BackfillPricesQueryDto`); supplying it means fetch that range **and** store all of it, omitting it keeps the clipped default. When adding a caller, decide which question it asks -- "what is this position worth over the time I held it" or "what did this instrument do" -- rather than reaching for `max`; the clip exists so an untouched catalogue does not accumulate decades of prices nobody reads.

## FX history depth is extended a year at a time, from the currency the reader is looking at

The stored history of a currency pair usually begins on the day the daily refresh first ran: `ExchangeRateService.backfillHistoricalRates` skips any pair that already holds a row, and the cron writes today. Every report dated before that then reports a missing rate, correctly and permanently, and nothing on any screen let a non-admin do something about it.

`ExchangeRateHistoryService` (`src/currencies/exchange-rate-history.service.ts`) is that door, and it is deliberately small. `GET /currencies/exchange-rates/coverage?code=EUR` answers what is stored -- `earliestDate`, `latestDate` and the number of calendar days covered, counting **both stored directions as the one pair they are**, because a fetch is persisted forwards and inverted in the same statement. `POST /currencies/exchange-rates/extend-history` fetches `[earliest - 1 year, earliest - 1 day]` and stores it, or the year ending yesterday when the pair has no rows at all.

Four things about it are load-bearing:

- **The unit is one calendar year, not 365 days, and not "as far back as possible".** A person asking for more history has no way to name a useful range, and an unbounded fetch is an unbounded provider call whose failure mode is a rate limit for everybody. `oneYearEarlierYMD` clamps February 29 to February 28 rather than letting it roll into March 1: the next extension starts from the *stored* earliest date, so a window that overshot would leave a gap nothing ever fills.
- **The pair is the request's code against the caller's own reporting currency**, resolved on the server (`resolveUserDefaultCurrency`). A request cannot name a pair, and the same-currency case is a 400 rather than a fetch, because 1 is not a stored rate.
- **A provider that answered with nothing and a provider that did not answer are two different outcomes.** The first is a 200 with `stored: 0` and the client says there is no older data; the second is a `ServiceUnavailableException` and the client says to try later. This is `fillRateWindow`'s `{ stored, answered }` reaching a user-facing surface, for the reason the breaker section below gives: only the code that made the call knows which happened.
- **The provider call is `ExchangeRateService.fillRateWindow`, made public rather than copied.** One place asks Yahoo for a rate window, tries the reverse symbol and persists both directions. Correctness when two extensions race is the existing `ON CONFLICT (from_currency, to_currency, rate_date)` upsert (mechanism 4 of `docs/concurrency-and-idempotency.md`); the in-flight promise map beside it is a coalescer for a double-clicked button, in the same category as `EmptyWindowMemory`, and is documented as gating nothing.

The route is not admin-only, unlike the deployment-wide backfill: the write is bounded to one pair and one year, and `exchange_rates` is shared reference data with no owner column, so the user id goes in the log line rather than in the row. The client half is `frontend/src/components/currencies/RateHistoryCoverage.tsx`, a section of the currency dialog rendered outside its `<form>` so extending history cannot mark the form dirty.

## An outbound provider is called through a breaker, and a failed call is logged once, with its cause

`fetch` rejects with `TypeError: fetch failed` for DNS, TLS, a refused connection, a proxy hangup and an `AbortSignal.timeout` alike, and puts the discriminating detail in `error.cause`. Logging `error.message` -- or worse `error.stack`, whose frames are all undici's -- produced issue #1265: thousands of identical lines, no cause in any of them, an unusable UI, and a container restarting into the same storm because the start-up market-index warm-up ignored its own cooldown.

So: **`describeFetchFailure`** (`common/http/fetch-failure.util.ts`) turns a caught error into one bounded line naming the cause chain and the socket fields; **`ProviderHealthService`** (`provider-health/`) owns the per-provider circuit breaker, the rate-limited failure log (`logFailure` -- silent for a call the breaker refused, and it reports what it suppressed), and the durable `provider_health` row the alert cron reads. Call `assertAvailable` (throws) or `tryRequest` (returns `"refused"`) **before** any queue or semaphore, `recordSuccess` on any response (a 404 proves the host answered), `recordFailure` on a rejection, and `logFailure` in the catch -- which counts as well as prints, because a request can fail *after* its headers arrived (a stalled body) and those never reach the fetch helper's own catch. One throw counts once however many doors see it. Both gates report which kind of admission they granted, and only a `"probe"` holder owns the exclusive half-open slot -- a straggler that releases one it never held frees somebody else's probe. A probe holder owes an outcome -- `recordSuccess`, `recordFailure`, or `releaseProbe` when the attempt never reached the provider's own host (the Yahoo crumb handshake gives up at the cookie step, whose hosts are not the API host: counting *that* as an answer kept the failure run oscillating and the breaker never opened). A probe that reports nothing holds the slot for two minutes, during which every call to that provider is refused with the provider healthy. `wouldRefuse` is the read-only predicate for deciding whether to *skip work*, never a gate. Where a `null` is cached as "no such thing", have the code that *made the call* report whether anyone answered (`fillPriceWindow`/`fillRateWindow` return `{ stored, answered }`) rather than interrogating the breakers afterwards -- it knows which providers it reached, where a breaker check is either too narrow (one provider, while the fill falls back to another) or too broad (any provider down anywhere disables the cache for everyone). Where the caller genuinely cannot report it, check that the provider actually answered -- a null from a refusal *or from a transport failure below the threshold* means "we did not get an answer", and caching it turns a two-minute outage into a day of poisoned lookups. And nothing here restricts Nest's log levels, so suppressing a line means not printing it at all: a `debug` line per refused call is the same flood one level quieter. Never log a provider failure from a `catch` yourself, and never pass `error.stack` as the diagnostic: `provider-health/provider-call.guard.spec.ts` fails on either, and on a new client under `src/securities/` or `src/payees/lookup/google-places/` that reaches `fetch` without the breaker. The email side -- one alert per outage episode, a 15-minute minimum and a 6-hour floor, all three claimed in SQL -- is `docs/specs/provider-outage-alerts.md`.

Two asymmetries are load-bearing. The breaker lives in **process memory** because it describes what this replica's own sockets did; only the episode start and the notification markers are shared, because only those must outlive a restart. And a **start-up** warm-up honours per-item fetch cooldowns while a **cron** ignores them: a schedule is the operator's request, a restart loop is not.

**Which statuses are an answer about a symbol, and which are a refusal, is a status question everywhere except 400, where it is a body question.** `YahooFinanceService` reads 404 and 422 as "there is no such series" and everything else -- 429, 5xx, 401 -- as the provider declining to answer, because only the first kind may be remembered as an empty window. A 400 is both at once: Yahoo refuses a window it has no history for with `chart.error.description` of `Data doesn't exist for startDate = ...`, which is a statement about this symbol over this window, and it refuses a request this client built wrong with the same status and a different description. `ABSENT_WINDOW_DESCRIPTION` is the one that decides; the body is read with `text()` rather than `readBody`, because `throttledFetch` has already recorded the non-OK response with the breaker. Reading the pair as one refusal is issue #1409: `USDCAD=X` carries nothing before December 2003, so `fillRateWindow` reported `answered: false` for every month of 2000-2003, `EmptyWindowMemory` could never be written for them, and each portfolio summary re-issued the same 76 doomed calls -- a loop with no convergence rather than a slow first load.

## A read may fetch the exchange rates it is short of, through one door, and re-read them

`ExchangeRateService.ensureRatesForDate(pairs, date)` is the only way a read path asks the provider for rate history it does not have. The daily refresh writes today only and `backfillHistoricalRates` skips a pair the moment it holds any row, so a report or a chart over a span nobody ever loaded names every figure incomplete for rates the provider has had all along -- this fetch is what closes that. Its unit is the calendar month around `date` (plus the boundary lead), persisted in both directions, with an empty month remembered for thirty minutes; it is best-effort, never throwing for a provider failure, and returns the number of observations stored.

Its callers are `accounts/account-balances-report.service.ts` (`ratesForReport`, for a point-in-time report -- `docs/specs/account-balances-as-of.md` section 7.1) and `net-worth/series-rate-fill.ts`, the shared planner for a *series*: `NetWorthService.getDailyInvestments` / `getInvestmentBreakdown` / `getMonthlyNetWorth` / `getMonthlyInvestments`, and `PortfolioPeriodResultService`. The series form turns the per-point `missingRatePairs` into `(month, directionless pair)` units, capped at `MAX_FILL_MONTHS`, and is opted out of with `fetchMissing: false` by anything that must not reach the network -- `getLlmHistory`, the AI assistant's and MCP's door, passes it, and so does `PortfolioService.getPortfolioSummary` for its since-inception result. That last one is not about the network being forbidden but about who is waiting: the window opens at the scope's first investment transaction, so a summary card drove a backfill over every month a twenty-six-year history had no stored rate for, inline, on a request a person was watching a spinner for (issue #1409). The summary already withholds a figure with its cause, so it reports the gap; filling it belongs to `ExchangeRateHistoryService` and the scheduled jobs. Every caller obeys the same two rules: what was fetched is **re-read from the database** rather than patched into the index it already holds, and a pair the provider does not carry stays missing with the figure withheld (INV-FX-001, `docs/time-series-contract.md` section 2.2).

## A day's market movement is a value difference minus the reader's own contributions, and it is decided once

`GET /portfolio/daily-movements` (`securities/daily-movement.service.ts`) reports `MV(d) - MV(d-1) - externalFlow(d)` per calendar day. Price-only is the plausible mistake and it is wrong twice over: a 1,000 deposit reads as a gain and a paid dividend reads as a loss, because in both cases the value moved for a reason the market did not supply. The measure, and the invariants behind it, were already decided for the daily notification (`docs/specs/portfolio-movement-notifications.md`); this endpoint reuses them rather than inventing a second answer to the same question.

What is shared, and why each one is a single writer:

- **Which rows are external flow** is `loadExternalFlowSubtotals` (`securities/external-flow.util.ts`), extracted from `PortfolioMovementAlertService`. Both callers pass their own scope and window; neither spells the predicate out. It uses `investmentLinkedTransactionExclusion` / `investmentLinkedSplitExclusion` rather than an action list (INV-REPORT-001, INV-PORTMOVE-006), and excludes a transfer whose counterparty is also in scope, because cash moved between two scoped accounts never crossed the boundary. `external-flow.util.spec.ts` pins the original statement verbatim: that literal is what proves the extraction changed no row. Both callers read it with `perDay: true` and convert each `(date, currency)` subtotal at **that date's** rate; a whole window folded at the run day's rate reports the FX move between the two dates as a market return (INV-PORTMOVE-007).
- **When today's valuation was actually struck** is `PortfolioService.getLatestPriceObservations`, the dated form of the `DISTINCT ON (security_id)` read that `getLatestPrices` already ran (which is now derived from it, so the two cannot name different rows). A consumer asking "is this figure evidence about the period I am measuring, or a close carried forward from before it" reads that date rather than issuing a second query, which would be a second merge rule. The daily movement notification withholds on a carried close (INV-PORTMOVE-008, `notification-center/portfolio-price-freshness.util.ts`); valuation itself keeps carrying it forward, which is correct.
- **Which accounts are in scope** is `resolveInvestmentScopeAccountIds` (`securities/investment-scope.util.ts`). A brokerage and its cash sleeve are one portfolio wearing two rows, so a filter naming either means both. `NetWorthService` held three copies of that widening; they now read the one helper.
- **What priced a position on a day** is `positionClosePointAsOf` (`net-worth/position-price.util.ts`), the same merge of the accepted store and the legacy transaction series that valuation uses, now also returning the date the close was struck on. That date is the whole trading-day question: a carried close moved nothing, so a day on which no HELD security struck a close is **blank** -- a third state, not an unknown, and the one the reader has nothing to fix about.
- **Whether the figure may be reported at all** is `decideDailyMovement` (`securities/daily-movement.util.ts`), a pure function table-tested against the design's truth table B. A change needs two complete values of two different observations plus a convertible flow; the client reads `complete` and `reasons` and re-derives no row of that table.

Two subtleties the shapes encode. A **zero baseline** yields no percentage but a known movement, so `movement` survives with `complete: false` -- the cell stays blank, the day panel may show the figure. And the detail endpoint's **`remainder`** (the move no per-security close explains: a dividend, a position first priced that day, cash interest) is `null` whenever any component is unknown, because a remainder computed from a subtotal is a reconciliation that reconciles nothing.

## The portfolio summary is computed once per user, scope and minute, and forgotten where it stops being true

`PortfolioService.getPortfolioSummary` is the most expensive read in the application: live FX priming, a per-holding cost-basis replay, and a day-by-day since-inception result. Opening the Investments page issued three requests that each needed it -- `GET /portfolio/summary`, `GET /portfolio/allocation/by-tag` and `GET /portfolio/tag-keys` -- and they start together, so the server computed the same valuation three times concurrently.

`backend/src/securities/portfolio-summary-memo.ts` holds it. The key is `userId | sorted accountIds (or "all") | reporting currency | ambient identity`. Every input that changes the answer is part of the key rather than a reason to bypass the memo: a display currency that is not the preference is a different key, not a fresh computation; the ambient identity is in the key because a delegate reads the owner's accounts under the delegate's RLS identity, and the answer it computes is not necessarily the answer the owner's own request would compute. The reporting currency is therefore resolved before the memo, from the same `preferredCurrency(pref)` read the computation used to do first.

The entry holds the **in-flight promise**, not only the settled value: that is what makes three simultaneous requests await one computation rather than start three. A rejection is never remembered -- the entry is dropped so the next caller recomputes instead of inheriting a failure for a minute. Entries expire 60 s after the computation **settles** (`PORTFOLIO_SUMMARY_MEMO_TTL_MS`, the same window the intraday price cache in the same service uses) and the map is bounded at 256 entries, evicting the oldest first. The TTL runs from the answer, not from the start of the work: stamped at the start, a 48 s valuation was servable for 12 s and the next page open paid for the whole walk again (issue #1409). An in-flight entry has no expiry at all, so every caller that arrives during a long computation shares it; an invalidation that lands while it runs drops it, and the settling value does not put it back.

It is wrapped at the service boundary, so the controller, `loadTaggedAllocationInputs`, the security detail page, Monte Carlo and the AI / MCP `get_portfolio_summary` tool all share one answer without knowing the memo exists.

`invalidatePortfolioSummary(userId)` is called wherever a memoized valuation stops being true:

| Seam | Where |
|---|---|
| Any money-moving write, after it commits | `NetWorthService.triggerDebouncedRecalc` and `recalculateAccount` (INV-CACHE-001) -- immediately, not on the debounce timer |
| A provider quote or a historical bar | `SecurityPriceService.savePriceData` and `bulkUpsertPrices`, which between them carry refresh, refresh/selected, daily settlement and every backfill |
| A manual price create, update or delete | `SecurityPriceService.scheduleSnapshotRecalc`, which also covers a security no account holds |
| The transaction-price maintenance pass | `backfillTransactionPrices`, whole memo: there is no single owner |
| A backup restore, a demo reset, an undo or a redo | `BackupRestoreService.restoreData`, `DemoResetService.performDemoReset`, `ActionHistoryService.undo` / `redo` |

**The memo is process memory; its invalidation is not.** The entries are per replica, so N replicas cost N computations of the same summary -- that is the bargain, and it is the same one the intraday cache next door makes. What is *not* on offer is a stale answer after a write: an invalidation is announced on the `EVENT_BUS` (`PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL`, wired by `PortfolioSummaryInvalidationBridge`) and every replica drops the user's entries. Without it, a write served by pod A left pod B answering from its own memo for up to 60 s, and a load balancer with no affinity sends the next read there: the Investments page showed the portfolio as it was before the trade the person had just entered. The `CLUSTER_MODE=multi` E2E shard caught that (issue #1409); `docs/system-invariants.md` INV-CACHE-001 carries the rule.

**The announcement is a hint, and the TTL is still the bound.** `NOTIFY` can be lost -- a replica whose `LISTEN` connection is reconnecting misses everything sent while it was away -- so a dropped message leaves that replica's entry alive until it expires, exactly as before the channel existed. The payload is a user id and nothing else: the recipient drops a cache and recomputes from the database under its own scope, which is the only response `common/events/event-bus.interface.ts` permits to a wake-up. The announcement is made immediately after the local drop and is never awaited: a bus that is down must cost the request nothing. It therefore rides exactly the same seam, with exactly the same timing, as the drop it mirrors -- including the callers that invalidate from inside their own transaction, where both are made a moment before the commit is visible. That window is the seam's and predates this channel; what the channel changes is that the other replicas are now in it too, rather than outside it for a minute.

`getPortfolioTagSummary` is the one caller that was removed rather than memoized. Which tags the held securities carry is a question about `holdings`, `securities`, `security_tags` and `tags` -- no price, no rate, no cost basis -- so it is one scoped query under the valuation's own held predicate (`ABS(quantity) >= 0.0001`). It reports `keys` (the distinct KEY:VALUE namespaces) and `hasTaggedHoldings` separately, because a portfolio tagged only with plain labels has no keys and still has a by-tag grouping worth offering. It is also more honest than the path it replaces: the valuation-based one dropped an unpriced or unconvertible holding's slice from the allocation, so a late price feed silently removed a tag key from the switcher.
