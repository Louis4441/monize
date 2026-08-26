-- Mortgage accounts created with a SEMI_MONTHLY payment frequency wrote
-- "SEMI_MONTHLY" into scheduled_transactions.frequency, but the recurrence
-- engine's enum spells it "SEMIMONTHLY" (no underscore) and its switch has a
-- pass-through default: calculateNextDueDate returned the same date, so the
-- occurrence stayed due forever and the payment schedule never advanced.
-- LoanPaymentSetupService mapped it correctly; only the mortgage path did not.
--
-- The column is a bare VARCHAR(20) with no CHECK, so the wrong value persisted
-- silently. Heal the rows already written; the code fix stops new ones.
UPDATE scheduled_transactions
SET frequency = 'SEMIMONTHLY'
WHERE frequency = 'SEMI_MONTHLY';
