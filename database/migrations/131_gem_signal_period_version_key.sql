-- Let each evaluation version own its own row for a period.
--
-- Migration 130 made an older-version row immutable: the record of what the
-- strategy decided and what the user executed is not something a later release
-- may quietly rewrite. But the unique key was still (strategy_id,
-- evaluated_on), so that immutable row also blocked the current version from
-- storing its own answer for the same period -- and the day an algorithm bump
-- shipped mid-period, the report lost the signal governing today and could not
-- get it back until the next evaluation. A quarterly strategy would have waited
-- three months for an instruction it was entitled to immediately.
--
-- Keying on the version instead lets the two coexist: the old row stays exactly
-- as it was written, and the current version materializes beside it. Reads
-- already filter to the current version, so the history, the predecessor chain
-- and the backtest see one version's decisions and never a mixture.
--
-- Note the index is what the concurrent insert (ON CONFLICT DO NOTHING) uses to
-- arbitrate, so it must exist before two readers can race for a period.

DROP INDEX IF EXISTS idx_gem_strategy_signals_period;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gem_strategy_signals_period
    ON gem_strategy_signals(strategy_id, evaluated_on, algorithm_version);
