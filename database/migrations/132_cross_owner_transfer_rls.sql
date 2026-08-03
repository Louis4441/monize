-- 132: Cross-owner transfers -- delegate-read policy arm on transactions.
--
-- Replaces the uniform direct-ownership policy on transactions with a
-- dedicated one whose USING adds a read arm for delegates: rows in an account
-- covered by an active can_read grant become visible to the delegate's own
-- session (app.real_user_id), matching the access the delegation feature
-- already grants at the app layer. This is what lets a cross-owner transfer
-- counterpart (and the acting delegate's eager linkedTransaction join, broken
-- under enforce until now) load under RLS_MODE=enforce.
--
-- WITH CHECK stays owner-only: cross-owner WRITES (inserting the foreign leg,
-- updating the foreign balance) run under the narrow withSystemContext bypass
-- after in-code authorization -- safer than write-widening policies.
--
-- The ENABLE below is a no-op everywhere -- transactions is already enabled
-- (123_rls_enable.sql on migrated databases, schema.sql's dynamic enable loop
-- on fresh installs) -- but the post-123 convention requires every policy
-- migration to ship its own enable, and the T1 harness
-- (rls-harness.integration.spec.ts) enforces that mechanically.
--
-- Behavior-neutral at RLS_MODE=off/shadow (the app connects as the table
-- owner, so policies are not consulted).

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS transactions_isolation ON transactions;
CREATE POLICY transactions_isolation ON transactions
  USING (user_id = (SELECT app_current_user_id())
      OR (SELECT app_bypass_rls())
      OR EXISTS (SELECT 1 FROM account_delegate_grants g
                 JOIN account_delegates d ON d.id = g.delegation_id
                 WHERE g.account_id = transactions.account_id
                   AND g.can_read AND d.status = 'active'
                   AND d.delegate_user_id = (SELECT app_real_user_id())))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

-- The policy arm and CrossOwnerAccessService probe grants by account id;
-- only delegation_id was indexed before.
CREATE INDEX IF NOT EXISTS idx_adg_account ON account_delegate_grants(account_id);
