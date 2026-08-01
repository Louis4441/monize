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

A stored period is only *answered*, though, if it was calculated under the
configuration in force now. `config_fingerprint` (migration 129) hashes the
cadence, the lookback and the role-to-security mapping -- everything that
changes what a signal says, and nothing that only affects presentation or the
cost estimates. Shorten the lookback or swap a fund and the affected periods are
recomputed in place on the next read: same row, because the unique index owns
the period, with `executed` kept when the recomputed instruction is the same
instrument and cleared when it is not. A period that cannot be recomputed (a
lookback stretched past an instrument's first close) keeps its row in the
table, but it is left out of what `materialize` returns.

That last part matters more than it sounds. **Everything the report shows comes
from one configuration or it is not shown at all**: the history, the predecessor
chain and the backtest all read the same array, and mixing fingerprints in it
produces a run that never happened. The history resolves "switched out of" from
the entry before it, so a stale row wedged between two fresh ones would be named
as the predecessor of a period computed against an earlier one, and the backtest
would replay a hybrid of counterfactual and historical signals. A recomputed
period likewise takes its `previousRole` only from another period this
configuration produced. The rows stay in the table -- they are real decisions
with real `executed` flags -- they are simply not this configuration's history.

A **cadence change replaces the calendar** rather than editing it: on quarterly,
31 March is still an evaluation date and 30 April is not. Both the read and the
result are therefore filtered to the dates the current cadence evaluates on --
without that, the months in between stayed stored, were never revisited (the
loop only walks current periods), and the quarterly history showed monthly
decisions interleaved with its own. They are filtered, not deleted: they answer
a calendar this strategy is not on today, and switching the cadence back brings
them and their `executed` flags with it.

History renders the instrument each decision **actually named**, resolved from
the signal's own `target_security_id`; the role's current instrument is only the
fallback for a security since deleted. Resolving through the live mapping meant
replacing an ETF rewrote the past.

Periods whose momentum window opens before the price history does are bounded
out with one cheap aggregate rather than re-read on every load; nothing is
remembered, so a backfill unlocks them with no state to reset. And a RISK-ON
period is only stored when every *assigned* equity market has a momentum:
`rankEquities` drops an unmeasurable role, which would quietly turn "emerging
markets could not be measured" into "emerging markets did not win" and then
recommend a concrete switch. A role left deliberately unassigned is a
configuration, not a gap, and still evaluates.

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

Idle cash in those accounts is a position too (`isCash`): the linked
`INVESTMENT_CASH` balance of each brokerage account, and a standalone investment
account's own balance. GEM wants the whole strategy portfolio in one instrument,
so cash beside the target is exactly as off-target as the wrong fund -- an
account holding 5,000 of the target and 5,000 in cash is half invested, not
compliant. It is spent rather than sold, so it costs no commission, adds no
trade to `estimatedTradeCount` and realizes nothing. A negative balance is a
margin debt, not an asset the switch can move, and is ignored.

- `holdings` is every position in the accounts, largest first, each tagged with
  the role it fills (`role: null` for one that fills none);
- the "current" instrument is the largest holding -- what the accounts are
  effectively in;
- compliance is the share of the accounts' whole market value already in the
  target's markets;
- the transfer value is the **full** value of every holding not entirely in
  those markets, and `action.fromCount` says how many instruments that spans;
- the realized result is that value minus its cost basis, and the tax estimate
  applies the configured rate to a gain only (a loss owes nothing).

**"Executed" is recorded against the signal; the operation is recomputed from
the accounts.** The two can therefore disagree, and the report says so instead
of collapsing them: when a change is required *and* the signal is marked
executed, the card reports both -- either the trades have not been recorded yet,
or money has arrived since. Showing only the tick hid a live instruction behind
it, so an account that received a deposit after a completed switch read as done
with nothing to do.

**Partial overlap is a diagnostic, never a fraction of a sale.** A fund 20% in
the target's markets counts 20% towards compliance, and is still sold whole:
selling four fifths of it sells four fifths of its on-target sleeve too, so a
pro-rated sale never reaches the 100% allocation the signal asks for.
`action.partialMatchCount` says how many of the sold holdings were in that
position, and the transfer card explains it rather than leaving a compliance
figure and a full-value transfer looking contradictory.

**One unpriced holding makes the compliance share unknown, not approximate.** A
share of a total nobody knows is not a share, and the error runs in the
dangerous direction: an unpriced holding dropped from the denominator while
counting as zero in the numerator turned 10,000 in the target plus one
unpriceable position into exactly 100% compliant, with `changeRequired` false --
the report saying there was nothing to do about a position it could not see.
Unknown says so, and holding an instrument other than the target still settles
that a change is needed: what to do does not depend on being able to value it.

Prices come from `security_prices` (whatever provider filled them). Every
*historical* series -- momentum, the performance chart, the backtest -- reads
`COALESCE(adjusted_close, close_price)`, because all three measure a return over
time: on raw closes a 4-for-1 split reads as a 75% crash and flips the absolute
test, and distributions vanish from the return of whichever leg pays the most.
Valuing today's holdings is the other question and keeps the raw close.

Staleness is judged **per role**: `pricesAsOf` is the oldest required
instrument's last close, not the newest, and the `STALE_PRICES` warning names
the roles behind it. Taking the maximum let a US quote refreshed this morning
speak for an ex-US instrument last priced three weeks ago. An assigned
instrument with no price at all makes the date unknown rather than letting the
others answer for it. The threshold is five days.
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
