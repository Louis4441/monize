-- Row-Level Security policy for security_documents (migration 117).
--
-- The table carries its own user_id, so it belongs with the "direct" policies of
-- migration 112. It could not be in that array because it did not exist yet, and
-- 112 has already run everywhere.
--
-- Inert on its own, exactly like 112: a policy on a table that has not had
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY is never consulted by the planner.
-- The enable step lives with the rest of the rollout, so this changes no query
-- result today -- it only means that when RLS is switched on, this table is not
-- the one hole left in the securities family.
--
-- Predicate form copied from 112 deliberately: the helpers are called as scalar
-- subqueries so the planner evaluates them once per statement as an InitPlan
-- rather than once per row.

DROP POLICY IF EXISTS security_documents_isolation ON security_documents;
CREATE POLICY security_documents_isolation ON security_documents
  USING (
    user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls())
  )
  WITH CHECK (
    user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls())
  );

-- And the touch trigger every sibling table with an updated_at column has. The
-- entity's @UpdateDateColumn covers writes through the app, but a direct-SQL
-- update -- a restore, a support fix -- would otherwise leave updated_at stale.
DROP TRIGGER IF EXISTS update_security_documents_updated_at ON security_documents;
CREATE TRIGGER update_security_documents_updated_at
  BEFORE UPDATE ON security_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
