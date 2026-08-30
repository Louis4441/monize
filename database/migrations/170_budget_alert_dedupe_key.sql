-- System-level alerts (BACKUP_FAILED, PROVIDER_OUTAGE, SMTP_FAILURE, ...) live
-- in budget_alerts with budget_id NULL, and idx_budget_alerts_fingerprint
-- cannot arbitrate those rows: budget_id is not COALESCE'd there, and NULL
-- never equals NULL in a unique index. Every replica runs every cron, so
-- without a database key each replica would insert its own copy of the same
-- alert and each copy would try to email the administrators.
--
-- dedupe_key is the explicit fingerprint a system alert carries
-- (e.g. 'BACKUP_FAILED:<userId>:<date>'); the partial unique index makes
-- INSERT ... ON CONFLICT DO NOTHING RETURNING id the cross-replica arbiter for
-- both the row and its email (only the insert winner sends). Budget-generated
-- alerts keep dedupe_key NULL and stay governed by the fingerprint index.
ALTER TABLE budget_alerts ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(120);

CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_alerts_dedupe
    ON budget_alerts(user_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
