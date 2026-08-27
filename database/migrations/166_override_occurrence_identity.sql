-- Issue #1247 re-audit: the override table's uniqueness described the wrong
-- column, and was therefore wrong in both directions at once.
--
-- An occurrence's IDENTITY is its recurrence slot, `(scheduled_transaction_id,
-- original_date)` -- that is what every read keys on (`overridesForOccurrence`
-- and the `byOriginal` map in backend/src/common/scheduled-occurrences.ts), and
-- what `createOverride` refuses a second of. `override_date` is the date the
-- occurrence was MOVED to: an attribute of the override, not its name.
--
-- The table carried `UNIQUE (scheduled_transaction_id, override_date)`, so:
--
--   * Two overrides could exist for one occurrence, as long as they had been
--     moved to different days. Two rows claiming to replace the same slot, and
--     the reader picks whichever the map's insertion order happens to keep --
--     so the amount, category and date a posting uses were decided by row
--     order. `createOverride`'s SELECT-then-INSERT was the only thing standing
--     between the API and that state, and a SELECT is not a lock: two
--     concurrent creates for one slot both saw no existing row and both wrote.
--
--   * Two DIFFERENT occurrences of one schedule could not be moved onto the
--     same day, which is an ordinary thing to want (pay the 1st and the 15th
--     together on the 10th) and was refused with a raw 500 from the driver.
--
-- Nothing reads by `override_date`, so its uniqueness bought nothing; the
-- lookup index this replaces (`idx_sched_txn_overrides_orig`) covers exactly
-- the new constraint's columns, so the constraint's own index takes over.

-- 1. Collapse the rows the missing constraint allowed. The most recently
--    updated row for a slot is the one the user last saved; the id breaks a tie
--    deterministically (`updated_at` is transaction start time, so a single
--    transaction's rows all share it). Idempotent: after this runs, no slot has
--    a second row for the DELETE to find.
DELETE FROM scheduled_transaction_overrides o
USING scheduled_transaction_overrides keep
WHERE o.scheduled_transaction_id = keep.scheduled_transaction_id
  AND o.original_date = keep.original_date
  AND o.id <> keep.id
  AND (keep.updated_at, keep.id) > (o.updated_at, o.id);

-- 2. The occurrence's identity, in the one place a duplicate cannot get past.
--    Dropped first so the migration replays as a no-op on a database that
--    already carries it (`ADD CONSTRAINT IF NOT EXISTS` does not exist).
ALTER TABLE scheduled_transaction_overrides
    DROP CONSTRAINT IF EXISTS uq_sched_txn_overrides_occurrence;
ALTER TABLE scheduled_transaction_overrides
    ADD CONSTRAINT uq_sched_txn_overrides_occurrence
    UNIQUE (scheduled_transaction_id, original_date);

-- 3. Retire the old constraint. Found by its COLUMNS rather than by name:
--    PostgreSQL generated the name and truncated it to 63 characters, so
--    spelling the truncation here is a guess that fails silently on a database
--    whose name differs by a byte -- leaving the wrong rule in force with a
--    migration reporting success.
DO $$
DECLARE
    conname_to_drop TEXT;
BEGIN
    SELECT c.conname INTO conname_to_drop
    FROM pg_constraint c
    WHERE c.conrelid = 'scheduled_transaction_overrides'::regclass
      AND c.contype = 'u'
      AND c.conkey = ARRAY[
            (SELECT a.attnum FROM pg_attribute a
             WHERE a.attrelid = c.conrelid AND a.attname = 'scheduled_transaction_id'),
            (SELECT a.attnum FROM pg_attribute a
             WHERE a.attrelid = c.conrelid AND a.attname = 'override_date')
          ]::smallint[]
    LIMIT 1;

    IF conname_to_drop IS NOT NULL THEN
        EXECUTE format(
            'ALTER TABLE scheduled_transaction_overrides DROP CONSTRAINT %I',
            conname_to_drop
        );
    END IF;
END
$$;

-- 4. The lookup index the new constraint's own index now provides. Two indexes
--    on the same columns cost every write twice and answer nothing extra.
DROP INDEX IF EXISTS idx_sched_txn_overrides_orig;
