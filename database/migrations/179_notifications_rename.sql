-- budget_alerts becomes notifications (discussion #1291, phase 2).
--
-- The table stopped being about budgets some time ago: BACKUP_FAILED,
-- SMTP_FAILURE, PROVIDER_OUTAGE and SCHEDULED_POST_FAILED already live in it
-- with budget_id NULL, and it is what the bell in the header reads. The name was
-- the last thing still claiming otherwise, and a name that lies is how a second
-- table gets created beside it -- which is exactly what discussion #1291
-- proposed and what this rename makes unnecessary. One durable notification
-- row, one read model, one creation door.
--
-- Exactly one column arrives with the rename. `target` is the in-app path a
-- notification points at -- the bell can link, and a Web Push payload already
-- has a `target` field with nothing producing one. It is real data: nothing
-- else in the row says where to send the reader.
--
-- Four fields from the discussion are deliberately NOT added, because the table
-- already answers them:
--
--   * `category` (what the notification is *about*, and what a per-category
--     preference keys on) is a pure function of `alert_type` -- ten budget types
--     collapse to BUDGETS, BILL_DUE is PAYMENTS, the seven system types are
--     SYSTEM. Stored, it would be a second copy of an answer the row already
--     carries, kept correct only by every producer remembering to write it; the
--     one raw INSERT in this codebase would have inherited a column default and
--     filed budget alerts under SYSTEM. Derived, it is `notificationCategoryOf`
--     in the notification entity -- one total function over the enum, and no way
--     for a row to disagree with itself.
--   * `priority` (INFO/WARNING/IMPORTANT) is `severity`, which has carried
--     exactly that meaning since the first budget alert. Two columns on one axis
--     is how the answers drift.
--   * `title_key` / `message_key` would be a second localization mechanism.
--     Rows already store an English fallback plus the facts in `data`, and the
--     client renders the copy in the reader's language from those; a server-
--     composed surface (a Web Push body) resolves the recipient's own locale
--     through `emailTranslator`. Both work today.
--   * `expires_at` is still an open product question in the discussion ("should
--     notification history expire automatically?"), and a column nothing writes
--     is not a feature.

ALTER TABLE IF EXISTS budget_alerts RENAME TO notifications;

ALTER INDEX IF EXISTS idx_budget_alerts_user RENAME TO idx_notifications_user;
ALTER INDEX IF EXISTS idx_budget_alerts_user_unread
    RENAME TO idx_notifications_user_unread;
ALTER INDEX IF EXISTS idx_budget_alerts_budget_period
    RENAME TO idx_notifications_budget_period;
ALTER INDEX IF EXISTS idx_budget_alerts_fingerprint
    RENAME TO idx_notifications_fingerprint;
ALTER INDEX IF EXISTS idx_budget_alerts_dedupe
    RENAME TO idx_notifications_dedupe;

-- The policy names the table it is on, so it is re-created rather than renamed;
-- the ENABLE is idempotent and repeated here because this migration is numbered
-- after 123_rls_enable.sql, which never runs again on a deployed database.
DROP POLICY IF EXISTS budget_alerts_isolation ON notifications;
DROP POLICY IF EXISTS notifications_isolation ON notifications;
CREATE POLICY notifications_isolation ON notifications
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- The in-app path this notification points at, e.g. '/budgets/<id>' or
-- '/settings'. Always a same-origin path, never a URL: the service worker
-- resolves it against the app's own origin and discards anything that leaves it.
-- Nullable because most rows have nowhere specific to send the reader.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target VARCHAR(255);
