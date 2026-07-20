-- Per-account foreign-transaction fee. When an account is configured with a
-- foreign-currency conversion fee, a foreign-entered transaction on that account
-- automatically books the bank's FX fee as an expense split under the chosen
-- category. Both fields are nullable; a fee percent is only meaningful when a
-- category is also set (enforced in the service layer). ON DELETE SET NULL so
-- removing the category just clears the account's fee setting.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS fx_fee_percent NUMERIC(8, 4);

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS fx_fee_category_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounts_fx_fee_category'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT fk_accounts_fx_fee_category
      FOREIGN KEY (fx_fee_category_id) REFERENCES categories(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accounts_fx_fee_category
  ON accounts(fx_fee_category_id);
