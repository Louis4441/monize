-- Widens every per-unit price column from NUMERIC(20,6) to NUMERIC(24,10).
--
-- Six decimal places cannot represent a sub-cent instrument. A crypto or penny
-- holding bought at 0.00012345678 per unit was stored as 0.000123, and because
-- cost basis is quantity x price the error is a percentage of the position, not
-- a rounding artefact: at 0.0000085 the stored value is 0.000009, over 5% out.
-- Holdings.average_cost inherits this from the transaction price it is replayed
-- from, so widening the cache alone would have fixed nothing.
--
-- Money totals (total_amount, commission) stay at scale 4: those are amounts in
-- a currency, where four places is already more than any currency subdivides.
-- Only prices *per unit* need the extra room.
--
-- Precision goes 20 -> 24 rather than staying at 20 so the integer part keeps
-- its current 14 digits of headroom. Narrowing it to 10 would have made this
-- migration fail on any row holding a price above 10^10, and a widening
-- migration must not be able to reject existing data.
--
-- Note for operators: these are type changes, so PostgreSQL rewrites each table
-- under an ACCESS EXCLUSIVE lock. security_prices is the large one -- expect the
-- migration to take time proportional to its row count.

ALTER TABLE investment_transactions
  ALTER COLUMN price TYPE NUMERIC(24, 10);

ALTER TABLE holdings
  ALTER COLUMN average_cost TYPE NUMERIC(24, 10);

ALTER TABLE security_prices
  ALTER COLUMN open_price TYPE NUMERIC(24, 10),
  ALTER COLUMN high_price TYPE NUMERIC(24, 10),
  ALTER COLUMN low_price TYPE NUMERIC(24, 10),
  ALTER COLUMN close_price TYPE NUMERIC(24, 10),
  ALTER COLUMN adjusted_close TYPE NUMERIC(24, 10);

-- Existing rows keep the value they were truncated to when they were written:
-- the lost digits are not recoverable from the database. Re-importing prices
-- from the provider restores them for security_prices, and rebuilding holdings
-- (Tools -> Securities -> rebuild) recomputes average_cost from the transaction
-- prices, which are only as good as what was entered.
