-- 144: separate an emergency-access delivery from the claim that coordinates it.
--
-- Migration 140 gave the two multi-replica emergency-access jobs a claim each,
-- which stopped two replicas doing the work twice. It did not make either one
-- *recoverable*, because in both cases the claim was taken before the send and
-- was the only record that the send was owed (audit FV4-004, FV4-005):
--
--   - The grant used `emergency_access_settings.granted_at` as both the claim and
--     the grant state. A replica killed between the conditional transition and
--     the emails left an account permanently marked granted with no contact
--     holding a link -- the safeguard silently disarmed, at exactly the moment it
--     is supposed to fire.
--   - The reminder used a permanent `job_claims` row keyed on the local date. A
--     replica killed between the claim and the send consumed the day and sent
--     nothing; only a handled SMTP error released it.
--
-- A claim answers "may I do this now". It cannot also answer "has this been
-- done", because the second question has to survive the process that asked the
-- first. So delivery gets its own durable column, per contact:
--
--   `claim_notified_at`      -- when this contact's link was actually sent.
--   `claim_token_ciphertext` -- the undelivered credential, so a retry re-sends
--                               the same link instead of minting a new one.
--
-- Per contact, not per owner, because the alternative is worse than the bug: a
-- retry that re-issues a token for a contact who already received one
-- invalidates the link in their inbox, and a dead emergency-access link during a
-- recovery is indistinguishable from a revoked one (the P4-014 failure). With
-- this column the retry sends only to contacts still owed a link.
--
-- The recovery is *derived* rather than scheduled: a grant with a contact whose
-- `claim_notified_at` is NULL is a grant that has not been delivered, and the
-- daily check re-runs the notification for exactly those contacts. Nothing has
-- to remember to enqueue anything, which is the point. `docs/cron-jobs.md` has
-- the operator-facing version of this contract and of migration 146's fence.
--
-- The credential is issued once and *reused* until delivery is acknowledged, which
-- is the other half of making a retry safe. SMTP acceptance and a database write
-- cannot commit together, so a process killed between them leaves a contact who
-- may well be holding a working link while the row still says the notice is owed.
-- Minting a fresh token on that retry overwrites the hash and kills the link
-- already in their inbox -- and if the retry's own send then fails, the contact is
-- left with a delivered link that does not work, during a recovery, indistinguishable
-- from one an owner revoked (audit RV4-004). So the raw token is kept, encrypted,
-- for exactly as long as the notice is owed:
--
--   * written with the hash, before the first send;
--   * re-read by a retry, which re-sends the *same* URL;
--   * cleared in the same statement that records delivery.
--
-- Encrypted with AES-256-GCM under `AI_ENCRYPTION_KEY`, like every other secret
-- this application stores. It is a credential at rest, so it does not outlive the
-- delivery it exists for.
--
-- Backfill: **nothing is inferred to have been delivered from the presence of a
-- token hash.** The previous implementation persisted the hash *before* calling
-- `sendMail`, so a hash means only that issuance was attempted -- a partial legacy
-- delivery would have marked the contact whose send failed as notified and the
-- recovery would never reach them, and an all-failed grant would have marked every
-- contact notified and left emergency access silently disarmed (audit RV4-003).
--
-- Two honest states, and only two:
--
--   * `claim_token_used_at IS NOT NULL` **with no `claim_voided_reason`** -- the
--     contact opened their link, which is proof of delivery. That, and only that,
--     backfills a timestamp. The reason for the second half of the predicate: in
--     the release this upgrades from, `claim_token_used_at` is *also* the void
--     tombstone -- `revokeAfterReturn`, the disable path and the manual reset all
--     stamp it alongside `claim_voided_reason`. Without excluding those, a link
--     that was cancelled before it was ever sent backfills as a delivery, which is
--     precisely the inference the paragraph above refuses.
--   * everything else -- unknown, therefore still owed. Left NULL, so the daily
--     check re-issues and re-sends. That re-issue *deliberately* replaces a legacy
--     credential nobody can confirm, because a link that is delivered beats one
--     that cannot be verified -- and the alternative, asserting delivery, disables
--     the safeguard permanently. Legacy rows have no stored ciphertext, so this is
--     the one case where the token does rotate; the service logs it.

ALTER TABLE emergency_access_contacts
    ADD COLUMN IF NOT EXISTS claim_notified_at TIMESTAMP;

ALTER TABLE emergency_access_contacts
    ADD COLUMN IF NOT EXISTS claim_token_ciphertext TEXT;

-- A used token proves the link arrived. Nothing else does -- and a voided one is
-- a cancellation stamped into the same column, not a delivery.
UPDATE emergency_access_contacts
   SET claim_notified_at = claim_token_used_at
 WHERE claim_notified_at IS NULL
   AND claim_token_used_at IS NOT NULL
   AND claim_voided_reason IS NULL;

-- No index for `claim_notified_at IS NULL` here on purpose: migration 145 moves
-- "is a link still owed" onto the generation two statements later, in the same
-- release, so building one for a predicate nothing will read is churn an install
-- with real data pays for nothing.
