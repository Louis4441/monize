-- Record which configuration each GEM signal was calculated under.
--
-- A stored signal is keyed by (strategy_id, evaluated_on) and was treated as
-- permanently complete, but the inputs behind it are editable: the momentum
-- lookback, the cadence, the instrument in each role and which leg the absolute
-- test measures against. Change the lookback from 12 months to 6 and the report
-- kept serving a row decided on the old window -- presented as the current
-- instruction, with the current instruments' names on it.
--
-- The fingerprint is a hash of exactly those signal-driving fields. A stored
-- period whose fingerprint no longer matches the strategy is recomputed on the
-- next read rather than trusted; everything else about the row (the period, the
-- momentum snapshot it was decided on) is unchanged.
--
-- Nullable on purpose: rows written before this column existed have unknown
-- provenance, and unknown must not read as "matches". They recompute once, on
-- the first read after deploy, and carry a fingerprint from then on.

ALTER TABLE gem_strategy_signals
    ADD COLUMN IF NOT EXISTS config_fingerprint VARCHAR(64);

COMMENT ON COLUMN gem_strategy_signals.config_fingerprint IS
    'Hash of the cadence, lookback and role-to-security mapping this signal was calculated under; NULL for rows predating the column';
