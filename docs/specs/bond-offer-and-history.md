# Spec: bonds on sale and the history of their terms

Status: requested by the owner on 2026-10-11 (WMP/monize#24), to be built in
the same PR as `polish-retail-bonds.md` and `bond-series-fetch.md`.

## 1. Goal

Two read-only views over the bond catalog:

1. **On sale**: every series that can be bought today, side by side, with its
   terms and with what 100 of face value is worth at maturity under stated
   assumptions, so a reader can compare products of different lengths.
2. **History**: for each product, how the per-series terms (first-period rate,
   margin or spread, early redemption fee) changed from one sale month to the
   next.

Both read only stored reference data and the engine; neither writes, and
neither fetches from a provider on the request path (the catalog is filled by
the daily offer cron and the backfill of section 4).

## 2. On sale

`GET /bonds/offer?countryCode=PL[&assume=<benchmarkId>:<fraction>,...]`,
any authenticated user. A series is on sale when today (the user's financial
today) lies inside its stored `saleWindow`. Per series, newest terms version:

```text
instrumentId, issuerCountryCode, issuerCode, programCode, seriesCode, currency
saleWindow       { from, to }
periodMonths, periodCount            length = periodMonths x periodCount
rateRule         the description of polish-retail-bonds.md 2.6 (type,
                 benchmarkId, first-period rate or annual rate, addend, floor)
capitalization   NONE | COMPOUND_AT_PERIOD_END
redemption       the terms' redemption policy (window, penalties, floor) | null
termsSource      { provider, url, document }
projection       the valuation of one bond bought today, held to maturity:
  maturityValue        per bond | null, plus every coupon of a coupon bond
                       (the total cash received, not reinvested)
  totalReturn          (cash received - face value) / face value | null
  annualizedReturn     the yearly rate r with (1 + r)^years = cash / face,
                       years = periodMonths x periodCount / 12, to 4 places
                       | null
  projected            true when any period's rate is assumed
  assumptions          [{ benchmarkId, value, basis: SUPPLIED | LATEST_OBSERVATION }]
  projectionMissing    as in polish-retail-bonds.md 2.6
```

The projection is computed by the engine's own `valueBondLot` on a lot of
quantity 1 dated today, with the same assumption rules as the scenarios
(polish-retail-bonds.md 13.3): an assumption replaces only future periods,
known periods stay known, and without an assumption the latest observation is
used and labelled. Coupons of a coupon bond are summed from the lot's cash
flows, not reinvested; the column says "coupons not reinvested".
`annualizedReturn` is found by bisection on exact decimals (no floating
point), stopped at 4 places; it is a comparison figure, labelled as such.

The figures are null when the engine cannot value the lot, never a guess;
`projectionMissing` says why.

## 3. History

`GET /bonds/history?countryCode=PL&programCode=EDO` (programCode optional),
any authenticated user. Every stored series of the program, ordered by the
start of its sale window:

```text
seriesCode, saleWindow { from, to }, firstPeriodRate | annualRate, addend,
fee (FIXED_FEE_PER_UNIT amount | null), proceedsFloor appliesTo | null,
termsVersion, termsSource
```

The history is as complete as the catalog: the response carries
`coverage: { from: YYYY-MM | null, to: YYYY-MM | null, missingMonths: [YYYY-MM] }`
for the program, so the view says which months are absent instead of drawing
a line across them.

## 4. Backfill

A one-off backfill, run by the offer cron, fills the catalog from the earliest
month the adapter's templates are validated for (Poland: `2024-01`) to the
current month: for each product and sale month it derives the series code
(`bond-series-fetch.md` 4.1) and fetches every series that is not stored.
It runs under the same `FetchSyncService` lease as the offer cron, at most one
request every 3 seconds, stops for the day on the first
`SOURCE_UNAVAILABLE`, and resumes the next day where it stopped (it only ever
asks for series that are not stored, so a rerun is idempotent). A series the
source does not publish (`SERIES_NOT_PUBLISHED`, a product not sold that
month) is shown by the history as a missing month and asked for again on the
next run; there are few of them, so no table records them (no migration).

## 5. Views

Under Investments, a page "Treasury bonds" with two tabs.

- **On sale**: one row per series with the section 2 columns; assumption
  inputs for each benchmark the rows read (CPI, reference rate), prefilled
  with the latest observation and its month; sorting by annualized return,
  length or first-period rate; a "projected" badge on any figure that rests on
  an assumption; the letter link; an action "add to my portfolio" that opens
  the security form with the series selected.
- **History**: a product selector; a line chart per sale month of the
  first-period rate and the margin or spread (percent), and a step chart of the
  fee; a table below with every series; missing months shown as gaps and
  listed.

Every figure is localized by the reader's number preference; every string is
translated in every locale.

## 6. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| On sale | unit | a series inside, before and after its window; newest version used; projection equals the engine's maturity value of a 1-bond lot; coupon bond sums coupons; annualized return of E1 (TOS 4.40% for 3 years compounding) is 0.0440; null figures with projectionMissing when no observation and no assumption |
| On sale | integration | owner-agnostic read of reference data; `assume` parsing reuses the scenario pipe |
| History | unit | ordering by sale window; fee and floor per series; coverage and missing months |
| Backfill | unit | derives codes per product and month from validFrom; skips stored series; one request per 3 s; stops on SOURCE_UNAVAILABLE |
| Backfill | integration | a rerun after a complete run fetches nothing |
| Views | unit | sorting, projected badge, assumption inputs re-query, gaps in the history chart, translations present |
