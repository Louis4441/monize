-- Fix: deleting a user/account fails with
--   new row for relation "transaction_splits" violates check constraint
--   "chk_split_kind_exclusive"
-- (and the equivalent on scheduled_transaction_splits).
--
-- transfer_account_id on the split tables referenced accounts(id) with
-- ON DELETE SET NULL. When an account is removed (e.g. cascading from a
-- user deletion) a transfer split pointing at it had its
-- transfer_account_id set to NULL while kind stayed 'transfer', which
-- violates the kind-exclusive CHECK (kind='transfer' requires
-- transfer_account_id IS NOT NULL) and aborts the delete.
--
-- A transfer split whose target account no longer exists is meaningless,
-- so it should be removed with the account: switch the FK to
-- ON DELETE CASCADE. Idempotent: safe to run multiple times.
--
-- (scheduled_transactions is intentionally untouched: it has no `kind`
-- column and its check does not constrain transfer_account_id.)

-- Remove any pre-existing invalid transfer splits (target already lost)
-- so the constraints stay satisfiable and data is consistent.
DELETE FROM transaction_splits
WHERE kind = 'transfer' AND transfer_account_id IS NULL;

DELETE FROM scheduled_transaction_splits
WHERE kind = 'transfer' AND transfer_account_id IS NULL;

ALTER TABLE transaction_splits
    DROP CONSTRAINT IF EXISTS transaction_splits_transfer_account_id_fkey;
ALTER TABLE transaction_splits
    ADD CONSTRAINT transaction_splits_transfer_account_id_fkey
    FOREIGN KEY (transfer_account_id) REFERENCES accounts(id) ON DELETE CASCADE;

ALTER TABLE scheduled_transaction_splits
    DROP CONSTRAINT IF EXISTS scheduled_transaction_splits_transfer_account_id_fkey;
ALTER TABLE scheduled_transaction_splits
    ADD CONSTRAINT scheduled_transaction_splits_transfer_account_id_fkey
    FOREIGN KEY (transfer_account_id) REFERENCES accounts(id) ON DELETE CASCADE;
