# Spec: balance-threshold notifications

Status: **proposed, awaiting maintainer approval.** No code lands until the
open decisions in Section 7 are confirmed. Scope decided in discussion #1291
(the `balances` group) and the maintainer's answer "user-configurable balance
thresholds: yes" (recorded in `notification-preferences.md` Section 16.1).

Owner: notification-center. Related: #1291, `notification-preferences.md`
(the delivery/matrix layer this producer plugs into), INV-NOTIFY-001 (the write
door every producer goes through).

---

## 1. What this adds, and the one rule it must obey

A user sets, per account, an optional **low** and/or **high** balance threshold.
When the account's balance **crosses** a threshold, the Notification Center
raises one notification, delivered per the existing matrix (`balances` category).

The rule, from #1291 and confirmed by the maintainer: a producer fires on a
threshold **crossing**, never on mere observation of the current state. A balance
that sits at 40 while the low threshold is 50 must produce **one** notification
when it first drops below 50, not one on every subsequent debit while it stays
below, and a fresh one only after it has recovered above 50 and crossed down
again. This is the balance analogue of the budget producer's `79% -> 81%` fires,
`81% -> 82% -> 83%` does not.

Thresholds are compared in the **account's own currency** (`current_balance` and
the threshold are both `NUMERIC(20,4)` in that currency), so this producer needs
**no FX and has no missing-rate case** -- unlike portfolio movement
(`portfolio-movement-notifications.md`), which does. That is the reason the two
are separate specs.

---

## 2. Invariants

- **INV-BALANCE-001 (crossing, not level).** A notification is raised only on a
  transition across the threshold. The mechanism is a per-account, per-kind
  **armed latch** (Section 3): the producer fires only when it finds the balance
  on the alerting side *and* the latch un-armed, and it clears the latch only
  when the balance returns to the non-alerting side. Re-evaluating the same
  below-threshold balance twice raises nothing the second time.
- **INV-BALANCE-002 (account currency, no FX).** The comparison is
  `current_balance` against the stored threshold, both in the account's currency.
  No conversion is performed and no rate is consulted, so there is no
  withheld/`null` case for the fire decision (INV-BALANCE-005 covers the one
  genuinely-unknown input).
- **INV-BALANCE-003 (one writer).** The notification is written through
  `NotificationDispatchService.notify` -> `NotificationService.create`, exactly
  like every other producer (INV-NOTIFY-001). No new INSERT path, no new
  truncation helper. `notification-write-door.spec.ts` continues to pass.
- **INV-BALANCE-004 (isolated from the balance write).** Detection does not hook
  the atomic balance `UPDATE`. It runs in its own periodic cron under
  `withSystemContext` fan-out + `withUserContext` per-user bodies, reading
  `current_balance` as-committed. A balance write is never made slower or made to
  depend on a notification. (Rationale in Section 6.)
- **INV-BALANCE-005 (a closed/absent account is a known state).** An account with
  no balance row reads as `0`, a known value, not `null`. A closed account
  (`is_closed = true`) is excluded from evaluation (its balance no longer moves).
  Neither is an "unknown" that withholds -- there is nothing to withhold, because
  no total spans currencies here.

---

## 3. Shape

### 3.1 Per-account configuration and latch (new columns on `accounts`)

```
low_balance_threshold   NUMERIC(20,4)  NULL   -- notify when balance drops below
high_balance_threshold  NUMERIC(20,4)  NULL   -- notify when balance rises above
low_alert_armed         BOOLEAN NOT NULL DEFAULT false
high_alert_armed        BOOLEAN NOT NULL DEFAULT false
```

`NULL` threshold = that kind is off (the default; a new account raises nothing
until the user opts in). The `*_armed` columns are the durable latch that makes
INV-BALANCE-001 hold across cron runs and across replicas -- they are the
producer's only state, and they are read-modified-written inside the same
per-account transaction that decides to fire (`withUserContext` +
`withScopedDb`), so two concurrent runs cannot both fire (the row lock the write
takes serialises them).

`accounts` is a user-owned table already under RLS; the four columns ship in the
same migration and need no new policy (the table's policy already scopes them).
`database/schema.sql` updated in the same migration.

Threshold columns are **derived from the account, never accepted on a
transaction request** -- they are edited only through the account settings DTO
(new fields, `@IsNumber`/`@Min` bounds, nullable), the same door
`credit_limit` uses today.

### 3.2 New notification types and category

Per the code map, adding these is mechanical and compiler-forced:

- `NotificationType`: `BALANCE_BELOW_THRESHOLD`, `BALANCE_ABOVE_THRESHOLD` (both
  values <= 30 chars for the `alert_type VARCHAR(30)` column).
- `NotificationCategory`: `BALANCES = "BALANCES"`.
- `notificationCategoryOf` maps both new types to `BALANCES`; `typesForCategory`
  derives the inverse automatically.
- `NOTIFICATION_CATEGORY_CHANNELS` gains a `BALANCES` row (the
  `Record<NotificationCategory, ...>` type forces it or the build fails). Channels:
  `{ email: true, emailNotification: true, push: true, unifiedpush: true }`
  (a balance alert is user-facing financial news, like a bill -- all channels
  live, subject to the maintainer's Section 7 confirmation).
- `NOTIFICATION_PREFERENCE_CATEGORIES` gains `BALANCES` (user-configurable, not
  admin-only).
- `PUSH_CATEGORY_COPY` gains `BALANCES` generic copy + the i18n key
  `push.notification.balances`, English-first, pseudo-locale regenerated.
- Frontend mirrors: `types/notification.ts` union + `NotificationCategory`, and
  `notification-preferences.ts` -- held equal by `notification.contract.test.ts`
  and `notification-preferences.contract.test.ts`.
- Client copy composition (bell) for the two types from `data`, and a `target`
  entry checked by `notification-target.contract.test.ts`.

### 3.3 The producer

A cron service `BalanceThresholdAlertService` (mirroring `BudgetAlertService`'s
structure):

- `@Cron` daily (e.g. `"0 7 * * *"`, alongside the budget cron), plus an
  event-driven nudge is a Section 7 decision, not the default.
- Cross-user: `withSystemContext(() => Account.find({ where: [{ lowBalanceThreshold: Not(IsNull()) }, { highBalanceThreshold: Not(IsNull()) }], ... }))`
  -- only accounts with at least one threshold set, and `is_closed = false`.
- Per-account body: `withUserContext(account.userId, () => evaluate(account))`,
  inside `withScopedDb` so the latch read-modify-write and the dispatch decision
  share one transaction.

`evaluate(account)` (the state machine, Section 4) decides fire/re-arm for each
kind, then calls the seam:

```
await this.dispatch.notify(account.userId, {
  type: BALANCE_BELOW_THRESHOLD,          // or ABOVE
  severity: NotificationSeverity.WARNING, // low; high is INFO (Section 7 D4)
  title, message,                          // English fallback; client localizes
  data: { accountId, accountName, balance, threshold, currencyCode, kind: "low" },
  target: `/accounts/${account.id}`,
  dedupeKey: `bal:${account.id}:low`,      // re-armable; a fresh crossing after
                                           // re-arm is a new row, not a dup
});
```

`target` is `/accounts/:id`; confirm the route exists in
`notification-target.contract.test.ts` (add a mapping if the accounts detail
route differs). The dispatch seam owns delivery, throttle and the push/email
fan-out; this producer never touches a transport.

`data` carries **facts, not a pre-rendered figure that goes stale**: the amount
and currency are the balance at fire time, which is what the alert is about (a
point-in-time crossing), so it is a snapshot on purpose -- distinct from a
scheduled amount, which must be re-resolved (that rule governs `amount` fields
that describe a *future* occurrence, not a historical event).

---

## 4. State-transition truth table and numerical examples

Let `B` = `current_balance` read this run, `T_low`/`T_high` the thresholds,
`armed_low`/`armed_high` the latches.

### Low threshold (`T_low` set)

| Condition this run | armed_low before | Action | armed_low after |
|---|---|---|---|
| `B < T_low` | false | **FIRE** `BALANCE_BELOW_THRESHOLD` | true |
| `B < T_low` | true | silent (still below; no re-fire) | true |
| `B >= T_low` | true | no alert; **RE-ARM** | false |
| `B >= T_low` | false | silent | false |

### High threshold (`T_high` set) -- mirror

| Condition this run | armed_high before | Action | armed_high after |
|---|---|---|---|
| `B > T_high` | false | **FIRE** `BALANCE_ABOVE_THRESHOLD` | true |
| `B > T_high` | true | silent | true |
| `B <= T_high` | true | no alert; **RE-ARM** | false |
| `B <= T_high` | false | silent | false |

The boundary is deliberate: "below" is strict `<` and re-arm is `>=` (a balance
sitting exactly on `T_low` is not below it and re-arms), symmetric for high.

### Worked example (low threshold 50.0000, account in CAD)

```
run 1: B = 120.0000  armed=false  -> silent,      armed=false
run 2: B =  40.0000  armed=false  -> FIRE (below), armed=true
run 3: B =  30.0000  armed=true   -> silent,       armed=true    (the 81->82->83 case)
run 4: B =  55.0000  armed=true   -> re-arm,       armed=false
run 5: B =  45.0000  armed=false  -> FIRE (below), armed=true    (a genuine new crossing)
```

The dedupe key `bal:<accountId>:low` is stable across runs; the DB's
`idx_notifications_dedupe` unique index on `(user_id, dedupe_key)` would collapse
runs 2 and 5 into one row if the key never changed. So the latch, not the dedupe
key alone, is what allows run 5 to be a fresh row: **the fire path dismisses the
prior `bal:<accountId>:low` row (or appends a crossing ordinal) before writing
the new one**, the same "each fire is a fresh bell row" mechanism reminders use.
The exact reuse-vs-ordinal choice is Section 7 D5; both satisfy INV-BALANCE-001.

---

## 5. Missing-data policy

There is no cross-currency total here, so the only input that can be unknown is
the balance itself, and it never is (INV-BALANCE-005): an absent balance is `0`,
a closed account is excluded. There is therefore **no withheld/`null` alert** and
no "unknown movement" state -- that state belongs to portfolio movement, whose
value spans currencies. This spec deliberately has no `*Complete` flag because it
has no total to be incomplete.

---

## 6. Deliberate trades

- **Cron, not a hook on the balance `UPDATE` (INV-BALANCE-004).** The budget
  producer is cron-based and stateless-per-run; balance detection follows it. A
  hook on `accounts.updateBalance` would fire at the instant of crossing (better
  latency) but couples a notification decision to the hottest write in the app
  and to every path that moves a balance (create, edit, delete, bulk, transfer
  legs, recalc) -- exactly the surface the codebase warns is easy to get wrong on
  one path and not the others (VOID, future-dated, split parents). A daily cron
  reading committed state, gated by a latch, catches "your balance is low"
  reliably and cannot be defeated by a path that forgot to call the hook. The
  cost is up-to-a-day latency and that a transient dip which recovers before the
  cron is not reported -- acceptable for "your balance dropped below X". Real-time
  is a Section 7 decision (D3), staged, not the default.
- **A latch column, not a stored "previous balance".** The budget producer avoids
  a running "last percent" by anchoring dedupe on the period; a balance has no
  natural period, so the latch is the minimal durable state that expresses
  "already alerted, waiting for recovery". Two booleans per account, not a
  history table.
- **`data.balance` is a snapshot on purpose.** See Section 3.3 -- a crossing is a
  historical event, so the figure it carries is a fact about that moment, unlike a
  future occurrence's amount.

---

## 7. Open decisions (maintainer confirms before build)

Every default below is a reviewable decision, not a fact about the domain
(the org rule that AI output is auxiliary).

- **D1. Thresholds default off (`NULL`).** A new or existing account raises
  nothing until the user sets a value. Chosen default: off.
- **D2. One low + one high per account**, not N arbitrary thresholds. Chosen:
  the two-column model above. (N thresholds would be a child table.)
- **D3. Trigger cadence: daily cron.** Real-time (event-driven on balance write)
  is staged behind D3 and off by default, for the coupling reason in Section 6.
- **D4. Severity: low = `WARNING`, high = `INFO`.** A low balance is actionable;
  a high balance is informational (e.g. "time to move cash to savings").
- **D5. Re-arm re-fire mechanism:** dismiss-prior vs crossing-ordinal in the
  dedupe key. Both hold INV-BALANCE-001; pick one for consistency with reminders.
- **D6. Eligible account types.** Default: all non-closed accounts with a
  threshold set. Open question whether the `INVESTMENT_BROKERAGE` securities
  sleeve (which holds securities, not cash) should be excludable, or only its
  `INVESTMENT_CASH` sibling eligible -- decided against the account-type/sub-type
  the util in `investment-filter.util.ts` already distinguishes.
- **D7. Credit accounts.** For a `CREDIT_CARD`/`LINE_OF_CREDIT`, "low balance"
  means approaching the credit limit rather than approaching zero. Whether the
  low threshold is compared to `current_balance` or to
  `credit_limit - current_balance` for those types is a product decision; the
  default is the raw `current_balance` comparison, and the copy says so.

---

## 8. Test matrix (all offline-runnable: unit + source-scan)

Adversarial inputs drawn from `docs/testing-contract.md`.

1. **Crossing once, not per-run** (INV-BALANCE-001): runs 2-3 of the worked
   example raise exactly one row; run 5 raises a second after re-arm at run 4.
2. **Boundary equality**: `B == T_low` re-arms and does not fire; `B` one minor
   unit below fires. Strict-`<` low, strict-`>` high.
3. **Both thresholds set, independent latches**: a balance that crosses low does
   not touch `armed_high`, and vice versa.
4. **Closed account excluded**; absent balance treated as `0` (INV-BALANCE-005).
5. **Write door** (INV-BALANCE-003): the producer's INSERT is the door's;
   `notification-write-door.spec.ts` still finds one writer.
6. **Currency**: threshold in the account currency; no rate is consulted (assert
   no FX resolver call in the producer).
7. **Concurrency**: two runs of the same account do not both fire (the per-account
   transaction + row lock serialises; the latch is decided on the locked row).
8. **Category wiring**: `notification-category.spec.ts` accepts the two new types
   at <= 30 chars and maps them to `BALANCES`; the channel/preference/push-copy
   `Record`s are exhaustive; the two frontend contract tests pass.
9. **Delivery matrix**: a user with `balances` push off, email on, receives the
   email and no push -- exercised through the dispatch seam's existing tests with
   the new category.

Integration (CI-owned, needs a real database): the latch read-modify-write under
`withScopedDb`, the RLS policy on the new columns, and the schema-vs-migrations
drift for the migration.
