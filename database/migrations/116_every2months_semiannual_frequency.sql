-- Add EVERY2MONTHS and SEMIANNUAL as supported frequencies for scheduled
-- transactions (mny-import plan, task B3). Microsoft Money has both cadences
-- (`BILL.frq` 5 and 7), and until now the .mny importer had to downgrade them
-- to MONTHLY / QUARTERLY with a per-bill warning.
--
-- The frequency column is VARCHAR(20) so no DDL change is needed; the values
-- are validated by the backend enum (FrequencyType). This migration exists to
-- keep schema.sql and migrations in sync, mirroring 041_every4weeks_frequency.
-- No-op: the column already accepts any string value up to 20 characters.
SELECT 1;
