# Scheduled-investment FX rate: currency-pair provenance (issue #1167)

Status: implemented. Supersedes the deferral note in
`docs/future-plans/scheduled-investment-fx-currency-pair.md` (the #1154 follow-up).

## The defect

A scheduled investment can persist an FX rate that converts the security's
currency into the settlement account's currency. That rate is a single scalar
(`NUMERIC(20, 10)`) with **no record of the currency pair it was resolved for**.
If the referenced security's `currencyCode` or the settlement account's
`currencyCode` changes *after* the rate was stored -- with the id unchanged --
the stored scalar silently becomes a rate for a pair that no longer applies. A
later posting then converts the cash at a rate that answers a question nobody is
asking anymore, so the posted cash and the account balance are wrong (about the
size of the FX move -- ~11% in the reported EUR->USD example).

This is a financial-correctness defect, not merely a consistency one, but nothing
corrupts at the moment the currency is edited: it materializes only on a later
scheduled posting. It is the residual edge left by issue #1154, which re-resolves
the rate when the *schedule's own* settlement structure changes (account,
security id, funding account) but cannot see a currency change made on the
referenced security or account row.

## The three persistent rate surfaces (all covered)

1. `scheduled_transactions.investment_exchange_rate` -- the parent schedule's rate.
2. `scheduled_transaction_splits.investment_exchange_rate` -- an embedded
   investment split's per-split rate.
3. Occurrence override -- the `exchangeRate` inside an override's
   `splits[*].investment` jsonb payload.

## The fix: persist the pair, self-verify at posting (the "durable" option)

Store the rate's from/to currency codes beside each rate, so the posting path
self-verifies. This makes the rate self-describing and removes the need for any
external write path (a security edit, an account edit) to remember to invalidate
it.

- **Provenance** = `{ from, to }` = `(source currency, settlement currency)` where
  `source currency` is the security's `currencyCode` (or, for a security-less
  action, the investment account's `currencyCode`) and `settlement currency` is
  the funding account's `currencyCode` for a BUY/SELL that names one, otherwise
  the brokerage's linked cash account's `currencyCode`.
- The pair is derived in **exactly one place**:
  `InvestmentTransactionsService.resolveSettlementCurrencyPair`, which
  `resolveCashExchangeRate` (the posting-time resolver) also uses -- so the pair
  a rate is validated against is byte-identical to the pair it would be resolved
  for.

### Storage

- Two nullable columns on `scheduled_transactions` and
  `scheduled_transaction_splits`: `investment_exchange_rate_from_currency`,
  `investment_exchange_rate_to_currency` (`VARCHAR(3)`).
- Two optional keys inside the override jsonb `investment` object:
  `exchangeRateFromCurrency`, `exchangeRateToCurrency`.
- Provenance is **derived server-side** whenever a rate is stored, never accepted
  from the request DTO. When the rate is cleared (settlement-basis change per
  #1154, a mode switch, an explicit null), the provenance is cleared with it --
  the pair travels with the rate as one tuple, never separately.

### Validation at posting

For each surface, before forwarding a stored rate into the posting resolver:

- If the stored rate has provenance and the provenance **matches** the current
  pair -> forward the stored rate (the fast path, a legitimate cross-currency
  rate reused).
- If the stored rate has provenance and it **does not match** -> treat the rate
  as absent and forward nothing, so `resolveCashExchangeRate` re-resolves a fresh
  rate for the current pair.
- If the stored rate has **no provenance** (a row written before this change) ->
  forward it unchanged. This is deliberate backward compatibility: a pre-existing
  stored rate keeps working exactly as it did (a stored scalar was the only
  fallback guaranteeing that posting could succeed when a market rate is
  unavailable, and silently dropping it could turn a working schedule into a
  posting failure). Every rate the system writes *after* this change carries
  provenance and is therefore protected; the unprotected window is only rows that
  predate the migration, and no UI or `.mny`-import path ever stored a rate, so
  in practice there are none. No backfill is attempted, because backfilling the
  pair in SQL would be a second, drift-prone copy of the pair derivation the
  contract insists lives in one place.

## Invariants

- **A stored rate that carries provenance is reused only for its own pair.** A
  provenance mismatch forces re-resolution; the stale scalar is never applied.
- **The pair travels with the rate.** Clearing the rate clears the provenance;
  storing a rate stores the provenance for the settlement tuple being written.
- **One pair derivation.** `resolveSettlementCurrencyPair` is the sole definition
  of `(source, settlement)`; `resolveCashExchangeRate` consumes it, and a guard
  test (`investment-transactions.service.spec.ts`) keeps the resolver delegating
  to it.

## Test matrix (regression obligations)

For each of the three surfaces:

1. **Stale pair re-resolves.** Store a rate with provenance for pair A; change the
   security (or settlement account) currency so the current pair is B; post; assert
   the posting resolver was called to produce a fresh rate for pair B, and the
   stale scalar was not forwarded.
2. **Matching pair reuses.** Store a rate with provenance for pair A; post with the
   pair still A; assert the stored rate is forwarded (no re-resolution).
3. **Legacy row (no provenance) is trusted.** A stored rate with null provenance is
   forwarded unchanged.
4. **Store-time provenance.** Creating/updating with a supplied rate records the
   from/to pair; clearing the rate (settlement-basis change, mode switch) clears
   the provenance.

Adversarial inputs drawn from `docs/testing-contract.md`: same-currency pair (rate
1, provenance recorded as `{X, X}` and always matches), a security-less amount-only
action (source = account currency), and a funding-account BUY vs a linked-cash BUY
(two different settlement currencies for the same brokerage).
