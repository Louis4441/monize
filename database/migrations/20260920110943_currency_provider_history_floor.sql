-- Where a rate provider's history for a currency starts, once that has been
-- established.
--
-- Yahoo carries nothing for `USDCAD=X` before December 2003. A ledger that
-- opens in 1996 therefore plans seven years of rate-gap windows that can never
-- be filled, and `ExchangeRateHistoryService` learns this the expensive way:
-- one provider call per dead year, every time the knowledge is lost. It was
-- held only in process memory, for thirty minutes, so it was lost on every
-- restart and every deployment.
--
-- `provider_missing_through` is the latest date the provider has been found to
-- have no rate for, so the first date it could carry is the day after. The fill
-- opens its span there instead of at the reader's first transaction.
--
-- `provider_missing_against` is the other side of the pair the check was made
-- against, because this is a property of a pair rather than of a currency:
-- Yahoo's history for `USDCAD=X` and for `USDPLN=X` begins on different days.
-- The hint is honoured only when it matches the reader's own reporting
-- currency, so a deployment whose users report in different currencies cannot
-- have one reader's floor hide another reader's history.
ALTER TABLE currencies
    ADD COLUMN IF NOT EXISTS provider_missing_through DATE;

ALTER TABLE currencies
    ADD COLUMN IF NOT EXISTS provider_missing_against VARCHAR(3);
