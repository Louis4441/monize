-- Market index history, for the Security Performance report's benchmark overlay.
--
-- An index is not a security. It has no owner, nobody holds units of it, and the
-- same S&P 500 close serves every user in the deployment -- so storing one as a
-- user-owned `securities` row would put a fake instrument in every holdings
-- list, price it once per user, and multiply the provider traffic by the number
-- of accounts. `exchange_rates` is the shape this follows instead: global
-- reference data with no owner column, written only by the scheduled refresh
-- under system context, and therefore RLS-exempt rather than policied. See the
-- exemption note at the foot of database/schema.sql.
--
-- index_code is the app's own stable key (SP500, FTSE100, ...), defined in
-- backend/src/securities/market-indexes.ts alongside the provider symbol. The
-- provider symbol is deliberately NOT the key: '^GSPC' is a Yahoo spelling, and
-- storing it would make a provider change a data migration.
--
-- adjusted_close is nullable for the same reason it is on security_prices: some
-- providers supply one and some do not, and the reader decides a basis per
-- series rather than per row (docs/time-series-contract.md rule 1).

CREATE TABLE IF NOT EXISTS market_index_prices (
    id              BIGSERIAL PRIMARY KEY,
    index_code      VARCHAR(32) NOT NULL,
    price_date      DATE NOT NULL,
    close_price     NUMERIC(24, 10) NOT NULL,
    adjusted_close  NUMERIC(24, 10),
    source          VARCHAR(50) NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (index_code, price_date)
);

CREATE INDEX IF NOT EXISTS idx_market_index_prices_code_date
    ON market_index_prices (index_code, price_date DESC);

COMMENT ON TABLE market_index_prices IS
  'Daily closes for the curated market indexes. Global reference data with no owner column, written by the scheduled refresh under system context.';

-- When each index was last fetched, successfully or not.
--
-- Without this, an index the provider cannot serve is re-requested on every
-- chart render: the price table stays empty, so "do we have history back to the
-- window start" is false every time and the on-demand backfill fires again.
-- securities.historical_backfill_attempted_at exists for the same reason.
CREATE TABLE IF NOT EXISTS market_index_sync (
    index_code       VARCHAR(32) PRIMARY KEY,
    last_attempt_at  TIMESTAMPTZ,
    last_success_at  TIMESTAMPTZ,
    last_error       TEXT
);

COMMENT ON TABLE market_index_sync IS
  'Per-index fetch bookkeeping, so a provider that cannot serve an index is not re-asked on every request.';
