-- Why "Today's portfolio -- simulated" has no line.
--
-- The simulation replays the instruments the strategy accounts hold now over
-- the selected window, so it needs a *history* for each of them -- not a
-- refreshed quote, which stores one row for today. The strategy's own assets
-- are backfilled when the configuration is saved; a fund the user merely holds
-- was not, until the report learned to fetch it too.
--
-- Run it read-only against the app database, e.g.
--   docker exec -i monize-postgres psql -U monize_user -d monize -f - < scripts/gem-price-coverage.sql
-- or
--   psql "$DATABASE_URL" -f scripts/gem-price-coverage.sql
--
-- Every strategy of every user is listed; on a single-user install that is
-- simply your own. Nothing is written.

\pset pager off

\echo '== 1. Instruments held in the GEM strategy accounts, and their price coverage =='
-- One row per held instrument. `rows_12m` is what the 1Y chart can draw from;
-- two points is the minimum that describes a change, and a `last_price` more
-- than ~10 days old cannot stand for today (the carry-forward limit).
SELECT
    g.name                                   AS strategy,
    s.symbol,
    s.name                                   AS instrument,
    h.quantity,
    a.name                                   AS account,
    COUNT(p.id)                              AS rows_total,
    COUNT(p.id) FILTER (
        WHERE p.price_date >= CURRENT_DATE - INTERVAL '12 months'
    )                                        AS rows_12m,
    MIN(p.price_date)                        AS first_price,
    MAX(p.price_date)                        AS last_price,
    CURRENT_DATE - MAX(p.price_date)         AS days_stale,
    s.historical_backfill_attempted_at       AS last_backfill_attempt
FROM gem_strategies g
JOIN gem_strategy_accounts ga ON ga.strategy_id = g.id
JOIN accounts a               ON a.id = ga.account_id
JOIN holdings h               ON h.account_id = a.id AND h.quantity <> 0
JOIN securities s             ON s.id = h.security_id
LEFT JOIN security_prices p   ON p.security_id = s.id
GROUP BY g.name, s.symbol, s.name, h.quantity, a.name,
         s.historical_backfill_attempted_at
ORDER BY g.name, rows_12m ASC, s.symbol;

\echo ''
\echo '== 2. The same for the instruments the strategy assigns to a role =='
-- For contrast: these are backfilled on a configuration save, so they normally
-- have a full series. A held instrument sitting far below them is the answer.
SELECT
    g.name          AS strategy,
    ga2.role,
    s.symbol,
    COUNT(p.id) FILTER (
        WHERE p.price_date >= CURRENT_DATE - INTERVAL '12 months'
    )               AS rows_12m,
    MAX(p.price_date) AS last_price
FROM gem_strategies g
JOIN gem_strategy_assets ga2 ON ga2.strategy_id = g.id
JOIN securities s            ON s.id = ga2.security_id
LEFT JOIN security_prices p  ON p.security_id = s.id
GROUP BY g.name, ga2.role, s.symbol
ORDER BY g.name, ga2.role;

\echo ''
\echo '== 3. Where the stored prices came from =='
-- `source` tells a refreshed quote (yahoo_finance / msn_finance, one row per
-- run) apart from a transaction-derived price (buy, sell, ...) and a manual
-- one. A held instrument whose only rows are transaction-derived has no
-- history to replay, however often the quote is refreshed.
SELECT
    s.symbol,
    COALESCE(p.source, '(none)') AS source,
    COUNT(*)                     AS rows,
    MIN(p.price_date)            AS first_price,
    MAX(p.price_date)            AS last_price
FROM securities s
JOIN holdings h             ON h.security_id = s.id AND h.quantity <> 0
JOIN gem_strategy_accounts ga ON ga.account_id = h.account_id
LEFT JOIN security_prices p ON p.security_id = s.id
GROUP BY s.symbol, p.source
ORDER BY s.symbol, rows DESC;
