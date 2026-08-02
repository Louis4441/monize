-- Record which version of the evaluation code produced each GEM signal.
--
-- `config_fingerprint` (migration 129) answers "did the user change the
-- settings". It cannot answer "did the rules change", and the rules do change:
-- version 2 stopped accepting a boundary close struck more than a fortnight
-- before the boundary, so a version 1 row can carry a momentum computed from a
-- months-old quote under settings identical to today's. With only the
-- fingerprint to go on, that row matches and is served as the instruction to
-- act on now.
--
-- The two are kept apart deliberately, because they are handled differently. A
-- settings change is the user asking for a different answer, so the affected
-- periods are recomputed in place. An algorithm change is not: the row is the
-- record of what the strategy actually decided and what the user executed
-- against it, and rewriting it with today's code and today's (possibly revised)
-- prices would replace that record with a counterfactual. Older-version rows
-- are therefore left untouched and reported as legacy periods -- excluded from
-- the current history and the backtest, never destroyed.
--
-- Existing rows default to 1: every one of them predates the boundary rule.

ALTER TABLE gem_strategy_signals
    ADD COLUMN IF NOT EXISTS algorithm_version SMALLINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN gem_strategy_signals.algorithm_version IS
    'Version of the evaluation code that produced this row; older versions are legacy history and are never recomputed in place';
