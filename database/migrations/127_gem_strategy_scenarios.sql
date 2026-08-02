-- GEM strategy: several named scenarios per user instead of exactly one.
--
-- Everything a GEM strategy carries is a modelling choice a reasonable investor
-- might want to hold two views on at once: a 12-month window against a
-- 6-month one, monthly against quarterly, US-listed instruments against their
-- UCITS equivalents, or the same rules run separately per account because the
-- tax rate differs between them. Signals are already keyed by strategy_id, so
-- each scenario materializes and keeps its own evaluation history and the two
-- can be compared once they have both run.
--
-- The unique index on user_id is what allowed only one, so it becomes a plain
-- index. `name` distinguishes them in the report's switcher; existing rows are
-- backfilled by the column default, which is also what a scenario created
-- without a name gets.

ALTER TABLE gem_strategies
    ADD COLUMN IF NOT EXISTS name VARCHAR(100) NOT NULL DEFAULT 'GEM';

-- DROP then CREATE rather than a conditional: replaying this migration on top
-- of an up-to-date schema.sql must leave the same plain index behind, and the
-- unique one may or may not be what is currently there.
DROP INDEX IF EXISTS idx_gem_strategies_user;
CREATE INDEX IF NOT EXISTS idx_gem_strategies_user ON gem_strategies(user_id);

COMMENT ON COLUMN gem_strategies.name IS
    'Scenario name shown in the report switcher; several per user are allowed';
