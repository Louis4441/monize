-- The `highcontrast` colour theme was removed: in dark mode it was
-- indistinguishable from `midnight` (both a black page under a near-black
-- card), and its light mode was the stock neutral palette with heavier
-- borders. The palette, its catalog strings and its entry in the theme list
-- are gone, so the stored value no longer names anything.
--
-- The clients already fall back safely -- both `ThemeContext` (localStorage)
-- and `PreferencesLoader` (the server preference) validate through
-- `isColorTheme`, so an unrecognised value is ignored and the user renders
-- the default palette. This migration exists so the stored row agrees with
-- what the user is actually seeing, rather than holding a name that resolves
-- to nothing: without it the Settings picker shows `default` selected while
-- the column says `highcontrast`, and the next save of any other preference
-- would be the first thing to reconcile them.
--
-- Idempotent by construction: replayed, the WHERE clause matches no rows.
UPDATE user_preferences
SET color_theme = 'default'
WHERE color_theme = 'highcontrast';
