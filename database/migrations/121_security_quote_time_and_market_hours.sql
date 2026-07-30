-- Record when a quote was actually struck, and the market session it belongs to.
--
-- price_date is a DATE, so the detail header could only ever say which day a
-- price came from. Intraday that reads as "the close of today", which is not
-- what the figure is. The providers already hand us the real quote instant
-- (Yahoo's meta.regularMarketTime, MSN's timeLastTraded) and we were throwing
-- the time away to derive the calendar date. quoted_at keeps it.
--
-- The market-hours columns come from the same Yahoo chart response
-- (exchangeTimezoneName and currentTradingPeriod.regular), which is per
-- instrument rather than guessed from the exchange code. They are the regular
-- session in the exchange's own local time, so "is this market open right now"
-- can be answered against the current clock rather than the last refresh.

ALTER TABLE security_prices
  ADD COLUMN IF NOT EXISTS quoted_at TIMESTAMPTZ;

COMMENT ON COLUMN security_prices.quoted_at IS
  'Instant the provider says this quote was struck. NULL for manual entries, rows derived from transactions, and every row written before this column existed.';

ALTER TABLE securities
  ADD COLUMN IF NOT EXISTS market_timezone VARCHAR(64),
  ADD COLUMN IF NOT EXISTS market_open_time TIME,
  ADD COLUMN IF NOT EXISTS market_close_time TIME;

COMMENT ON COLUMN securities.market_timezone IS
  'IANA zone the instrument trades in, from the provider (e.g. America/New_York). NULL until a refresh reports one.';
COMMENT ON COLUMN securities.market_open_time IS
  'Start of the regular session, in market_timezone local time.';
COMMENT ON COLUMN securities.market_close_time IS
  'End of the regular session, in market_timezone local time.';
