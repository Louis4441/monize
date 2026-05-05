-- 060: Track the last time we asked the quote provider for a long-range
-- (multi-year) historical backfill on a security. The Monte Carlo report
-- re-checks holdings on every account-selection change; without this guard
-- it kept calling fetchHistorical for any holding that didn't reach 10
-- years of yearly returns (e.g. recently-listed stocks), even though the
-- previous attempt had returned everything available.

ALTER TABLE securities
  ADD COLUMN IF NOT EXISTS historical_backfill_attempted_at TIMESTAMP;
