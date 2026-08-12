-- 152: Add the per-user baseline for the Portfolio Value chart's change figure
--
-- The Change / Change % cards on the Portfolio Value chart and report measure
-- the short ranges (1D, 1W, MTD) from one of two points, and which one is a
-- preference rather than a fact:
--
--   previous_close - the close of the last trading day before the window, the
--                    convention every quote source reports a daily move against;
--   period_start   - the first point plotted, i.e. the day's open on 1D and the
--                    first bar of the week or month on 1W and MTD.
--
-- Default 'previous_close', which is the behaviour shipped in the same release.
-- The check constraint mirrors the @IsIn on UpdatePreferencesDto, so a value the
-- backend would reject cannot reach the column by another route.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS portfolio_change_baseline VARCHAR(20) NOT NULL DEFAULT 'previous_close';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'user_preferences_portfolio_change_baseline_check'
  ) THEN
    ALTER TABLE user_preferences
      ADD CONSTRAINT user_preferences_portfolio_change_baseline_check
      CHECK (portfolio_change_baseline IN ('previous_close','period_start'));
  END IF;
END $$;
