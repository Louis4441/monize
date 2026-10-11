# Sovereign Bonds: Plan

> Spec: [`docs/specs/polish-retail-bonds.md`](../specs/polish-retail-bonds.md). Task list: [`sovereign-bonds-tasks.md`](./sovereign-bonds-tasks.md). Origin: discussion kenlasko/monize#1650.

## Goal

One country-agnostic bond engine for every jurisdiction Monize users hold
bonds in, with Polish retail treasury bonds (TOS, ROR, COI, EDO) as the first
adapter. Value them from their issue terms and official reference data, not
from a market quote. Implement only the primitives the Polish products need,
in a shape where each later country is an adapter plus, rarely, a new
primitive (spec section 2.0).

## Assumptions (restated for a fresh session)

- Retail bonds have no market price. Their value comes from the issue letter,
  the purchase date of each lot, and the NBP reference rate or the GUS CPI.
- Periods are anchored on the purchase date of the lot, so two lots of one
  series have different schedules.
- The backend has no decimal library. The engine uses its own exact rational
  type over `BigInt`; no new dependency.
- The bond tables are global reference data (RLS exempt), like
  `exchange_rates`.
- `securities` stays generic: one nullable `bond_instrument_id` link and no other bond column (discussion section 23); the link is allowed only on a `BOND` security.
- A linked security's automatic price is the engine's: the engine row replaces
  every non-manual row and a manual price always wins (spec section 12.3).
- The UI language never selects bond logic: a Polish-language user may hold US
  TIPS. The instrument's issuer country, program and series decide it.
- The global research note (attached to the discussion) lists the 21
  jurisdictions of the Monize locales and the primitives they need; this plan
  does not freeze that list.

## Architecture

```text
backend/src/bonds/
  domain/          exact-decimal, calendar dates, period schedule,
                   business-day calendar interface and registry,
                   bond-terms (primitive unions + strict parser), benchmarks
  engine/          bond-engine.ts: terms + benchmarks + announced rates
                   + lot + asOf -> valuation; dispatches on primitive types only
  adapters/pl/     Polish calendar, benchmark definitions (PL_NBP_REFERENCE,
                   PL_CPI_GUS_YOY), terms manifests for the eight series
                   (TOS, ROR, COI, EDO, OTS, DOR, ROS, ROD), golden fixtures
  entities/        BondInstrument, BondTermsVersion, BondPeriodRate,
                   BenchmarkSeries, BenchmarkValue
  bond-valuation.service.ts   withScopedDb read -> engine
  bonds.module.ts
```

The engine never branches on a country or a product; a source-scanning guard
holds that. A product is a terms document, not code.

## Adding a country

1. `adapters/<cc>/`: its business-day calendar, its benchmark definitions,
   terms manifests, golden tests from an officially published example.
2. Map each local product to existing primitives. Only when an instrument
   has a new economic construction, add one primitive: a union member in the
   terms types, a parser case, one engine case, its tests.
3. A fetcher (definition provider) per country normalizes official terms and
   benchmark data into the same tables; it never computes a valuation.

## Global readiness (checked against the global research note)

A check on 2026-10-11 compared the engine with the owner's global research
note (21 countries). Seams added in this PR, each Polish result unchanged:
rounding decimals 0 to 4 and modes `HALF_UP`, `HALF_EVEN`, `DOWN`; a switch on
`schedule.anchor`; `principalAt(terms, { date })` instead of a constant
nominal; `yearFraction(terms, period, from, to)` for every accrual; an
exhaustive switch on every rate-rule type; each adapter's own timezone for
"today" and freshness; a logged trace of every benchmark correction; the
country-agnostic guard over the shared bond services.

Still a change, not an addition, when the first country that needs it comes:

| Mechanism | Countries (research note section) | What changes |
| --- | --- | --- |
| Holding a nominal amount (1,000 EUR, 0.01 EUR steps) instead of whole bonds, coupon rounded on the holding | marketable bonds of most countries (3.1-3.21) | `lot.quantity` becomes an exact decimal; a `rounding.basis` (`PER_UNIT` now, `PER_HOLDING`); the lot fold accepts fractions |
| Coupon dates anchored on the series, irregular first coupon, accrued interest paid at purchase | marketable coupon bonds (3.1-3.21) | a new `schedule.anchor` (`ISSUE_DATE`) with explicit coupon dates; the lot carries the accrued interest paid |
| Day-based tenors (91, 182, 364 days), discount issue | bills in most countries | a day-tenor schedule and a `ZERO_COUPON_DISCOUNT` rate rule with an issue price |
| Indexed principal (TIPS, OATi, BTP Italia, linkers, JGBi) | 3.1-3.6, 3.9-3.11, 3.15-3.17 | a `principalRule` case reading an index ratio through `principalAt`; benchmark unit `INDEX_LEVEL` (the `unit` column is free text, no migration) |
| Amortizing or annuity principal, gold-linked principal | 3.7, 3.15-3.18 | outstanding principal per period and `PRINCIPAL` flows per period |
| Rate compounded from daily fixings in arrears (SOFR, SONIA, Selic, RUONIA) | 3.2, 3.4, 3.15-3.17 | a rate rule that returns a period's accrual factor from many fixings; a `DAILY` benchmark kind (the `benchmark_series.kind` CHECK widened by migration) |
| Business-day exponential accrual (BUS/252) | 3.15 | an `accrual.type` case in `yearFraction` with a compounding form |
| Revised index values (HICP flash and final, IPCA) | euro area, Brazil | benchmark values keyed by vintage, and a rule choosing the vintage for a valuation day |
| Market price beside the engine value | marketable bonds | the engine-only price rule (INV-BOND-005) becomes per `marketability`: a market quote wins for a marketable bond and the engine supplies accrued interest |
| ISIN, CUSIP and local identifiers | all | an additive `bond_instrument_identifiers` table |

## Second-country example: United States Series I savings bonds

A check of the design against a second retail inflation bond. The rules below
come from 31 CFR part 359 and TreasuryDirect, read on 2026-10-11; confirm them
again before you implement.

| Rule | Source | Existing primitive | New primitive needed |
| --- | --- | --- | --- |
| Composite rate `{(F/2) + I + I·(F/2)} × 2`, F the fixed rate, I the semiannual inflation rate; the regulation's example rounds it to 4 decimals (2.57%) | [31 CFR 359.14](https://www.law.cornell.edu/cfr/text/31/359.14) | none: `INFLATION_PLUS_MARGIN_AS_RATE` adds, it does not compound the two parts | a rate rule `FIXED_PLUS_INFLATION_COMPOSITE` with its own rounding |
| A negative composite rate counts as zero | [31 CFR 359.39](https://www.law.cornell.edu/cfr/text/31/359.39) | the rate floor of the Polish CPI rules | none, if the floor applies to the composite |
| The inflation rate resets every 6 months, from CPI-U; which months are compared is not yet confirmed | [TreasuryDirect](https://www.treasurydirect.gov/savings-bonds/i-bonds/), [31 CFR 359.15](https://www.law.cornell.edu/cfr/text/31/359.15) | `MONTHLY_VALUE_MONTHS_BEFORE_START` reads one value; I is a change between two index values | an observation rule that reads two index months and returns their change |
| Interest is earned monthly (full calendar months only) and compounded semiannually: `FV = PV·(1 + CR/2)^(m/6)` | [31 CFR 359.39](https://www.law.cornell.edu/cfr/text/31/359.39) | `COMPOUND_AT_PERIOD_END` with 6-month periods | an accrual step of whole months (the Polish bonds accrue daily) |
| The value of a 25 USD unit is rounded to the cent, half-up (25.044 to 25.04, 25.045 to 25.05); a larger bond is a multiple of that value | [31 CFR 359.55](https://www.law.cornell.edu/cfr/text/31/359.55), [appendix A](https://www.law.cornell.edu/cfr/text/31/appendix-A_to_part_359) | `rounding` half-up per bond; the bond is the 25 USD unit | none |
| Redemption no earlier than 12 months after purchase | TreasuryDirect | `earliestDaysAfterPurchase` counts days | a minimum holding period in months |
| Before 5 years, the last 3 months of interest are lost | TreasuryDirect | `FORFEIT_ACCRUED_SINCE_LAST_PAYMENT` forfeits a period's accrual, not 3 months | a penalty `FORFEIT_LAST_N_MONTHS_INTEREST` with an end date for the penalty (discussion section 39 names `FORFEIT_N_DAYS_INTEREST`) |
| Business days and holidays do not affect the value | 31 CFR 359.39 (whole months) | a calendar is optional | none |

So a US adapter needs about four new primitives (a composite rate rule, a
two-month index observation, a whole-month accrual step, and a month-based
holding period and penalty). None of them changes the Polish rules, so the
engine design holds: a new mechanism is one new union member with its parser
case, engine case and tests.

## Phases

| PR | Content | Observable result |
| --- | --- | --- |
| 1 | Spec, plan, domain, engine, TOS/ROR/COI/EDO, migration with the five tables, read service | golden tests E1 to E16 pass; the immutability trigger refuses an update |
| 2 | Fetchers: NBP reference rate history (NBP API), GUS CPI, Ministry announced rates; a lease-guarded cron; provider health | stored observations for the open series; `missing` empties once fetched |
| 3 | Link a security to a bond instrument; lots from BUY transactions; bond value in portfolio valuation, with `valuationComplete` carried | a TOS holding shows its value in the portfolio |
| 4 | UI: bond detail (period, rate, accrued, early redemption, known vs projected); i18n | the detail view of discussion section 42 |
| 5 | OTS, DOR, ROS, ROD (older series terms: a follow-up) | each product with its golden fixture |
| 6+ | Further countries in the order of the research note (simple marketable bonds, then indexed principal, floating, special retail); identifiers (ISIN, local series); market quote basis (percent of par, clean/dirty) | each country an adapter with golden tests; new primitives only where needed |

## What to run

Per PR, the "Required before you push" list in `AGENTS.md`. PR 1 touches a
migration, so it also runs `npm run migration:lint`, `scripts/verify-schema.sh`,
`node scripts/check-migration-prefixes.mjs`, and `npm run build && npm run
test:integration`.
