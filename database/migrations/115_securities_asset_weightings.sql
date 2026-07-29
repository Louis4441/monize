-- Adds a manual asset-class allocation breakdown to securities. Like
-- country_weightings this is user-entered (providers do not supply it), but the
-- names are entirely free-text: the picker offers whatever the user has already
-- saved on any of their securities. Stored as an array of [{name, weight}]
-- where weight is a decimal 0-1. Any shortfall under 1.0 is treated as "Other"
-- at display time and is not stored.

ALTER TABLE securities ADD COLUMN IF NOT EXISTS asset_weightings JSONB;
