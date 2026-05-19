-- Fix: deleting a user fails with
--   update or delete on table "categories" violates foreign key constraint
--   "transaction_splits_category_id_fkey" on table "transaction_splits"
--
-- The category_id foreign keys on transactions, transaction_splits,
-- scheduled_transactions and scheduled_transaction_splits were created
-- with the implicit ON DELETE NO ACTION. Every other category reference
-- in the schema (accounts principal/interest/asset categories, budget
-- categories, etc.) uses ON DELETE SET NULL. When a user is deleted,
-- Postgres cascade-deletes that user's categories; any split/transaction
-- still referencing one of those categories then blocks the delete
-- instead of having its category_id nulled out.
--
-- Single-category deletion is unaffected: CategoriesService.remove()
-- already refuses to delete a category that has referencing transactions
-- ("Reassign transactions first"), so SET NULL only ever applies on the
-- user-deletion cascade path.
--
-- Nulling category_id keeps the kind-exclusive CHECK constraints
-- satisfied: a 'category' kind split only requires transfer_account_id
-- (and investment_action) to be NULL, not category_id.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE transactions
    DROP CONSTRAINT IF EXISTS transactions_category_id_fkey;
ALTER TABLE transactions
    ADD CONSTRAINT transactions_category_id_fkey
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL;

ALTER TABLE transaction_splits
    DROP CONSTRAINT IF EXISTS transaction_splits_category_id_fkey;
ALTER TABLE transaction_splits
    ADD CONSTRAINT transaction_splits_category_id_fkey
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL;

ALTER TABLE scheduled_transactions
    DROP CONSTRAINT IF EXISTS scheduled_transactions_category_id_fkey;
ALTER TABLE scheduled_transactions
    ADD CONSTRAINT scheduled_transactions_category_id_fkey
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL;

ALTER TABLE scheduled_transaction_splits
    DROP CONSTRAINT IF EXISTS scheduled_transaction_splits_category_id_fkey;
ALTER TABLE scheduled_transaction_splits
    ADD CONSTRAINT scheduled_transaction_splits_category_id_fkey
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL;
