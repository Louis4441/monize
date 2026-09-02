-- Per-category notification throttle window (discussion #1291;
-- docs/specs/notification-preferences.md section 4).
--
-- A rate limit layered on top of the existing exact-duplicate dedupe (the
-- fingerprint / dedupe_key unique index), not a replacement: dedupe stops the
-- identical row, throttle stops a *different* row of the same category too soon.
-- When a producer is about to create a notification of category C for user U,
-- the write door suppresses it if a non-dismissed notification of C for U was
-- created within the last throttle_minutes -- unless the new one is a
-- higher-severity escalation of the same category, which is always delivered.
--
-- DEFAULT 0 means "no throttle", so every existing user keeps exactly today's
-- delivery until they set a window in the matrix. The write door reads this
-- column inside its own insert transaction, under a per-(user, category)
-- advisory lock, so two producers racing the same window cannot both pass.

ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS throttle_minutes INTEGER NOT NULL DEFAULT 0;
