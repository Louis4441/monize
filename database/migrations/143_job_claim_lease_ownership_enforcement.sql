-- 143: enforce lease ownership in the database, so a previous-release pod cannot
-- release or mark a lease that a new pod has retaken during a rolling deployment.
--
-- Migration 142 added `job_claims.lease_token`; the new `release()` and
-- `markDelivered()` filter on it, so a stalled new-code attempt whose lease was
-- retaken matches zero rows and writes nothing. That protects new code from new
-- code. It does not protect a new-code lease from the *previous* binary, whose
-- statements name the work and not the holder (audit V4R3-004):
--
--     DELETE FROM job_claims WHERE claim_type=$1 AND user_id=$2 AND claim_key=$3
--     UPDATE job_claims SET delivered_at=now(), expires_at=NULL WHERE <same key>
--
-- During a rollout: old pod A claims work and stalls past its lease; new pod B
-- retakes it and writes token B; A resumes and its old `release()` deletes B's live
-- row by work key, leaving the replica actually sending with no exclusion, or its
-- old `markDelivered()` stamps a delivery for a send B has not finished. The nullable
-- column cannot stop those statements, any more than a nullable checkpoint column can
-- stop a previous binary that does not know to write it. The rule lives where both
-- binaries meet: a session that mutates a *live tokenized* lease must own it.
--
-- Ownership is proven by a transaction-local GUC, `app.job_claim_lease_token`, that
-- the new tokenized `release()` / `markDelivered()` set to their lease token before
-- the write. A BEFORE DELETE / BEFORE UPDATE trigger, firing only on a live lease
-- that carries a token, rejects the statement unless the session's GUC matches the
-- row's token. The previous binary never sets the GUC, so it can never mutate a
-- tokenized live lease held by new code.
--
-- What the WHEN clause deliberately excludes, so nothing legitimate is blocked:
--
--   * `claimLease` retaking an expired lease -- the row is expired, WHEN is false.
--   * a permanent `claimOnce` row -- `lease_token` is NULL, WHEN is false.
--   * the retention sweep -- it deletes rows older than 30 days, which are expired
--     or permanent, so `expires_at > now()` is false.
--   * a delivered row -- `markDelivered` sets `expires_at = NULL`, so WHEN is false.
--
-- The only writes reaching a live tokenized lease are the tokenized release/mark
-- themselves, which set the GUC, and the previous binary's untokenized ones, which
-- do not. Idempotent: CREATE OR REPLACE FUNCTION, triggers dropped first.
--
-- One thing the WHEN clause cannot express, so the function does: `job_claims.user_id`
-- is `REFERENCES users(id) ON DELETE CASCADE`, and a cascade names no lease token
-- because it is not an attempt to mutate a lease -- it is the owner going away. Left
-- unexempted, deleting an account raised for as long as that user held any live
-- tokenized lease, which is minutes to an hour on ordinary paths (AI insights 15 min,
-- maintenance 60, demo reset 30) and is a state a user can be in whenever they press
-- "delete my account".
--
-- `pg_trigger_depth()` is what separates the two. A direct `DELETE FROM job_claims`
-- fires this trigger at depth 1; a `DELETE FROM users` runs the FK's cascade as an
-- internal trigger on `users`, so the delete it issues against `job_claims` fires this
-- one at depth 2. Checked in the body rather than the WHEN clause, because the depth a
-- WHEN clause observes is not part of the documented contract and the body's is.

CREATE OR REPLACE FUNCTION guard_job_claim_lease_ownership()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
BEGIN
    -- Reached from another trigger: the only such path is the ON DELETE CASCADE
    -- from `users`. Nothing to own once the owner is gone.
    IF pg_trigger_depth() > 1 THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    IF COALESCE(current_setting('app.job_claim_lease_token', true), '')
       IS DISTINCT FROM OLD.lease_token::text THEN
        RAISE EXCEPTION
          'job_claims lease % (%/%/%) is held by another attempt; this session does not own it',
          OLD.lease_token, OLD.claim_type, OLD.user_id, OLD.claim_key
          USING ERRCODE = 'raise_exception';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_claims_guard_delete ON job_claims;
CREATE TRIGGER trg_job_claims_guard_delete
    BEFORE DELETE ON job_claims
    FOR EACH ROW
    WHEN (
      OLD.lease_token IS NOT NULL
      AND OLD.expires_at IS NOT NULL
      AND OLD.expires_at > CURRENT_TIMESTAMP
    )
    EXECUTE FUNCTION guard_job_claim_lease_ownership();

DROP TRIGGER IF EXISTS trg_job_claims_guard_update ON job_claims;
CREATE TRIGGER trg_job_claims_guard_update
    BEFORE UPDATE ON job_claims
    FOR EACH ROW
    WHEN (
      OLD.lease_token IS NOT NULL
      AND OLD.expires_at IS NOT NULL
      AND OLD.expires_at > CURRENT_TIMESTAMP
    )
    EXECUTE FUNCTION guard_job_claim_lease_ownership();
