-- GEM strategy: many brokerage accounts per strategy.
--
-- The signal depends only on prices, so it is the same for every account -- but
-- the holdings it is compared against are spread across whichever accounts the
-- investor runs the strategy in. `gem_strategies.account_id` could name only
-- one, so the report ignored positions held elsewhere. The join table replaces
-- it and the report sums the strategy's securities across every selected
-- account.
--
-- The single account each strategy already had is carried over, so an existing
-- configuration keeps working unchanged.

CREATE TABLE IF NOT EXISTS gem_strategy_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy_id UUID NOT NULL REFERENCES gem_strategies(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gem_strategy_accounts_pair
    ON gem_strategy_accounts(strategy_id, account_id);
CREATE INDEX IF NOT EXISTS idx_gem_strategy_accounts_user
    ON gem_strategy_accounts(user_id);

-- Carry the previous single account over, then retire the column. Guarded so
-- the migration is idempotent and safe on a database created from a schema that
-- never had the column.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'gem_strategies' AND column_name = 'account_id'
    ) THEN
        INSERT INTO gem_strategy_accounts (user_id, strategy_id, account_id)
        SELECT s.user_id, s.id, s.account_id
          FROM gem_strategies s
         WHERE s.account_id IS NOT NULL
        ON CONFLICT (strategy_id, account_id) DO NOTHING;

        ALTER TABLE gem_strategies DROP COLUMN account_id;
    END IF;
END $$;

-- Row-Level Security: the table carries its own user_id, so it takes the same
-- Group A predicate as the rest of the strategy tables (migration 124). Like
-- that one, it is numbered after 123_rls_enable.sql and so enables RLS itself.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'app_current_user_id'
    ) THEN
        RETURN;
    END IF;

    DROP POLICY IF EXISTS gem_strategy_accounts_isolation ON gem_strategy_accounts;
    CREATE POLICY gem_strategy_accounts_isolation ON gem_strategy_accounts
      USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
      WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

    ALTER TABLE gem_strategy_accounts ENABLE ROW LEVEL SECURITY;
END $$;
