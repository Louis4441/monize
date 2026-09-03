# Spec: portfolio-movement notifications

Status: **proposed, awaiting maintainer approval.** No code lands until the open
decisions in Section 7 are confirmed. Scope from discussion #1291 (the
`investments` group, "significant portfolio movement") and the maintainer's
answer "investment/portfolio movement alerts: your choice, could be useful"
(recorded in `notification-preferences.md` Section 16.1) -- so this producer is
**optional** and ships only if the maintainer opts in at D0.

Owner: notification-center. Related: #1291, `notification-preferences.md`,
`fx-conversion-completeness.md` (the completeness contract this producer must
obey), INV-NOTIFY-001 (the write door).

---

## 1. What this adds, and the two rules it must obey

Once per period, the Notification Center compares the user's **total portfolio
value** against the previous period's value and, when the change exceeds the
user's configured percentage, raises one notification (`investments` category).

Two rules, and the second is the one that makes this hard:

1. **Crossing, not level** (as for every producer): fire once when the movement
   first exceeds the threshold in a period, not repeatedly.
2. **A subtotal is not a total** (`fx-conversion-completeness.md`,
   `financial-calculation-contract.md`): portfolio value spans currencies and
   priced securities, so a movement computed from an **incomplete** valuation is
   a confident false number. If either the current or the baseline valuation is
   incomplete, the movement is **unknown**, and the alert is **withheld** -- never
   fired on a subtotal. This is the #1247/#1125 family of bug, and it is why this
   producer, unlike balance thresholds, has a completeness gate.

---

## 2. Invariants

- **INV-PORTMOVE-001 (complete both ends, or withhold).** A movement is computed
  and an alert raised only when `getPortfolioSummary(...).valuationComplete` is
  `true` for the current run **and** the stored baseline was captured with
  `valuationComplete === true`. If either is incomplete, no alert and no
  re-baseline (Section 3.3) -- an incomplete run is a no-op, not a new baseline,
  because baselining on a subtotal would make the *next* comparison wrong too.
- **INV-PORTMOVE-002 (unknown is not zero).** A missing price or missing rate
  makes the movement unknown, never `0%` and never "no movement". The gate reads
  `valuationComplete === true` (defensive `=== true`, so an absent flag during a
  rolling deploy is treated as incomplete, INV-PORTMOVE-001), not `!incomplete`.
- **INV-PORTMOVE-003 (one currency).** Both totals are `getPortfolioSummary`'s
  `totalPortfolioValue`, already converted to the user's reporting currency by
  the one resolver everything else uses. The percentage is a ratio of two figures
  in the **same** currency; a baseline in one currency and a current in another is
  never compared (a reporting-currency change re-baselines rather than compares --
  Section 7 D5).
- **INV-PORTMOVE-004 (baseline == 0 has no percentage).** A user whose previous
  total was `0` (no holdings, or first holdings this period) has an undefined
  percentage change; the producer raises nothing and simply records the new
  baseline. A first non-zero total is not a "movement".
- **INV-PORTMOVE-005 (one writer, isolated).** Written through
  `NotificationDispatchService.notify` -> `NotificationService.create`
  (INV-NOTIFY-001), from a cron under `withSystemContext`/`withUserContext`,
  after the day's price refresh. It never hooks a price write.

---

## 3. Shape

### 3.1 Per-user configuration and baseline (new state)

There is **no daily portfolio-value snapshot in the codebase** -- only monthly
`monthly_account_balances.market_value`, too coarse for a day-over-day movement.
So the producer keeps its own minimal per-user state:

```
-- one row per user (new table notification_portfolio_state, or columns on an
-- existing per-user settings row -- Section 7 D6):
user_id                     UUID   PRIMARY KEY / FK -> users(id) ON DELETE CASCADE
move_alert_percent          NUMERIC(9,4)  NULL   -- threshold; NULL = off (default)
baseline_value              NUMERIC(20,4) NULL   -- last COMPLETE total (INV-PORTMOVE-001)
baseline_currency           CHAR(3)       NULL   -- currency baseline_value is in
baseline_captured_at        TIMESTAMPTZ   NULL
last_period_key             TEXT          NULL   -- the period this baseline anchors
```

`NULL` `move_alert_percent` = off (the default; opt-in). The baseline is the last
run whose valuation was complete. RLS: user-owned, policy in the same migration;
`schema.sql` updated.

### 3.2 New notification type and category

Mechanical, compiler-forced (per the code map):

- `NotificationType`: `PORTFOLIO_MOVEMENT` (<= 30 chars). One type; the direction
  (up/down) travels in `data.direction` and the sign of `data.changePercent`.
  The sign is provable here -- a complete total minus a complete total -- so it
  is safe to carry, unlike a mixed-sign split parent's snapshot.
- `NotificationCategory`: `INVESTMENTS = "INVESTMENTS"`.
- `notificationCategoryOf` maps `PORTFOLIO_MOVEMENT` -> `INVESTMENTS`.
- `NOTIFICATION_CATEGORY_CHANNELS` gains `INVESTMENTS`
  (`{ email: true, emailNotification: true, push: true, unifiedpush: true }`),
  `NOTIFICATION_PREFERENCE_CATEGORIES` gains it, `PUSH_CATEGORY_COPY` gains it
  plus `push.notification.investments` (English-first, pseudo regenerated).
- Frontend mirrors + client copy composition + `notification-target` mapping,
  held by the same three contract tests.

### 3.3 The producer

Cron service `PortfolioMovementAlertService`, scheduled **after** the market/price
refresh so the current total is priced (chain off the same hook
`NetWorthService.recalculateAllInvestmentSnapshots` runs after, or a `@Cron`
timed after it -- Section 7 D3):

```
for each user with move_alert_percent set:            // withSystemContext fan-out
  withUserContext(userId): withScopedDb:               // baseline r-m-w is atomic
    const s = portfolio.getPortfolioSummary(userId)
    if (s.valuationComplete !== true) return           // INV-PORTMOVE-001/002: no-op
    const cur = s.totalPortfolioValue, ccy = reportingCurrency(userId)
    if (baseline == null || baselineCurrency !== ccy || periodKey !== last_period_key):
        record baseline = { cur, ccy, now, periodKey }; return   // no alert (004/005)
    if (baseline_value == 0): record baseline = cur; return      // INV-PORTMOVE-004
    const pct = roundMoney((cur - baseline_value) / baseline_value * 100)
    if (Math.abs(pct) >= move_alert_percent):
        dispatch.notify(userId, {
          type: PORTFOLIO_MOVEMENT,
          severity: NotificationSeverity.INFO,          // Section 7 D4
          title, message,
          data: { changePercent: pct, direction: pct >= 0 ? "up" : "down",
                  currentValue: cur, baselineValue: baseline_value,
                  currencyCode: ccy, periodKey },
          target: "/investments",                        // confirm route
          dedupeKey: `portmove:${userId}:${periodKey}`,  // one per period
        })
    record baseline = { cur, ccy, now, periodKey }       // re-baseline each complete run
```

The dedupe key includes `periodKey`, so at most one movement alert exists per
period (INV-PORTMOVE crossing). `data.changePercent` is a computed ratio of two
same-currency complete totals; it is safe to store because it describes a closed
period, not a future occurrence. Delivery, throttle and fan-out are the seam's.

---

## 4. Numerical examples

Reporting currency USD, threshold 5%.

```
day 1: total = 100,000 complete  -> baseline = 100,000 (no alert; first)
day 2: total = 103,000 complete  -> pct = +3.00%  < 5%  -> silent, rebaseline 103,000
day 3: total =  96,000 complete  -> pct = -6.80%  >= 5% -> FIRE down; rebaseline 96,000
day 4: total = 101,000 INCOMPLETE (one holding unpriced)
                                 -> valuationComplete=false -> NO-OP: no alert,
                                    baseline stays 96,000 (INV-PORTMOVE-001)
day 5: total = 102,000 complete  -> pct vs 96,000 = +6.25% >= 5% -> FIRE up;
                                    rebaseline 102,000
```

Day 4 is the whole point: an incomplete valuation neither fires (it might be a
false 5%) nor rebaselines (or day 5 would measure from a subtotal). The movement
is unknown, and unknown is a no-op.

---

## 5. Missing-data policy

- `valuationComplete !== true` on the current run -> no alert, no rebaseline.
- A stored baseline is only ever a complete total (nothing else is written to it).
- `baseline_value == 0` -> undefined percentage -> no alert, rebaseline only.
- No total is ever defaulted, and no percentage is ever computed from a subtotal.
  The producer has nothing to "withhold at the client" because it simply does not
  emit -- the withholding is at the producer, which is the honest place for a
  batch job with no reader waiting.

---

## 6. Deliberate trades

- **The producer owns its baseline; it does not add a daily snapshot table for
  everyone.** A general daily portfolio snapshot is a larger feature (storage,
  backfill, its own completeness handling); this producer needs only "the last
  complete total I saw", which is one row per opted-in user. If a daily snapshot
  is later built for other reasons, this baseline can read from it instead.
- **Period-over-period, not intraday.** Intraday value is computed live and cached
  60s; alerting on it would be noisy and rate-limited by the upstream. A daily
  period matches "significant movement" and the once-a-day price refresh.
- **One type, signed data.** The sign is provable (complete total minus complete
  total), so up/down is a `data` field, not two types -- fewer catalogue keys,
  and the bell composes the direction word per locale.

---

## 7. Open decisions (maintainer confirms before build)

- **D0. Build it at all?** The maintainer called this "optional, could be useful".
  If not opted in, this spec stays on the shelf and the `investments` category is
  not created yet.
- **D1. Default off**, opt-in per user; default threshold once enabled (e.g. 5%).
- **D2. Which aggregate:** `getPortfolioSummary().totalPortfolioValue` (securities
  cash + holdings) vs net worth (all accounts). #1291 says "portfolio"; default is
  `totalPortfolioValue`.
- **D3. Cadence and anchor:** daily, chained after the price refresh; `periodKey`
  = calendar day in the user's timezone (vs 24h rolling).
- **D4. Severity `INFO`** (informational, not actionable), or `WARNING` for a
  large drop -- maintainer's call.
- **D5. Reporting-currency change** re-baselines (no cross-currency comparison,
  INV-PORTMOVE-003) rather than firing a spurious movement.
- **D6. Baseline storage:** a dedicated `notification_portfolio_state` table vs
  columns on an existing per-user settings row.
- **D7. Absolute-amount threshold** in addition to percent -- deferred; percent
  only in the first cut.

---

## 8. Test matrix (offline-runnable except where noted)

1. **Withhold on incomplete** (INV-PORTMOVE-001/002): an unpriced holding ->
   `valuationComplete=false` -> no alert, baseline unchanged (day 4 above).
2. **Unknown is not zero**: incomplete run does not fire a "0% / no movement".
3. **Crossing once per period**: two runs the same period do not both fire (dedupe
   key carries `periodKey`).
4. **baseline == 0** raises nothing, only rebaselines (INV-PORTMOVE-004).
5. **Currency change** re-baselines, never compares across currencies
   (INV-PORTMOVE-003).
6. **Sign/direction**: a complete drop yields `direction:"down"`, negative
   `changePercent`; a rise the reverse -- and the figure equals the two-total
   ratio to 4dp.
7. **Write door / category wiring / delivery matrix**: as for balance thresholds
   (Section 8 there), with the `INVESTMENTS` category.
8. **Rolling-deploy safety**: an absent `valuationComplete` reads as incomplete
   (`=== true` gate), so a mid-deploy response never fires a movement.

Integration (CI-owned): baseline read-modify-write under `withScopedDb`, the RLS
policy, schema drift, and a real `getPortfolioSummary` returning an incomplete
valuation (an unpriced security in a real database).
