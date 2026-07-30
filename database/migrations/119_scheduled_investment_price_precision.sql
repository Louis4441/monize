-- Extends migration 116 to the scheduled-transaction copies of a per-unit price.
--
-- 116 widened investment_transactions.price to NUMERIC(24,10) because six
-- decimal places cannot hold a sub-cent instrument. The scheduled tables carry
-- their own investment_price, and that value is copied straight onto the posted
-- investment transaction -- so a recurring monthly buy of a crypto or penny
-- holding was still storing a truncated price every month, reintroducing on a
-- schedule exactly the cost-basis error 116 exists to remove.
--
-- Same widening and the same reasoning: precision 20 -> 24 so the integer part
-- keeps its present headroom and the migration cannot reject existing data.

ALTER TABLE scheduled_transactions
  ALTER COLUMN investment_price TYPE NUMERIC(24, 10);

ALTER TABLE scheduled_transaction_splits
  ALTER COLUMN investment_price TYPE NUMERIC(24, 10);

ALTER TABLE scheduled_transaction_overrides
  ALTER COLUMN investment_price TYPE NUMERIC(24, 10);
