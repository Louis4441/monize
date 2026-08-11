-- 148: enforce the attachment late-write quarantine in the database, so that
-- deleting a tombstone early takes a deliberate act rather than an omission.
--
-- Migration 147 added `late_write_quarantine_until` and the sweeper retains a swept
-- upload intent until it passes, re-deleting the key each hour (audit V4R3-003).
-- That is a rule spread across three statements in two files -- the claim that
-- stamps the window, the retire that respects it, and the uploader's compensating
-- clear -- and each of them is one forgotten predicate away from dropping a row
-- while bytes may still be written at its key.
--
-- Not hypothetical: `AttachmentsService.clearCommittedUploadIntent` was written
-- without the predicate and deleted the row unconditionally in the `catch` of
-- `create`, which is the one place a stalled put is most likely to be outstanding.
-- It is fenced now. The trigger is what makes the next one fail loudly instead of
-- silently reintroducing RRV4-002.
--
-- Two triggers:
--
--   * BEFORE UPDATE: when a claim turns a row that *was* an upload intent (it had
--     a lease) into a swept row, stamp `late_write_quarantine_until` if it is not
--     already set. `COALESCE` means the application's own value wins and a re-claim
--     never pushes the deadline forward. A writer that does not know the column
--     exists -- an older binary during a rollback, a psql session -- still stamps it.
--
--   * BEFORE DELETE: reject deletion of a row whose quarantine has not passed, so
--     the tombstone survives and the next sweep re-deletes the key before retiring
--     the row. Every application path is written to exclude such rows already --
--     `retire()`/`retireKey()` by the quarantine, both uploader clears by
--     `swept_at IS NULL` -- so nothing in this release should ever trip it.
--
-- What this does NOT cover: `TRUNCATE` fires no row-level BEFORE DELETE trigger.
-- The test helpers truncate `users` CASCADE, which reaches this table. Enforcement
-- is over `DELETE`, which is every path production has.
--
-- The wall-clock window remains a latency choice, not the correctness mechanism:
-- correctness is that the record outlives the writer and the key is re-deleted every
-- pass. See `LATE_WRITE_QUARANTINE_MS` -- pinned to the interval below by
-- `attachment-orphan-sweeper.service.spec.ts` -- and the S3 provider's
-- `S3_REQUEST_TIMEOUT_MS`, set well below the window so a put cannot ordinarily
-- complete after it. `LocalStorageProvider` has no equivalent bound and needs none:
-- a local write does not stall for hours.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, triggers dropped first.

-- Six hours, matching AttachmentOrphanSweeper.LATE_WRITE_QUARANTINE_MS. The app
-- also sets this column on its own claim; the trigger is the mixed-version backstop
-- and the single writer that covers the previous binary.
CREATE OR REPLACE FUNCTION stamp_attachment_quarantine()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
BEGIN
    NEW.late_write_quarantine_until := COALESCE(
        NEW.late_write_quarantine_until,
        OLD.late_write_quarantine_until,
        CURRENT_TIMESTAMP + INTERVAL '6 hours'
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_abt_stamp_quarantine ON attachment_blob_tombstones;
CREATE TRIGGER trg_abt_stamp_quarantine
    BEFORE UPDATE ON attachment_blob_tombstones
    FOR EACH ROW
    WHEN (
      NEW.swept_at IS NOT NULL
      AND OLD.swept_at IS NULL
      AND OLD.upload_lease_expires_at IS NOT NULL
    )
    EXECUTE FUNCTION stamp_attachment_quarantine();

CREATE OR REPLACE FUNCTION reject_quarantined_tombstone_delete()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
      'attachment tombstone % is under late-write quarantine until %; a stalled upload may still write to this key',
      OLD.storage_key, OLD.late_write_quarantine_until
      USING ERRCODE = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS trg_abt_reject_quarantined_delete ON attachment_blob_tombstones;
CREATE TRIGGER trg_abt_reject_quarantined_delete
    BEFORE DELETE ON attachment_blob_tombstones
    FOR EACH ROW
    WHEN (
      OLD.late_write_quarantine_until IS NOT NULL
      AND OLD.late_write_quarantine_until > CURRENT_TIMESTAMP
    )
    EXECUTE FUNCTION reject_quarantined_tombstone_delete();
