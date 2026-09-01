# Notification preferences and delivery control

Status: DRAFT (spec-first, per `backend/CLAUDE.md` "a feature of any substance
starts from a short approved spec committed before the implementation").
Owner: notification-center. Related: discussion #1291, INV-NOTIFY-001,
INV-PUSH-001..005.

This spec covers the *preferences and delivery* layer on top of the existing
notification center (one `notifications` table, one write door
`NotificationService.create`, one push transport `WebPushSender`). It does not
change what a producer decides to say; it decides **whether, where, how often,
and how loudly** each notification reaches a user.

The as-is map, the concrete data model, the migration number and the per-file
integration plan are filled in Sections 8-11 after the code survey; Sections
1-7 are the design and are stable regardless of that survey.

---

## 1. Requirements (from the user and discussion #1291)

R1. Notifications are organised into **groups**: security, system, balances,
    transactions, investments, securities prices, budgets, bills, goals.

R2. A **matrix** of group x channel decides delivery. Channels: in-app (bell),
    email, web push, UnifiedPush/ntfy (future).

R3. A notification may be delivered **once** or **repeatedly** on an interval.
    The interval is user-defined, with a **minimum of 5 minutes**.

R4. A repeating notification must be **stoppable** from the phone (the app UI)
    **and** from the notification itself (a Stop action on the push).

R5. For securities-price notifications, include a **chart** in the push if the
    platform supports it.

R6. **Clicking a notification opens the page that contains exactly that
    information** (a precise deep link, not a generic landing page).

R7. **Grouping / throttling rules** are configurable: e.g. if a notification
    from the same group fired in the last 15 minutes, do not notify again.

R8. (maintainer, #1291) history expires automatically [done: `purgeOld`];
    security notifications are opt-in; balance thresholds are user-configurable;
    per-device push toggles; localisation follows the user's language.

Non-goals (explicitly deferred by the maintainer): restored/cloned-environment
safety for subscriptions; a Firebase/APNs path. UnifiedPush is scaffolded but
its transport is out of scope for the first cut (the matrix column renders as
"coming soon" and stores the preference so no migration is needed later).

---

## 2. Vocabulary

- **Group** -- a stable key naming a family of notifications
  (`security`, `system`, `budgets`, `bills`, `balances`, `transactions`,
  `investments`, `prices`, `goals`). Derived from a notification's `type`, never
  stored on the row (same rule as `notificationCategoryOf`; the group is a
  function of the type, so renaming a group cannot orphan history).
- **Channel** -- a delivery transport: `in_app`, `email`, `push`,
  `unifiedpush`. `in_app` is the source of truth (the row in `notifications`);
  the others are fan-outs.
- **Preference** -- a per-user, per-group record carrying the channel matrix
  (four booleans) plus the group's throttling window and repeat policy.
- **Reminder** -- an active, repeating re-delivery of one notification (or one
  group condition) on an interval until stopped. Distinct from a *schedule*
  (bills) which is about when a transaction posts.

---

## 3. The group x channel matrix (R1, R2)

One row per (user, group). Columns: `in_app`, `email`, `push`, `unifiedpush`
(booleans), plus `throttle_minutes` and the repeat policy (Section 5). Absent
row -> defaults below. The matrix is resolved once, server-side, by
`resolveNotificationPreference(userId, group)`; every producer and every
fan-out consults it, so a user's choice cannot hold on one path and not another
(the same "one write door" discipline the notifications table already has).

Proposed default matrix (a preference-less user):

| Group        | in_app | email | push | unifiedpush | throttle |
|--------------|:------:|:-----:|:----:|:-----------:|:--------:|
| security     |   on   |  on   | off  |     off     |   0 min  |
| system       |   on   |  on   | off  |     off     |  15 min  |
| budgets      |   on   |  off  | off  |     off     |  60 min  |
| bills        |   on   |  off  | off  |     off     |   0 min  |
| balances     |   on   |  off  | off  |     off     |  60 min  |
| transactions |   on   |  off  | off  |     off     |  15 min  |
| investments  |   on   |  off  | off  |     off     |   0 min  |
| prices       |   on   |  off  | off  |     off     |   5 min  |
| goals        |   on   |  off  | off  |     off     |   0 min  |

Rationale: in-app is always the record (a user opts a group *out* of the bell
deliberately, which is allowed but off the default path). email defaults on only
where the message is important and infrequent (security, system). push defaults
off because it requires per-device enablement first (a matrix cell cannot turn a
device on). `unifiedpush` is stored but inert until the transport ships.

**in_app is always on; it is the record.** The maintainer's ruling is that the
bell shows *all* unread notifications, so `in_app` is not a user-toggled column
in the first cut -- the notifications table stays the source of truth and the
throttle below never suppresses an in-app row. The columns the user toggles are
`email`, `push`, `unifiedpush`; the matrix still *renders* an in-app column, but
locked on, so the grid reads as a complete matrix and a future "mute a whole
group's bell entries" decision has an obvious home. (If that decision is later
taken, `in_app=off` means the row is not written -- there is no hidden state.)

**Groups vs. what exists today.** The nine groups above are the *target*. Today
only three of them have producers, and the code already names them:
`notificationCategoryOf(type)` derives `PAYMENTS` (bills), `BUDGETS` (the nine
budget types) and `SYSTEM` (the seven system types). The other groups
(`balances`, `transactions`, `investments`, `prices`, `goals`, `security`) have
**no producers yet** -- each is its own follow-on feature (the maintainer has
asked for balance thresholds; price alerts and the rest follow). So the matrix
ships for the three live categories first and each new group arrives *with its
producer*, never as a dead row. The preference key is the derived category, so
adding a group is one `NotificationCategory` member plus its producer.

Security is opt-in per the maintainer; there is no security *category* yet (no
login/2FA notification types exist), so it enters with those producers.

---

## 4. Throttling / grouping rules (R7)

A per-group `throttle_minutes` window. When a producer is about to create a
notification of group G for user U, the write door checks whether a
**non-dismissed** notification of group G for U was created within the last
`throttle_minutes`. If so, the new one is **suppressed** (returns the "somebody
else holds this" null shape the door already uses for a dedupe conflict), except:

- `throttle_minutes = 0` disables throttling for that group (bills, investments,
  goals default to 0 because each event is its own subject the user wants).
- Throttling is **per group, per user**, evaluated *inside the same transaction*
  as the insert (a check that can refuse belongs in the write transaction --
  `backend/CLAUDE.md` "Rejection happens before the write"), and under the
  advisory/uniqueness guard the door already holds, so two producers racing the
  same window cannot both pass.
- Throttling suppresses **delivery of a new row**, never the existing one; and it
  never suppresses a *higher-severity* escalation of the same subject (a `critical`
  after a `warning` in the same window is delivered, because silence on an
  escalation is the dangerous direction). Severity is already on the row.

This is a **rate limit layered on top of** the existing exact-duplicate dedupe
(the fingerprint / dedupe-key unique index), not a replacement: dedupe stops the
identical row, throttle stops a *different* row of the same group too soon.

The window is a preference, so it is resolved through
`resolveNotificationPreference`. `docs/concurrency-and-idempotency.md` gains an
entry: "notification group throttle -- windowed count inside the write
transaction, mechanism = the notifications insert transaction + the existing
dedupe index".

---

## 5. Repeat / one-time re-delivery (R3, R4)

Most notifications are one-shot. A user may additionally ask that a *group* (or a
specific still-unread notification) be **re-delivered on an interval** until they
act -- a nag for a due bill, a breached balance threshold, a price target.

Model: a `notification_reminders` record: `{ user_id, group_key,
source_notification_id?, interval_minutes, next_fire_at, created_at,
stopped_at }`. `interval_minutes >= REMINDER_MIN_INTERVAL_MINUTES = 5` (a
constant, enforced by the DTO `@Min(5)` and re-checked server-side; a stored
value below it is clamped up, never down). `repeat_mode` on the preference is
`off | once | repeat`:

- `off` -- normal one-shot delivery (default for every group).
- `once` -- deliver, then a single follow-up after `interval_minutes`, then stop.
- `repeat` -- deliver every `interval_minutes` until stopped.

Firing: a cron (`@Cron` every minute, min interval 5 so a one-minute tick is
cheap and precise) claims due reminders per user (`withUserContext`), re-emits
through the **same write door** (so throttle/matrix still apply -- a repeat is
still subject to the channel matrix), advances `next_fire_at`, and for `once`
sets `stopped_at`. Claiming uses the existing per-user job-lease mechanism so a
second replica does not double-fire (`docs/cron-jobs.md`).

Stopping (R4), three doors, all landing on the same `stopReminder(userId, id)`:

1. **From the app** -- a Stop control on the notification row / group settings.
2. **From the push notification** -- the push carries
   `actions: [{ action: 'stop-reminder', title: 'Stop' }]` and a
   `reminderId` in its (encrypted) data. The service worker's
   `notificationclick` handler, on `event.action === 'stop-reminder'`, issues a
   same-origin `fetch('/api/v1/notifications/reminders/<id>/stop', {method:'POST',
   credentials:'include'})` (cookies ride same-origin, and the CSRF double-submit
   cookie is readable in the SW to set the header). A failure is retried once and
   otherwise surfaced as a follow-up notification "could not stop -- open Monize"
   rather than silently leaving the nag running.
3. **From opening the notification** -- clicking the body (not the Stop action)
   deep-links to the subject (R6) and marks read; a read notification whose
   `repeat_mode = once` is considered acted-on and its reminder is stopped.

Safety: a reminder is stopped when its `source_notification_id` is dismissed or
the underlying condition clears (the bill posts, the balance recovers), so a nag
cannot outlive its cause. The producer that clears the condition calls
`stopRemindersFor(sourceNotificationId)`.

`notification_reminders` is user-owned and RLS-scoped like every other table.

---

## 6. Deep linking (R6)

Every notification already carries `target` (a route). The rule this spec adds:
**`target` names the most specific page that shows the notification's own
subject**, not a section landing page. Examples:

- a bill reminder -> the scheduled transaction / bills view focused on that bill;
- a balance-threshold alert -> `/accounts/<accountId>`;
- a price alert -> `/securities/<securityId>`;
- a budget alert -> the budget's detail;
- a backup failure -> the backup settings section;
- a security alert -> the security settings / sessions page.

The service worker's `notificationclick` focuses an existing client on `target`
if one is open (posting it a navigate message) and otherwise opens a new window
at `target`. A guard test asserts every producer sets a `target` and that the
target resolves to a real route prefix (a scan over the route table).

`target` is a path only (never an absolute URL), resolved against the app origin
in the SW -- the "a target is a path, not a URL" rule mirrors the push-endpoint
SSRF discipline in reverse.

---

## 7. Chart-in-push feasibility (R5)

Findings (to be re-verified against the shipping browsers):

- The Web Notifications `image` field (the "big picture") is supported on
  **Android Chrome/Edge** and some desktop Chromium; it is **not** rendered on
  iOS/Safari web push, and Firefox support is partial. So a chart-in-push is a
  progressive enhancement, never the only carrier of the information.
- The push *payload* is capped (~4KB after encryption), so the chart is **not**
  inlined as a data: URI. Instead the payload carries a **path** to a
  server-rendered PNG, and the browser (not our page) fetches it when it expands
  the notification -- so the app CSP does not apply, but the URL must be
  unguessable and short-lived because the fetch is unauthenticated.
- Therefore: `prices` notifications may set `payload.image = '/api/v1/push/
  chart/<token>.png'`, where `<token>` is a single-use, short-TTL, HMAC-signed
  reference to a pre-rendered chart the backend holds (no user input in the path;
  CWE-22 validated). The renderer produces a small sparkline of the security's
  recent closes. The SW passes `image` straight through to `showNotification`.
- Fallback: where `image` is unsupported the notification is text-only with the
  price move in the body; the deep link (R6) opens the full chart on
  `/securities/<id>`. **The chart is a nicety; the number and the link are the
  contract.**

This is the highest-risk, lowest-portability requirement; it ships last (Phase 5)
and behind a per-group toggle, defaulting off until validated on real devices.

---

## 8. Current system (as-is)

- **One table, one write door.** `notifications` (renamed from `budget_alerts`
  by migration 172). `NotificationService.create(userId, input)` is the sole
  writer (`notification-write-door.spec.ts` enforces it): a raw
  `INSERT ... ON CONFLICT DO NOTHING RETURNING id` (no conflict target, so it
  covers both the budget fingerprint index and the `dedupe_key` index), then a
  read-back inside the same `withScopedDb` transaction. `null` means another
  replica holds the row -- "not yours to email about".
- **Category is derived, never stored.** `notificationCategoryOf(type)`:
  `BILL_DUE -> PAYMENTS`; the seven `SYSTEM_NOTIFICATION_TYPES -> SYSTEM`; the
  nine budget types `-> BUDGETS`. `NotificationCategory` = `{PAYMENTS, BUDGETS,
  SYSTEM}`, with the entity comment already naming Investments/Goals/Imports as
  future members. **This is the group axis this spec builds on.**
- **17 `alert_type` values** (`NotificationType`): 9 budget, 1 payment
  (`BILL_DUE`), 7 system (`BACKUP_FAILED`, `BACKUP_PARTIAL`,
  `ENCRYPTION_KEY_MISSING`, `PROVIDER_OUTAGE`, `PROVIDER_RECOVERED`,
  `SMTP_FAILURE`, `SCHEDULED_POST_FAILED`).
- **Email is per-producer, gated by `user_preferences.notification_email`.**
  Producers: `budget-alert.service.ts` (immediate + weekly digest),
  `system-alert.service.ts` (admin fan-out, `queryAdminRecipients.emailEnabled`),
  `bill-reminder.service.ts` (daily digest, gated on `notificationEmail`,
  email-only, no in-app row). Locale for any off-request copy resolves through
  `emailTranslator(i18n, lang)` + `resolveUserEmailLocale`.
- **Push is built but unwired.** `WebPushSender.send` is called only by
  `PushSubscriptionService.sendTest` (the `POST /push/test` button). There is no
  `sendToUser`, and nothing bridges `NotificationService.create -> push`.
  `PushPayload.collapseKey` is required and privacy-minimal (no amounts). The
  service worker's `push`/`notificationclick` handlers exist; `collapseTag` does
  device-side collapse; **no `actions` and no `image` are used yet**.
- **Existing prefs:** `notification_email` (enforced), `notification_browser`
  (persisted, gates nothing today -- a dormant hook), `budget_digest_enabled` /
  `budget_digest_day`. No per-category, per-channel, quiet-hours or throttle
  preference exists. Settings UI: `NotificationsSection.tsx` (email toggle +
  digest + test-email, then the push panels).
- **Deep-link mechanism exists:** `target` (same-origin path, <=255), validated
  three times (`boundedTarget` at the door, `safeNotificationTarget` in the app,
  `safeNotificationPath` in the worker). `notification-target.contract.test.ts`
  asserts every producer's literal target resolves to a real App Router page.
  `/bills` is used for bills (there is no per-bill route yet).

## 9. Data model and migration

**Phase 1 table (migration 173)** -- `notification_preferences`, user-owned:

```sql
CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id    uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category   varchar(20) NOT NULL,     -- NotificationCategory member
    email      boolean NOT NULL DEFAULT true,
    PRIMARY KEY (user_id, category)
);
-- RLS: policy notification_preferences_isolation on user_id + ENABLE (Section 6
-- pattern from migrations 171/172). Classify in support-backup-rules.ts.
```

Only the columns Phase 1 consumes exist (`email`). Later phases add columns in
their own migrations as they wire a channel: `push` + `unifiedpush` +
`throttle_minutes` with Phase 4's push dispatch; the repeat policy lands on a
separate `notification_reminders` table (Section 5) in Phase 4/5. This keeps the
"no column without a consumer" discipline rather than a wide, half-dead table.

`schema.sql` updated in the same commit; migration idempotent
(`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`);
replays as a no-op on a fresh `schema.sql` (`scripts/verify-schema.sh`). No new
SQL function, so `required-db-functions.ts` is untouched. New table must be
exported by the backup or listed excluded -- it is user data, so **exported**
(add to `export-table-queries.ts`, `restore-plan.ts` after `users`, and classify
in the support backup).

Default resolution: absent row -> `email` defaults from the *legacy*
`notification_email` (so an existing user who turned all email off keeps it off
until they touch the new matrix), then from the Section 3 table per category.
`resolveNotificationEmailPreference(userId, category)` is the one reader.

## 10. Integration plan (per file)

Phase 1 (this slice):

- `backend/src/notification-center/entities/notification-preference.entity.ts`
  (new) -- `NotificationPreference`.
- `backend/src/notification-center/notification-preference.service.ts` (new) --
  `resolve(userId)` (all categories, filling defaults), `resolveEmail(userId,
  category)`, `setEmail(userId, category, enabled)`. All through `withScopedDb`.
- `backend/src/notification-center/notification-preference.controller.ts` (new)
  -- `GET /notifications/preferences`, `PUT /notifications/preferences/:category`
  (JWT, `ParseEnumPipe` on category, DTO `{email: boolean}`).
- Wire the three email producers to `resolveEmail(userId, category)` instead of
  the bare `notification_email` read; keep `notification_email` as the default
  seed and the global master switch (email off globally still wins -- the
  per-category matrix narrows, never widens, an off master).
- `frontend/src/components/settings/NotificationPreferencesMatrix.tsx` (new) --
  the category x channel grid (in_app locked-on, email toggle per category),
  mounted in `NotificationsSection.tsx` in place of the single email toggle.
- `frontend/src/lib/notification-preferences.ts` (new) -- api client + the
  category list + default table mirrored from the backend (contract test).
- i18n: `settings.notifications.preferences.*` (category labels, channel
  headers, help), English-first + every locale.

Later phases: Section 4 (throttle) adds `throttle_minutes` + the dispatch check;
Section 6 (deep-link) sharpens targets and adds routes; Section 5 (push +
reminders) builds `sendToUser`, the `push` column, SW `actions`/`image`, and
`notification_reminders` + its cron + stop endpoint.

## 11. Test matrix

Phase 1 (all offline-runnable -- unit + source-scan; the DB-backed integration
spec is written but noted as un-run here, no PostgreSQL in this environment):

- Resolver: absent row -> per-category default; legacy `notification_email=false`
  -> email default off for every category; explicit row wins; unknown category
  rejected.
- Master switch: `notification_email=false` globally suppresses email even where
  a category row says on (narrows, never widens).
- Write door unchanged: `create` still writes the in-app row regardless of the
  email matrix (bell shows all) -- a regression test that a category with email
  off still produces a bell row.
- Each of the three email producers: email sent iff `resolveEmail` true; the
  in-app row is created either way.
- Contract: frontend category list + defaults equal the backend
  (`notification-preferences.contract.test.ts`), like the existing
  `notification.contract.test.ts`.
- UI: the matrix renders one row per live category, toggling email calls the
  api and updates optimistic state; email column disabled when SMTP is
  unconfigured (mirrors the existing gate).
- i18n parity across every locale; pseudo fresh.
- Backup: `notification_preferences` is exported and restored (golden
  support-backup classification test).

---

## 12. Open decisions (resolved with defaults, since the design proceeds autonomously)

D1. **Preference storage**: a dedicated `notification_preferences` table
    (one row per user+group) rather than a JSONB blob on `user_preferences`,
    because the throttle window and repeat policy are queried by the cron and
    benefit from being columns. Chosen: dedicated table.

D2. **in_app off = not written**: chosen (Section 3), because a "written but
    hidden" state is a second source of truth for unread counts.

D3. **Throttle default 15 min** only for system/transactions; event-per-subject
    groups (bills, investments, prices low, goals) default to 0 or 5. Chosen as
    tabulated; every value is a default a user can change.

D4. **Reminder minimum 5 min**: chosen constant `REMINDER_MIN_INTERVAL_MINUTES`,
    enforced both in the DTO and server-side (clamp up).

D5. **Chart-in-push**: progressive enhancement, Android-only, ships last, default
    off. Chosen.

D6. **Security opt-in**: default on for in_app+email but fully user-toggleable.
    Chosen (matches maintainer "optional, not mandatory").

Every default above is a **reviewable decision, not a fact about the domain** --
a human (the maintainer) confirms the matrix defaults and the throttle windows
before this ships to users, per the org rule that AI output is auxiliary.
