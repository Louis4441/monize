-- Foreign-currency entry for scheduled transactions.
--
-- A recurring charge is often billed in a currency the account is not
-- denominated in: a USD subscription on a CAD credit card is the same USD
-- amount every month, while the CAD the bank actually takes moves with the
-- rate. Storing only the converted amount froze it at whatever the rate was on
-- the day the schedule was created, so both the forecast and the posted
-- transaction drifted.
--
-- These three columns mirror the ones transactions already carry
-- (original_amount / original_currency_code / exchange_rate, migration 084):
--   original_amount         the fixed amount the biller charges, in its currency
--   original_currency_code  that currency
--   exchange_rate           account-currency units per 1 unit of it, for the
--                           estimate currently held in `amount`
--
-- `amount` stays the account-currency figure every existing consumer (the bills
-- list, the cash-flow forecast, budgets) already reads; for a foreign-currency
-- schedule it is a converted estimate, refreshed daily from the latest stored
-- rate by ScheduledTransactionsService.refreshForeignCurrencyEstimates. The
-- rate that ends up on the posted transaction is looked up for the posting date
-- instead, so a back-dated or future posting uses that day's rate.

ALTER TABLE scheduled_transactions
    ADD COLUMN IF NOT EXISTS original_amount NUMERIC(20, 4);

ALTER TABLE scheduled_transactions
    ADD COLUMN IF NOT EXISTS original_currency_code VARCHAR(3) REFERENCES currencies(code);

ALTER TABLE scheduled_transactions
    ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(20, 10) NOT NULL DEFAULT 1;
