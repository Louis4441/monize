# Polish Retail Treasury Bonds (TOS, ROR, COI, EDO and four more)

Specification for the implementation of sovereign bond support proposed
in discussion kenlasko/monize#1650: a small generic bond domain, and the Polish
retail savings bonds as its first products (TOS, ROR, COI and EDO first;
OTS, DOR, ROS and ROD later in the same PR). Written
before the implementation, per `docs/financial-calculation-contract.md`
section 9. The plan and the task list are
`docs/future-plans/sovereign-bonds.md` and
`docs/future-plans/sovereign-bonds-tasks.md`.

Every product rule below is taken from the issue letters (*listy emisyjne*) of
the Minister of Finance for the October 2026 series, and each rule names its
paragraph. A rule that the letters do not state is marked **assumption** and
is listed in section 10.

| Series | Letter | Product |
| --- | --- | --- |
| `TOS1029` | List emisyjny nr 97/2026 of 21 September 2026 | 3-year, fixed rate, compounded |
| `ROR1027` | List emisyjny nr 95/2026 of 21 September 2026 | 1-year, NBP reference rate, monthly coupons |
| `COI1030` | List emisyjny nr 98/2026 of 21 September 2026 | 4-year, CPI-linked, annual coupons |
| `EDO1036` | List emisyjny nr 99/2026 of 21 September 2026 | 10-year, CPI-linked, compounded |

## 1. Scope

In scope for this PR (it carries phases 1 to 5 of the plan):

- the country-agnostic bond domain (section 2.0): instrument, versioned
  terms, rate, observation, principal, capitalization, accrual and
  redemption primitives, holding lot, cash flow, valuation;
- a calculation engine in exact decimal arithmetic;
- the Polish adapter: business-day calendar, benchmark definitions and the
  eight terms manifests (TOS1029, ROR1027, COI1030, EDO1036, OTS0127,
  DOR1028, ROS1032, ROD1038);
- persistence of instruments, terms versions, announced period rates and
  benchmark series and values in global, country-agnostic tables;
- fetchers for the NBP reference rate and the GUS CPI, run at boot and by a
  lease-guarded cron (section 9), and the seeded instrument catalog;
- linking a `securities` row to a bond instrument, lots derived from the
  user's transactions, and a daily `bond_engine` price (section 12);
- the read API, the detail view and its i18n (section 13).

Out of scope: a machine-readable source of the Ministry's announced period
rates (they are filled by hand); a projected value for a future `asOf`;
taxes; the IKE/IKZE fee waiver; the eligibility check of ROS and ROD; other
countries, and the primitives they need (indexed principal, day-count
conventions, market quotes, yields) (discussion section 38). Section 2.0 is
the rule that keeps them addable.

## 2. The model

### 2.0 Country-agnostic engine (binding rule)

The engine is one deterministic cash-flow engine for every country. It is
composed of financial **primitives** (rate rule, observation rule, principal
rule, capitalization, accrual, redemption policy, penalty, rounding), and it
never branches on a country, an issuer, a program or a product code. A
country is an **adapter**: data (terms manifests, benchmark definitions) and
a business-day calendar, registered by id. The Polish products in this
specification are four terms documents built only from primitives.

Adding a country is: a calendar, benchmark definitions, terms manifests and
golden tests. A new primitive (a new union member and one engine case) is
added only when an instrument has a new economic construction, for example
an inflation-indexed principal (`INDEX_RATIO`, US TIPS) or a day-count
convention (`ACT/365F`, `BUS/252`). The research note behind this rule is
the global sovereign bond study attached to discussion kenlasko/monize#1650,
sections 4 to 6, 11 and 19.

Two rules make this checkable:

- A source-scanning guard fails when a file of the domain or the engine
  imports an adapter or names a country or product literal.
- The terms parser refuses an unknown primitive with `UNSUPPORTED_PRIMITIVE`
  and the path of the field. An unknown calendar or benchmark id is not a
  parse error: the valuation reports it as missing data.

### 2.1 Instrument and terms

A **bond instrument** is one series (`TOS1029`), identified by
`(issuerCountryCode, issuerCode, seriesCode)`. Its **terms** are what its
issue document says. Terms are stored as an immutable, versioned document:
version 1 is what the document says at issue, and a correction is a new
version, never an edit. A valuation names the terms version it used.

The terms document (`schemaVersion` 1):

```text
instrument      { issuerCountryCode, issuerCode, programCode, seriesCode,
                  currency, marketability: RETAIL_REDEEMABLE, faceValue }
saleWindow      { from, to } | null
schedule        { anchor: LOT_PURCHASE_DATE, periodMonths, periodCount,
                  rollDay: ANCHOR_DAY_CLAMPED, calendarId }
accrual         { type: ACTUAL_DAYS_IN_PERIOD }
principalRule   { type: FIXED_NOMINAL }
rateRule        FIXED | BENCHMARK_PLUS_SPREAD | INFLATION_PLUS_MARGIN_AS_RATE
                (see 2.2)
capitalization  { type: NONE } | { type: COMPOUND_AT_PERIOD_END,
                                   baseRounding: PER_PERIOD | NONE }
redemption      { type: MATURITY_ONLY }
              | { type: ON_DEMAND, earliestDaysAfterPurchase,
                  latestDaysBeforeMaturity,
                  blackouts: [{ type: RECORD_DAY_BEFORE_COUPON, businessDays,
                                calendarId }],
                  penalties: [{ type: FIXED_FEE_PER_UNIT, amount }
                            | { type: FORFEIT_ACCRUED_SINCE_LAST_PAYMENT }],
                  proceedsFloor: { type: FACE_VALUE,
                                   appliesTo: ALL_PERIODS | FIRST_PERIOD } | null }
rounding        { moneyDecimals: 2, mode: HALF_UP }
source          { provider, url, document }
```

Every rate and amount is a decimal string, never a JSON number. Rates are
fractions (`"0.0440"` for 4.40%).

The four Polish series in this vocabulary:

| Field | TOS1029 | ROR1027 | COI1030 | EDO1036 |
| --- | --- | --- | --- | --- |
| `periodMonths` x `periodCount` | 12 x 3 | 1 x 12 | 12 x 4 | 12 x 10 |
| `rateRule` | `FIXED` 0.0440 | `BENCHMARK_PLUS_SPREAD` `PL_NBP_REFERENCE`, first 0.0400, spread 0, floor 0 | `INFLATION_PLUS_MARGIN_AS_RATE` `PL_CPI_GUS_YOY`, first 0.0475, margin 0.0150, floor 0 | same, first 0.0535, margin 0.0200, floor 0 |
| `observation` | -- | `STEP_VALUE_ON_NTH_BUSINESS_DAY_BEFORE_START_MONTH`, 10, `PL` | `MONTHLY_VALUE_MONTHS_BEFORE_START`, 2 | same |
| `capitalization` | `COMPOUND_AT_PERIOD_END`, `PER_PERIOD` | `NONE` | `NONE` | `COMPOUND_AT_PERIOD_END`, `NONE` |
| penalty | 1.00 | 0.50 | 2.00 | 3.00 |
| `proceedsFloor.appliesTo` | `ALL_PERIODS` | `FIRST_PERIOD` | `FIRST_PERIOD` | `ALL_PERIODS` |
| blackouts | none | record day, 5 | record day, 5 | none |

`FORFEIT_ACCRUED_SINCE_LAST_PAYMENT` was added for OTS: its letter (para 23,
points 3 and 4) pays the face value on early redemption and "no interest is
due". The penalty is the interest accrued since the period start, so the
proceeds are the period's base. This is the first primitive a product needed
after the engine was written; it changed the terms union, the parser and one
engine case, and nothing country-specific.

The other Polish series on sale in October 2026 use the same vocabulary:

| Field | OTS0127 | DOR1028 | ROS1032 | ROD1038 |
| --- | --- | --- | --- | --- |
| `periodMonths` x `periodCount` | 3 x 1 | 1 x 24 | 12 x 6 | 12 x 12 |
| `rateRule` | `FIXED` 0.0200 | `BENCHMARK_PLUS_SPREAD`, first 0.0415, spread 0.0015 | `INFLATION_PLUS_MARGIN_AS_RATE`, first 0.0500, margin 0.0200 | same, first 0.0560, margin 0.0250 |
| `capitalization` | `NONE` | `NONE` | `COMPOUND_AT_PERIOD_END`, `NONE` | `COMPOUND_AT_PERIOD_END`, `NONE` |
| penalties | `FORFEIT_ACCRUED_SINCE_LAST_PAYMENT` | 0.70 | 2.00 | 3.00 |
| `proceedsFloor.appliesTo` | -- | `FIRST_PERIOD` | `ALL_PERIODS` | `ALL_PERIODS` |

ROS and ROD are sold only to holders of the 800+ benefit; eligibility is not
modelled. Letters: OTS nr 94/2026, DOR nr 96/2026, ROS nr 100/2026, ROD nr
101/2026, all of 21 September 2026.

### 2.1.1 One accrual formula

With `F = 12 / periodMonths`, the interest a base `B` accrues in a period at
annual rate `r` after `a` of its `D` days is `B r a / (D F)`. This is the
formula of every Polish letter: ROR annex 2 (`F = 12`), and COI annex 3, TOS
annex 2 and EDO annex 3 (`F = 1`, `D = ACT`). A full-period coupon is
`round(B r / F)` (COI annex 2: `N r`), and the compounded value at maturity is
`round(N prod(1 + r_i / F))`.

### 2.2 Rate rules

| Rule | Products | Rate of period k |
| --- | --- | --- |
| `FIXED` | TOS | `annualRate` for every period (TOS letter, para 14) |
| `BENCHMARK_PLUS_SPREAD` | ROR | k = 1: `firstPeriodRate`; k >= 2: `max(0, NBP) + spread` (ROR letter, para 15, 16, annex 1) |
| `INFLATION_PLUS_MARGIN_AS_RATE` | COI, EDO | k = 1: `firstPeriodRate`; k >= 2: `max(0, CPI) + margin` (COI letter, para 15 to 17; EDO letter, para 15 to 17, annex 1) |

Observation rules (generic primitive, then the Polish use of it):

- `STEP_VALUE_ON_NTH_BUSINESS_DAY_BEFORE_START_MONTH` reads a `STEP`
  benchmark (a value in force from its effective date) on the n-th business
  day, in the named calendar, before the first day of the calendar month in
  which the period starts. `MONTHLY_VALUE_MONTHS_BEFORE_START` reads a
  `MONTHLY` benchmark at the reference month `startMonth - months`.
- **NBP** (`PL_NBP_REFERENCE`): the reference rate in force on the 10th
  business day before the first day of the calendar month in which period k
  starts (ROR letter, para 16). A business day excludes Saturdays, Sundays
  and Polish statutory holidays (para 29, 31). The rate in force on a day is the
  newest change effective on or before that day.
- **CPI** (`PL_CPI_GUS_YOY`): the 12-month CPI change announced by GUS in the
  month before the first month of period k (COI and EDO letters, para 16).
  **Assumption:** this is the final figure for the month two months before the
  period starts (a period starting in October uses August). The engine looks
  up the reference month `startMonth - 2`.

**An announced rate wins.** The Ministry announces each period's rate before
the period starts, and "the announced rate does not change" (para 17 / 18).
When an announced rate for (series, period) is stored, the engine uses it.
Otherwise it derives the rate from the stored observation. The valuation says
which (`rateSource`: `TERMS`, `ANNOUNCED`, `DERIVED`, `PROJECTED`).

### 2.3 Periods

Periods are anchored on the purchase date of the lot, not on the series
(EDO para 14: interest accrues "from the day of sale"). Period k starts at
`addMonthsClamped(purchaseDate, (k - 1) * periodMonths)` and ends at
`addMonthsClamped(purchaseDate, k * periodMonths)`, where the day of month is
`min(purchaseDay, daysInMonth)` and is always computed from the purchase
date, never from the previous period end. The ROR letter, annex 3, is the
truth table for this rule (31.10.2026 gives 30.11, 31.12, 31.01, 28.02, 31.03,
30.04). Maturity is the end of the last period.

`ACT` / `D` is the actual number of days in the period, start inclusive, end
exclusive. `a` is the number of days from the period start inclusive to the
calculation day `d` exclusive.

### 2.4 Amounts per bond

All amounts are computed for **one bond** and rounded to 0.01 PLN where the
letter rounds, then multiplied by the lot quantity. Rounding is half-up
(**assumption**: the letters say "rounded to two decimal places" and name no
mode).

| Product | Interest of period k | Value at maturity | Early redemption on day d in period k |
| --- | --- | --- | --- |
| TOS | compounded, not paid | `W = round(N (1+r)^3)` (annex 1) | `WP = round(N_{k-1} (1 + r a / ACT) - b)`, `N_{k-1} = round(N (1+r)^{k-1})`, floor 100 in every period (annex 2) |
| EDO | compounded, not paid | `W = round(N prod(1 + r_i))` (annex 2) | `WP = round(N prod_{i<k}(1 + r_i) (1 + r_k a / ACT) - b)`, no intermediate rounding, floor 100 in every period (annex 3) |
| COI | `O = round(N r_k)`, paid on the period end (annex 2, para 19) | `N` plus the last coupon | `WP = round(N (1 + r a / ACT) - b)`, floor 100 in period 1 only (annex 3) |
| ROR | `O = round(N r a / (D F))`, `F = 12`, paid on the period end (annex 2, para 20) | `N` plus the last coupon | `WP = round(N (1 + r a / (D F)) - b)`, floor 100 in period 1 only (annex 4) |

`b` is the early redemption fee: TOS 1.00, ROR 0.50, COI 2.00, EDO 3.00
(para 24 / 26 of each letter). In TOS and EDO, and in the first period of ROR
and COI, the fee is capped at the accrued interest; the floor of 100 is that
cap. From period 2, ROR and COI deduct the full fee, so the value can be below
the face value.

`compoundBaseRounding` is `PER_PERIOD` for TOS (annex 2 rounds `N_{k-1}`) and
`NONE` for EDO (annex 3 rounds only the result).

### 2.5 Early redemption window

A request is possible from 7 calendar days after the purchase date to 20
calendar days before maturity (para 21 / 23 / 25). ROR and COI also exclude
the record day (the 5th business day before a coupon date). Outside the
window `earlyRedemptionValue` is `null` and `earlyRedemptionRefusal` names the
rule. The engine values the request as if `d` were the calculation day; the
five-business-day settlement lag (para 26) is out of scope.

### 2.6 Valuation of a lot

Input: the issue, its terms version, the announced rates, the reference
observations, the lot (`purchaseDate`, `quantity`), `asOf`, and an optional
projection assumption (`cpiYoY`, `nbpReference`). Output:

```text
asOf, seriesCode, termsVersion, quantity
currentPeriod      { index, start, end, annualRate, rateSource } | null
rateRule           the terms' rate rule as stated: type, benchmarkId, the
                   first-period rate, the margin or spread, the benchmark floor
rateSchedule       one entry per period: { index, start, end, annualRate | null,
                   rateSource | null, benchmark: { benchmarkId, observation,
                   value | null, flooredValue | null } | null, addend | null }
                   -- the observation the rule reads for that period, the
                   value found (or assumed, when PROJECTED), the value after
                   the floor, and the margin or spread added to it
principal          per-bond compounded base at the start of the period | null
accruedInterest    lot | null: grossValue - faceValue x quantity, i.e. all
                   capitalized interest plus the current accrual for a
                   compounding bond, and the current period's accrual for a
                   coupon bond
grossValue         lot, principal + accrued interest, no fee | null
earlyRedemptionValue  lot | null, earlyRedemptionRefusal
knownCashflows     [{ date, type: INTEREST | PRINCIPAL, amount, status: KNOWN }]
projectedCashflows [{ ..., status: PROJECTED }]
maturityValueKnown     | null
maturityValueProjected | null
projectionAssumptions  [{ benchmarkId, value (fraction), basis: SUPPLIED | LATEST_OBSERVATION,
                        observation (YYYY-MM-DD or YYYY-MM; null when SUPPLIED) }]
dataCompleteness   { termsComplete, referenceDataComplete, earlyRedemptionTermsComplete }
missing            [{ benchmarkId, observation (YYYY-MM, or YYYY-MM-DD for a
                   step series), publisher | null }]  what to obtain, and
                   where; publisher is null only when the benchmark itself
                   is absent from the input
valuationComplete  all three flags true
```

## 3. Invariants

- **INV-BOND-001 Issue terms and announced rates are immutable.** A stored
  terms version and a stored announced rate are never updated or deleted; a
  correction is a new terms version. Mechanism: a `BEFORE UPDATE OR DELETE`
  trigger on both tables that raises.
- **INV-BOND-002 A missing rate is unknown, never substituted.** A period that
  has started and whose rate is neither in the terms, announced, nor derivable
  from the stored observation for its own month or day has no rate. The engine
  never uses another month's CPI, the latest NBP rate, 0 or the first-period
  rate in its place; values that depend on it are `null` and every such `null`
  is named in `missing` and makes `valuationComplete` false. A period that has
  not started is `PROJECTED` from a named assumption (supplied, else the
  newest stored observation, section 4), labelled as such, and never `KNOWN`.
- **INV-BOND-003 Money is exact until the letter rounds it.** The engine uses
  exact rational arithmetic (no JavaScript `number` on a money or rate path)
  and rounds only at the points section 2.4 names.
- **INV-BOND-004 Known and projected never mix.** A cash flow is `KNOWN` only
  when every rate it depends on is `TERMS`, `ANNOUNCED` or `DERIVED`.
  `maturityValueKnown` is `null` while any period rate is projected.

## 4. Truth table: rate of period k

| k | Announced rate stored | Observation stored | Period started (`start <= asOf`) | Rate | `rateSource` | Effect |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | any | any | any | `firstPeriodRate` / `annualRate` | `TERMS` | known |
| >= 2 | yes | any | any | announced | `ANNOUNCED` | known |
| >= 2 | no | yes | any | `max(0, obs) + margin` | `DERIVED` | known |
| >= 2 | no | no | yes | none | -- | values `null`, `referenceDataComplete = false`, `missing` names the observation |
| >= 2 | no | no | no | `max(0, assumption) + margin` | `PROJECTED` | projected; `null` if no assumption is given and no observation exists |

The default projection assumption is the newest stored observation of the
series, and the assumption names it as structured data, never a sentence
(`{ benchmarkId: "PL_CPI_GUS_YOY", value: "0.0290", basis:
"LATEST_OBSERVATION", observation: "2026-08" }`; a supplied assumption has
basis `SUPPLIED` and a null observation). The client composes the sentence from
its translated catalog and formats the percentage by the reader's number
preference.

## 5. Numerical examples

Each line is computed with exact fractions and rounded half-up. The
fixtures copy these values, never the implementation's output.

| # | Case | Inputs | Expected |
| --- | --- | --- | --- |
| E1 | TOS1029 maturity value | r = 4.40% | `N1 = 104.40`, `N2 = 108.99`, `W = 113.79` (equals TOS letter, para 14) |
| E2 | TOS1029 early, period 1 | purchase 2026-10-15, d = 2027-04-15, a = 182, ACT = 365 | `101.19` |
| E3 | TOS1029 early, period 1, below floor | purchase 2026-10-15, d = 2026-10-25, a = 10 | `99.12` -> `100.00` |
| E4 | TOS1029 early, period 2 | d = 2028-01-15, a = 92, ACT = 366 | `104.55` |
| E5 | EDO1036 early, period 1, below floor | purchase 2026-10-01, d = 2027-04-01, a = 182, ACT = 365 | `99.67` -> `100.00` |
| E6 | EDO1036 early, period 2 | r2 = 4.90% (hypothetical), d = 2028-04-01, a = 183, ACT = 366 | `104.93` |
| E7 | EDO1036 maturity | r1 = 5.35%, r2..r10 = 4.90% (hypothetical) | `162.04` |
| E8 | COI1030 coupon, period 1 | r1 = 4.75% | `4.75` |
| E9 | COI1030 early, period 1 | purchase 2026-10-15, d = 2027-01-15, a = 92, ACT = 365 | `99.20` -> `100.00` |
| E10 | COI1030 early, period 2, no floor | r2 = 4.40% (hypothetical), d = 2027-10-16, a = 1, ACT = 366 | `98.01` |
| E11 | ROR1027 coupon, period 1 | purchase 2026-10-31, period to 2026-11-30, D = 30, r = 4.00% | `0.33` |
| E12 | ROR1027 early, period 1 | d = 2026-11-15, a = 15 | `99.67` -> `100.00` |
| E13 | ROR1027 coupon, period 3 | 2026-12-31 to 2027-01-31, D = 31, r = 3.75% (hypothetical) | `0.31` |
| E14 | NBP observation day | period starts in November 2026 | 2026-10-19 |
| E15 | NBP observation day across holidays | period starts in January 2027 (24, 25, 26 Dec are holidays) | 2026-12-16 |
| E16 | Lot | E2 with quantity 25 | `2529.75` |

The golden fixtures of OTS, DOR, ROS and ROD (`backend/src/bonds/adapters/pl/`
`ots-cases.json`, `dor-cases.json`, `ros-cases.json`, `rod-cases.json`) are
not copies of E1 to E16 and were not taken from section 5 or from the
engine's output: each value was computed independently from the formulas of
the issue letters (OTS nr 94/2026, DOR nr 96/2026, ROS nr 100/2026, ROD nr
101/2026) with exact fractions, half-up. The values below are the same
computation, kept here so a fixture edited to match the engine is visible
against the letter formula:

| # | Case | Inputs | Expected |
| --- | --- | --- | --- |
| E17 | OTS0127 coupon and maturity value | purchase 2026-10-15, r = 2.00%, `F = 4` (letter para 14, 17) | coupon `100 x 0.02 / 4 = 0.50`; `W = 100.50` |
| E18 | OTS0127 early redemption | d = 2026-12-01, a = 47 (letter para 23 points 3 and 4) | accrued `0.2554` forfeited, proceeds `100.00` |
| E19 | DOR1028 coupon, period 1 | purchase 2026-10-15, r1 = 4.15%, `F = 12` | `100 x 0.0415 / 12 = 0.3458` -> `0.35` |
| E20 | ROS1032 maturity | r1 = 5.00%, r2..r6 = 3.40% CPI + 2.00% = 5.40% (hypothetical), no intermediate rounding | `136.58` |
| E21 | ROD1038 maturity | r1 = 5.60%, r2..r12 = 3.40% CPI + 2.50% = 5.90% (hypothetical) | `198.39` |
| E22 | Quantity | OTS0127 E18 with quantity 30 | `3000.00` |

The remaining fixture cases (window days 6, 7 and 20 days before maturity,
the DOR record day, early redemption of ROS and ROD) apply the same letter
formulas to the inputs their descriptions state.

## 6. Missing-data policy

- Missing terms version: the read service refuses with a `TERMS_NOT_FOUND`
  error whose `params` name the series. No valuation is produced.
- Errors and refusals reach a client as a code and `params`, never as an
  English sentence; the server maps each code to a translated message. The
  domain codes are `QUANTITY_INVALID`, `DATE_INVALID`, `AS_OF_BEFORE_PURCHASE`,
  `BENCHMARK_NOT_READ`, `INSTRUMENT_NOT_FOUND`, `TERMS_NOT_FOUND` and
  `TERMS_MISMATCH`. A lots refusal (`BondLotsRefusal`) is
  `{ code, detail, params: { action, date, quantity } }`; `detail` is for the
  log and is never shown.
- Every `null` figure caused by a missing observation is named in `missing`
  and makes `valuationComplete` false.
- A started period without a rate: section 4. `missing` names the series and
  the observation (`PL_CPI_GUS_YOY 2027-08`, or `PL_NBP_REFERENCE on
  2026-10-19`) and the publisher stored with the benchmark series (GUS, NBP).
- Coverage of a `STEP` benchmark (NBP): a day after the series' `covered_through` date is unknown, even
  if an older rate exists, because a newer change may not be stored yet.
- CPI: a reference month with no stored row is unknown. A negative value is
  stored as is and floored at 0 in the rate rule only.
- `asOf` before the purchase date: refused (`AS_OF_BEFORE_PURCHASE`).
  `asOf` on or after maturity: the lot is matured and early redemption is
  refused (`MATURED`). A matured coupon (non-compounding) lot has
  `principal = grossValue = faceValue x quantity` and `accruedInterest = 0`; it
  needs no rate, because its last coupon is a past cash flow paid on the
  maturity date and is no longer part of the holding's value
  (`maturityValueKnown` still shows face plus the last coupon, 105.00 for
  COI1030 period 4 at 5.00%, so a coupon lot's daily price falls from its
  accrued level to 100.00 on the maturity day, as it does after every coupon).
  A matured compounding lot has `grossValue = the maturity value` and needs
  every period's rate.

## 7. Persistence

Global reference data with no owner (RLS bucket: exempt, same rationale as
`exchange_rates` and `market_index_prices`):

| Table | Key | Mutability |
| --- | --- | --- |
| `bond_instruments` | `id`; unique `(issuer_country_code, issuer_code, series_code)` | insert only |
| `bond_terms_versions` | `(bond_instrument_id, version)`, with `content_hash` | immutable (INV-BOND-001) |
| `bond_period_rates` | `(bond_instrument_id, period_number)` | immutable (INV-BOND-001) |
| `benchmark_series` | `code`; `kind` `STEP` or `MONTHLY`, `publisher`, `unit`, `covered_through` | insert; `covered_through` moves forward |
| `benchmark_values` | `(benchmark_code, observation_date)` | insert, correction by update |

No table names a country or a product: a German, US or Japanese instrument is
a row in the same tables. The Polish data enters through the adapter, never
through the migration.

Rates are `NUMERIC(20,10)` (an exchange-rate-like quantity, not money); the
face value is `NUMERIC(20,4)`. All five tables are excluded from the user
backup: they are reference data a deployment re-fetches. A lot is not
stored: lots are derived from the user's transactions (section 12.2) and the
engine takes one as input.

## 8. Versioning and recomputation

A valuation is computed on read and is not stored, so there is nothing to
invalidate. A new terms version changes only valuations that ask for it; the
read service uses the newest version unless the caller names one. A new
announced rate or observation changes the next read.

## 9. Concurrency

The writers of the reference tables are `BondCatalogService` (seeds
instruments and terms versions at boot with `ON CONFLICT DO NOTHING`; the
immutability trigger makes a concurrent writer of the same terms version fail,
not overwrite) and `BenchmarkRefreshService` (NBP and GUS observations, under
the `bond-benchmarks` lease of `FetchSyncService`, at boot and by cron).
Benchmark freshness at boot is decided by the last successful fetch, not by
`covered_through`, which only records how far the data reaches.

The writer of prices is `BondPriceService` (`FetchSyncJob.BondPrices` lease for
the daily fan-out):

- recomputes of one security are serialized by a transaction-scoped advisory
  lock keyed on the security id, so two recomputes never interleave their
  read, upsert and delete;
- unlinking a security deletes that security's `bond_engine` rows in the same
  transaction as the unlink;
- a transaction-derived or manual price on a day always wins over a
  `bond_engine` row, whatever the write order (the upsert's `WHERE` admits only
  `source = 'bond_engine'`, and a `bond_engine` insert never replaces another
  source);
- a provider write re-checks the link at write time, inside its own
  transaction, and drops the price of a security that has become linked;
- a currency referenced by a bond instrument counts as in use, so the currency
  in-use check refuses its deletion.

## 10. Assumptions to confirm

1. Rounding mode is half-up (section 2.4).
2. The CPI used for a period starting in month M is the final figure for
   M - 2 (section 2.2).
3. "After seven calendar days" allows a request on `purchaseDate + 7`
   (section 2.5).
4. Polish statutory holidays include 24 December from 2025 on.

Each one is to be checked against a rate table or an early redemption
statement published by the Ministry or an issuing agent before the product
values are shown to a user.

## 11. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| Exact arithmetic | unit | parse, add, multiply, divide, half-up at `.xx5`, negative values, refusal of a non-decimal string |
| Period schedule | unit | ROR annex 3 rows for purchase days 1, 28, 29, 30, 31; leap year; maturity |
| Business days | unit | E14, E15, Easter-based holidays for 2026 and 2027 |
| Products | golden | E1 to E16 from a JSON fixture per product; for OTS, DOR, ROS and ROD the fixtures are computed from the letters (section 5, E17 to E22) |
| Missing data | unit | each row of section 4; `missing` content; matured coupon lot (principal = grossValue = face x quantity, accrued 0, no rate needed) and matured compounding lot (needs every rate); `asOf` before purchase |
| Error codes | unit | each domain error carries `code` and `params` (section 6), never a sentence; `BondLotsRefusal` has `code`, `detail`, `params` |
| Attribution (13.2) | unit | TOS 4.40 / 4.5936 / 4.79556; EDO period 2 split (E24); `benchmarkPart + addendPart = interest` for every benchmark period; each part `null` when the period's rate, or an earlier rate of a compounding bond, is unknown |
| Scenarios (13.3) | unit | E25: values -0.5 and 1.0 accepted (inclusive), 7 values and 1.0001 refused, a foreign benchmark refused with 400; known periods stay known; every figure `null` with a `refusal` when lots cannot be derived |
| Scenarios (13.3) | integration | route `/scenarios` and `assume=` on valuation, owner-scoped (another user's security answers 404) |
| Chart (13.4) | unit | cumulative interest ends at the rate schedule's total; projected periods flagged; no interest computed in the client |
| Window | unit | day 6 and 7 after purchase, 21 and 20 days before maturity, ROR record day |
| Terms parsing | unit | a valid document per Polish manifest; unknown field, number instead of string, unknown primitive (`UNSUPPORTED_PRIMITIVE`) refused; unknown calendar or benchmark id reported as missing data |
| Country-agnostic engine | guard | no domain or engine file imports an adapter or names a country or product literal (section 2.0) |
| Immutability | integration | update and delete of a terms version and of an announced rate raise |
| Read service | integration | loads the newest version, applies announced over derived, names the version |

## 12. Portfolio integration (phase 3)

### 12.1 Link

A user's `securities` row may point at one bond instrument through a nullable
`securities.bond_instrument_id` (`ON DELETE RESTRICT`). The link is refused
unless the security's currency equals the instrument's currency (INV-PRICE-001:
a stored price is in the currency the security is recorded in). A linked
security is never refreshed from a quote provider: the bond engine is its only
automatic price source (spec section 1 of the discussion: Yahoo and MSN are not
a source of retail bond terms or values).

`bond_instruments` is reference data excluded from the user backup and seeded
per deployment from the adapters' catalogs, so an instrument's id is
deterministic: a UUIDv5 of `issuerCountryCode|issuerCode|seriesCode`. A
restored link therefore points at the same instrument on any deployment
whose catalog has it; a restore onto a deployment without it restores the
link as `NULL` and says so, rather than failing the restore.

### 12.2 Lots

The lots of a linked security are derived from the user's investment
transactions on it, across all accounts, in register order, `VOID` rows
excluded:

| Action (base) | Effect |
| --- | --- |
| `BUY`, `REINVEST`, `ADD_SHARES` | a new lot dated `transaction_date` |
| `TRANSFER_IN` with a linked `TRANSFER_OUT` of the same security | none (the pair moves a lot between the user's accounts and keeps its purchase date) |
| `TRANSFER_IN` without a linked leg | a new lot dated `transaction_date`, flagged `purchaseDateAssumed` |
| `SELL`, `REDEEM`, `REMOVE_SHARES`, unlinked `TRANSFER_OUT` | removes quantity first-in first-out |
| `SPLIT` | lots unknown (a bond does not split); valuation refused with the reason |
| cash-only actions | none |

A lot quantity that is not a whole number of bonds, or a removal larger than
the open lots, makes the lots unknown; the reason is named, nothing is
guessed.

### 12.3 Daily price

For each calendar day `D` from the earliest lot date to today, the unit price
of a linked security is

```text
price(D) = sum over lots open on D of grossValue(lot, asOf = D) / sum of their quantities
```

rounded half-up to 10 decimals (`security_prices.close_price` is
`NUMERIC(24,10)`), computed with `ExactDecimal`. `grossValue` is principal
plus accrued interest, before the early redemption fee and tax: the economic
value of the holding. The early redemption value is shown beside it in the
detail view (section 13), never instead of it.

A day on which any open lot has no `grossValue` (a started period without a
rate, INV-BOND-002; a matured compounding lot without every rate) gets no price
row. The portfolio then carries the last
priced day, as for any security, and the detail view names what is missing.

Rows are written with `source = 'bond_engine'` by
`INSERT ... ON CONFLICT (security_id, price_date) DO UPDATE ... WHERE
security_prices.source = 'bond_engine' AND close_price IS DISTINCT FROM
EXCLUDED.close_price`: a manual price or a transaction-derived price on the
same day is never overwritten, and an unchanged day is not rewritten. A bond
engine row for a day that no longer has a price (lots changed) is deleted.

### 12.4 When prices are written

- after a link is set or changed (the request recomputes that security);
- daily, after the benchmark refresh, for every linked security of every user
  (system fan-out, then each user in its own context; one user's failure does
  not stop the others);
- on demand through `POST /bonds/securities/:securityId/recompute`.

The recompute runs after the commit of the change that triggered it, never
inside it (INV-CACHE-001).

### 12.5 Read API

- `GET /bonds/instruments`: the catalog (id, issuer country, issuer, program,
  series, currency), for the link picker.
- `GET /bonds/securities/:securityId/valuation?asOf=YYYY-MM-DD`: the lots and
  one `BondValuation` per lot (section 2.6), plus the lot totals, for the
  detail view. Owner-scoped by RLS; another user's security answers 404.

## 13. Detail view (phase 4)

For a linked security the security page shows, per lot and in total: series,
purchase date, maturity, current period and its rate with `rateSource`,
principal, accrued interest, gross value, early redemption value or the
refusal reason, next cash flow, known and projected maturity value, the
projection assumptions and the `missing` list with the publisher to obtain each
item from. Percentages and amounts are localized by the reader's number
format preference. The security form offers the instrument picker when the
security type is `BOND`.

How the rate is set is shown, not only its value: the rate rule in words (for
EDO1036: "period 1: 5.35%; then the 12-month CPI published by GUS + 2.00%
margin, a negative CPI counted as 0"), and a table of every period of the lot
with its dates, rate and `rateSource`, and, for a benchmark period, the
observation used (CPI 2027-08 = 3.4%), the floor when it applied, and the
margin. A projected period says it is projected and names the assumption; a
period whose observation is missing says which one. A benchmark id is shown
by a translated name where the catalog has one (`PL_CPI_GUS_YOY`: "CPI, 12
months (GUS)"), else by the id itself.

### 13.1 Indexation notice

A lot whose rate rule reads a benchmark says so in words before any figure:
for EDO1036 bought 2026-10-02, "Inflation-indexed: from 2027-10-02 (period 2)
the rate is the 12-month CPI published by GUS + 2.00% margin, recalculated
every period". The date is the lot's own period 2 start, because periods are
anchored on the purchase date.

### 13.2 Interest attribution

Each period's interest per bond is split by the components of its rate, so a
reader sees what the margin earned and what inflation earned:

```text
interest_k   = base_k * r_k / F                     (exact; base_k per 2.4)
fixed_k      = interest_k                           when rateSource is TERMS
benchmark_k  = base_k * flooredValue_k / F          for a benchmark period
addend_k     = base_k * addend_k / F                for a benchmark period
announced_k  = interest_k                           when ANNOUNCED (no split
                                                    is stated, so none is made)
```

For a benchmark period `benchmark_k + addend_k = interest_k` exactly. For a
compounding bond `base_k` already holds earlier interest, so interest earned
on earlier inflation counts as interest of the period it accrues in, by the
same split; the attribution is per period and never retroactive. The
rate schedule entry carries `interest`, `fixedPart`, `benchmarkPart`,
`addendPart` and `announcedPart` per bond (strings, unrounded to 10 places for
display; the money figures of section 2.4 keep their own rounding), each
`null` when the period's rate is unknown. Lot figures are per bond times the
quantity.

Numerical examples (computed from the formulas above with exact fractions;
E23 and E24 are the same computation as the implementation's fixtures and are
not read from its output):

| # | Case | Inputs | Expected |
| --- | --- | --- | --- |
| E23 | TOS1029 attribution | r = 4.40%, bases 100, 104.40, 108.99 | interest `4.40`, `4.5936`, `4.79556` (all `fixedPart`); their sum `13.78916` while `W - N = 13.79` (see below) |
| E24 | EDO1036 period 2 attribution | base 105.35, CPI 3.4% (floor not applied), margin 2%, so r2 = 5.4% | `interest 5.6889`, `benchmarkPart 3.5819`, `addendPart 2.107`; `3.5819 + 2.107 = 5.6889` per bond |

### 13.3 Inflation scenarios

`GET /bonds/securities/:securityId/scenarios?benchmarkId=...&values=a,b,...`
values the security's lots as of today with every future period of that
benchmark projected at each given value (at most 6 values, each between -0.5
and 1.0 as a fraction). Known periods stay known: a scenario never replaces an
observation or an announced rate. Per scenario it returns the lots' maturity
value, total interest and its attribution (13.2) summed over the lots, each
`null` if any lot cannot be valued. When the lots cannot be derived (section
12.2) every figure is `null` and `refusal` names why. An assumption about a
benchmark the instrument's rate rule does not read is refused with a 400, here
and on `assume`, because it would return unchanged figures that look like a
scenario. The detail view shows a table for the
presets 0%, 2.5%, 5% and 8% and one value the reader types, and labels every
scenario figure as a projection under that assumption.

The bounds -0.5 and 1.0 are inclusive and so is the limit of 6 values (a 7th
value, or a value outside the bounds, is refused with a 400).

**Total interest versus maturity value.** `totalInterest` is the exact sum of
the periods' interest per bond (13.2) times the quantity, rounded once per lot.
`maturityValue` is the per-bond maturity value rounded as section 2.4 says
(each period for TOS, the result for EDO), times the quantity. The two answer
different questions, so `maturityValue - face` and `totalInterest` differ by
cents (E23: 13.79 against 13.78916); the difference is the letter's rounding
and is disclosed, not reconciled. The chart (13.4) ends at `totalInterest`, not
at the maturity value shown beside it.

Example E25 (EDO1036, 10 bonds bought 2026-10-01, valued 2027-10-16, period 2
CPI 3.4% known, r2 = 5.4%, r1 = 5.35%; every later period projected at the
scenario value `v`, margin 2%, floor 0):

| Scenario `v` | `maturityValue` | `totalInterest` | fixed | benchmark | addend |
| --- | --- | --- | --- | --- | --- |
| 0 | `1301.00` | `301.00` | `53.50` | `35.82` | `211.68` |
| 0.05 | `1907.90` | `907.86` | `53.50` | `605.44` | `248.92` |

For `v = 0.05`, `maturityValue - face = 907.90` against `totalInterest =
907.86`: per-bond rounding of the maturity value against exact interest. The
known period 2 stays at 3.4% in both scenarios.

`GET .../valuation` accepts an optional `assume=<benchmarkId>:<value>` with
the same rule, so the per-period table and the chart can follow the reader's
chosen scenario.

### 13.4 Chart

Sections 13.1 to 13.4 and the rate schedule are implemented in this PR.

A stacked chart over the lot's period ends shows cumulative interest per
bond (or for the holding) split into fixed (period 1), margin and inflation
(benchmark) parts; projected periods are drawn distinctly from known ones and
the legend names the assumption. It reads the rate schedule of 13.2; it never
recomputes interest in the client.
