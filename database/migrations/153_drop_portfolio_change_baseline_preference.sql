-- 153: Drop the per-user baseline for the Portfolio Value chart's change figure
--
-- Reverses migration 152. The setting was added one release earlier and is not
-- wanted: the Change / Change % cards on the 1D / 1W / MTD ranges now always
-- measure from the close of the last trading day before the window, which was
-- 152's default and therefore the behaviour every user who never opened the
-- setting already had. Longer ranges continue to measure from their first
-- point, which is a property of those windows rather than of this column.
--
-- The column goes rather than staying unread. A preference no screen can set is
-- a value that can only ever hold its default, and every branch reading it is
-- dead code that still compiles and still has tests.
--
-- Dropping the column drops its check constraint with it; the explicit DROP
-- CONSTRAINT first keeps this replayable against a database where the column
-- was already removed by hand but the constraint somehow was not.

ALTER TABLE user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_portfolio_change_baseline_check;

ALTER TABLE user_preferences
  DROP COLUMN IF EXISTS portfolio_change_baseline;
