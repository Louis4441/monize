-- GEM (Global Equities Momentum) strategy: per-user configuration, the
-- instrument bound to each strategy role, and the evaluated signal history.
--
-- Three tables:
--   * gem_strategies        -- one configuration row per user (cadence, the
--     account the strategy trades in, and the cost assumptions used for the
--     transfer estimates). One row per user is enforced by a unique index.
--   * gem_strategy_assets   -- the security filling each strategy role. A role
--     with no security yet is either absent or has security_id NULL; the report
--     reports it as unmapped rather than guessing an instrument.
--   * gem_strategy_signals  -- one row per evaluation period. Momentum figures
--     are stored alongside the outcome so the history keeps what the decision
--     was actually made on, even if prices are later revised, and so the
--     "executed" flag has something stable to hang on.
--
-- ON DELETE CASCADE chains users -> gem_strategies -> assets/signals. A deleted
-- security or account leaves the configuration intact with a NULL reference,
-- which the report surfaces as an unmapped role / missing account instead of
-- silently dropping the strategy.

CREATE TABLE IF NOT EXISTS gem_strategies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    cadence VARCHAR(20) NOT NULL DEFAULT 'MONTHLY', -- 'MONTHLY' | 'QUARTERLY'
    lookback_months INTEGER NOT NULL DEFAULT 12, -- momentum window
    tax_rate_percent NUMERIC(9,4), -- applied to an estimated realized gain
    commission_amount NUMERIC(20,4), -- per-switch broker commission estimate
    rules_source_url VARCHAR(500),
    rules_source_label VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gem_strategies_user
    ON gem_strategies(user_id);

CREATE TABLE IF NOT EXISTS gem_strategy_assets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy_id UUID NOT NULL REFERENCES gem_strategies(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL, -- 'US_EQUITY' | 'EX_US_EQUITY' | 'EM_EQUITY' | 'SAFE'
    security_id UUID REFERENCES securities(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gem_strategy_assets_role
    ON gem_strategy_assets(strategy_id, role);
CREATE INDEX IF NOT EXISTS idx_gem_strategy_assets_user
    ON gem_strategy_assets(user_id);

CREATE TABLE IF NOT EXISTS gem_strategy_signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy_id UUID NOT NULL REFERENCES gem_strategies(id) ON DELETE CASCADE,
    evaluated_on DATE NOT NULL, -- price date the decision was taken on
    effective_from DATE NOT NULL, -- first day the allocation applies
    state VARCHAR(10) NOT NULL, -- 'RISK_ON' | 'RISK_OFF'
    target_role VARCHAR(20),
    target_security_id UUID REFERENCES securities(id) ON DELETE SET NULL,
    target_weight_percent NUMERIC(9,4) NOT NULL DEFAULT 100,
    momentum JSONB NOT NULL DEFAULT '{}'::jsonb, -- percent per role at evaluation time
    spread_pp NUMERIC(12,4), -- US equity momentum minus safe-asset momentum
    lead_pp NUMERIC(12,4), -- winner minus runner-up, RISK_ON only
    previous_role VARCHAR(20), -- role held before this evaluation
    executed BOOLEAN NOT NULL DEFAULT FALSE,
    executed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gem_strategy_signals_period
    ON gem_strategy_signals(strategy_id, evaluated_on);
CREATE INDEX IF NOT EXISTS idx_gem_strategy_signals_user
    ON gem_strategy_signals(user_id);

-- Row-Level Security: the three tables carry their own user_id, so they take
-- the same Group A predicate as every other direct tenant table (migration
-- 112). This migration is numbered after 123_rls_enable.sql, which derives its
-- targets from pg_policies at the moment it runs and will never run again on a
-- deployed database, so each table enables RLS for itself here. Enabling is
-- inert while the app connects as the table owner (RLS_MODE=off/shadow).
DO $$
DECLARE
    t text;
    gem_tables text[] := ARRAY[
        'gem_strategies',
        'gem_strategy_assets',
        'gem_strategy_signals'
    ];
BEGIN
    -- The helper functions arrive with migration 111; skip silently if this
    -- database has not reached it yet.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'app_current_user_id'
    ) THEN
        RETURN;
    END IF;

    FOREACH t IN ARRAY gem_tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I
               USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
               WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))',
            t || '_isolation', t
        );
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;
