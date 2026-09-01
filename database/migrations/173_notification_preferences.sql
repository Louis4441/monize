-- Per-category notification channel preferences (discussion #1291;
-- docs/specs/notification-preferences.md).
--
-- One row per (user, category): which delivery channels that user wants for
-- that family of notifications. `category` is a NotificationCategory value
-- (PAYMENTS, BUDGETS, SYSTEM today, extensible) -- the same derived axis
-- notificationCategoryOf() produces, never a raw alert_type, so a new
-- notification type needs no new preference row and no per-user backfill.
--
-- Phase 1 carries the one channel that is live in production today: email.
-- Push, UnifiedPush and the per-group throttle window arrive with the dispatch
-- that reads them, in their own migrations, rather than as columns nothing yet
-- consults (the "no column without a consumer" rule). An absent row means the
-- default matrix in the spec, and the email default is seeded from the legacy
-- user_preferences.notification_email so an existing off choice is honoured
-- until the user touches the matrix.
--
-- Exported by backups: it is user data (see export-table-queries.ts and
-- restore-plan.ts). User-owned, so the uniform direct policy AND its own ENABLE
-- (this migration is numbered after 123_rls_enable.sql, which derives its
-- targets from pg_policies at the moment it runs and never runs again on a
-- deployed database).

CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- A NotificationCategory value. Kept short and unconstrained by a CHECK on
    -- purpose: the category set grows as producers for new groups land, and a
    -- CHECK would turn adding a group into a migration on this table.
    category VARCHAR(20) NOT NULL,
    email BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- One row per user per category. The PK's leading user_id column is also the
    -- lookup index every read uses (all of a user's rows), so no separate index.
    PRIMARY KEY (user_id, category)
);

DROP POLICY IF EXISTS notification_preferences_isolation ON notification_preferences;
CREATE POLICY notification_preferences_isolation ON notification_preferences
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
