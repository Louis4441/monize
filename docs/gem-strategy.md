# GEM strategy (Global Equities Momentum)

Rule-based allocation report: one signal per period, one instrument held at a
time. The report page lives at `/reports/gem-strategy`
(`frontend/src/components/strategies/`), the evaluation in
`backend/src/strategies/`.

## Rules

Standard dual momentum, evaluated in two steps against a lookback window
(12 months by default, `gem_strategies.lookback_months`):

1. **Absolute momentum** -- compare the US equity leg's trailing return with the
   risk-free leg's. Equities winning outright is `RISK_ON`; equal or worse is
   `RISK_OFF`.
2. **Relative momentum** -- while `RISK_ON`, hold the equity market with the
   strongest trailing return. While `RISK_OFF` the ranking is still computed and
   shown, but it does not drive the allocation: the safe asset is held.

The target weight is always 100% in a single instrument. Ties in the ranking
break on the canonical role order, so the same inputs always produce the same
winner.

A period whose absolute test cannot be run -- no momentum for the US equity leg
or the safe asset, e.g. missing prices -- produces **no signal**. Nothing is
guessed from half the inputs, and the period is evaluated later once its prices
exist.

Roles: `US_EQUITY`, `EX_US_EQUITY`, `EM_EQUITY`, `SAFE`. A role with no security
assigned is reported as unmapped (`UNMAPPED_ROLE`) rather than substituted.

The rules themselves are not configurable. What is: the instruments, the
cadence, the lookback window, the strategy accounts, and the tax/commission
assumptions behind the transfer estimates.

## Calendar

A monthly strategy re-allocates on the 1st of each month, decided on the last
day of the previous month (`evaluated_on`); a quarterly one on the 1st of
January, April, July and October. `effective_from` is the first day the
allocation applies. "Next evaluation" is the price date the following period will
be decided on.

## Data model

| Table | Holds |
|-------|-------|
| `gem_strategies` | One configuration row per user: cadence, lookback, tax rate, commission, rules-source link |
| `gem_strategy_accounts` | The brokerage accounts the strategy is run in (many per strategy); their holdings are summed |
| `gem_strategy_assets` | The security filling each role (`security_id` nullable = unmapped) |
| `gem_strategy_signals` | One row per evaluated period: state, target, momentum snapshot, spread, lead, previous role, execution flag |

Migrations `database/migrations/124_gem_strategies.sql` and
`125_gem_strategy_accounts.sql` (mirrored in `database/schema.sql`, including
the Group A RLS policies). 125 moves the single `gem_strategies.account_id` to
the join table, backfilling the existing link.

Signals are **materialized**, not derived on each read: the momentum figures a
decision was taken on must survive later price revisions, and the user's
"executed" flag needs a stable row. Materialization runs on the report read
(bounded to the last `GEM_HISTORY_PERIODS` = 24 periods) rather than only in a
scheduled job, so a strategy that was just configured -- or whose prices arrived
late -- produces its history immediately. Each period is inserted once; the
unique index on `(strategy_id, evaluated_on)` arbitrates concurrent readers.

## API

All routes are JWT-guarded and derive the user from the token.

| Route | Purpose |
|-------|---------|
| `GET /strategies/gem/report?range=3M\|6M\|1Y\|3Y\|5Y\|MAX` | The whole report as one read model. `range` only affects the performance series |
| `PUT /strategies/gem` | Create or update the configuration (accounts, cadence, lookback, costs, role assignments). Sending `accountIds` replaces the whole set |
| `POST /strategies/gem/signals/:id/executed?range=…` | Record that the operation was carried out; returns the refreshed report |

The response shape is `backend/src/strategies/gem-report.types.ts`, mirrored in
`frontend/src/types/gem-strategy.ts`. `null` always means "not known" (unmapped
role, missing history, no account, unestimable value) and the client renders an
explicit unknown marker for it -- never a zero.

Warnings the report can carry: `UNMAPPED_ROLE`, `INCOMPLETE_HISTORY`,
`NO_ACCOUNT`, `NO_POSITION`, `FIRST_RUN`, `STALE_PRICES`, `CALCULATION_FAILED`.

`backtest` is always `null` for now: a trustworthy simulation needs full price
history for every role plus a cost model the configuration does not carry, and
an estimate built from partial data would read as fact. The field exists so the
client's Backtest tab has a defined shape and shows its empty state.

## Portfolio comparison

Compliance and the transfer estimates come from the holdings in the strategy
accounts, valued at the latest close (`backend/src/strategies/gem-position.util.ts`).

The comparison covers **everything** held in those accounts, not only the
instruments assigned to a role. GEM asks for the whole portfolio to sit in one
asset, so a holding the strategy never assigned is exactly what makes the
portfolio non-compliant and exactly what a switch has to sell. A strategy can
span several brokerage accounts: a security held in more than one is summed into
a single position, so the comparison sees one portfolio rather than one account
at a time, and each holding is converted into the user's default currency with
the latest stored exchange rate.

- `holdings` is every position in the accounts, largest first, each tagged with
  the role it fills (`role: null` for one that fills none);
- the "current" instrument is the largest holding -- what the accounts are
  effectively in;
- compliance is the share of the accounts' whole market value already in the
  target instrument;
- the transfer value is everything held outside the target -- what a switch
  moves -- and `action.fromCount` says how many instruments that spans;
- the realized result is that value minus its cost basis, and the tax estimate
  applies the configured rate to a gain only (a loss owes nothing).

When nothing can be priced the compliance share is unknown rather than zero, but
holding an instrument other than the target still settles that a change is
needed: what to do does not depend on being able to value it.

Prices come from `security_prices` (whatever provider filled them); the report
reports the latest price date and flags prices older than five days as stale.
`PUT /strategies/gem` tops that history up first: any assigned security whose
prices do not reach back over the momentum window plus the 24 periods the
history table shows is backfilled from the quote provider before the signal is
evaluated. A provider failure is logged and leaves the incomplete-history
warning in place; it never fails the save.

## Getting a strategy running

The Settings tab of the report is the configuration form: it assigns the
strategy accounts and an instrument to each role, and sets the cadence, the
momentum window and the cost assumptions. Saving returns the refreshed report,
so a complete configuration produces its first signal immediately.

Prerequisites, since the strategy only reads what already exists in Monize:

1. A security per role. The Settings tab fills every unassigned role with the
   ETF GEM is usually run with in one click (`frontend/src/lib/gem-suggested-securities.ts`),
   creating only the ones the portfolio does not already hold, or any role can
   be pointed at an instrument of your own. Saving the configuration fetches
   the price history the strategy needs for the roles that are short of it
   (`backend/src/strategies/gem-backfill.service.ts`), so the first signal is
   evaluated by the same request rather than waiting on a background job. A
   role the provider has no data for is reported as unknown rather than
   guessed, and the fetch is retried at most once every six hours.
2. At least one investment (brokerage) account for the strategy to trade in --
   pick as many as the strategy spans and their holdings are summed. Compliance
   and the transfer estimates come from those holdings; without any the report
   still shows the signal and says no account is assigned.

`PUT /strategies/gem` is the same operation for scripted setup.
