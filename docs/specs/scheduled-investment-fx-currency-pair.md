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
  it is *unknown*, not *current*, so it is also treated as absent and
  re-resolved. A scalar that cannot be proven to describe the current pair must
  never be applied to it -- consistent with the codebase rule that `null`/unknown
  is never silently substituted for a settled value. If no current rate can be
  resolved, the posting fails loudly (the resolver throws `exchangeRateUnavailable`)
  rather than committing a rate for an unknown pair. Every rate the app writes
  *after* this change carries its pair, so the only unprovenanced rows are ones
  that predate the migration; no backfill is attempted, because deriving the pair
  in SQL would be a second, drift-prone copy of the derivation this contract keeps
  in one place.

## The forecast consumes a resolved rate, never the stored scalar

The cash-flow forecast must agree with what a later posting will do, so it must
not project with the persisted `investmentExchangeRate` (which may be stale for
the current pair) nor default a missing rate to `1`. The stored scalar and a
rate safe to project with *now* are two different things.

- The FX resolution used by posting is factored into
  `InvestmentTransactionsService.resolveCashExchangeRateOrNull`, which returns
  `number | null`: same pair derivation and rate path as posting, but a genuine
  cross-currency pair with no determinable rate returns `null` instead of
  throwing. `resolveCashExchangeRate` (the posting entry) wraps it and turns
  `null` into the `exchangeRateUnavailable` `BadRequestException` -- so posting
  still refuses loudly, and the forecast reads `null` directly.
- The scheduled read model (`findAll`) attaches a read-only
  `investmentForecastExchangeRate: number | null` per investment schedule,
  resolved through that path with **no supplied rate** and the schedule's own
  settlement tuple. `1` for same-currency, a resolved rate for a cross-currency
  pair, `null` when the current rate is unknown. It never reads or overwrites the
  persisted `investmentExchangeRate`.
- `frontend/src/lib/forecast.ts` uses only `investmentForecastExchangeRate`. A
  resolved number converts the projected cash impact; `null` (a genuine
  cross-currency occurrence with no current rate) makes the projection unknown
  and withholds the whole cumulative series through the existing
  `missingCurrencies` mechanism -- the same treatment as a missing
  display-currency rate. Same-currency is `1`, so it is never mistaken for
  missing.

The round trip the tests pin: stored `EUR->CAD = 1.50`, the security's currency
changed to USD, the current `USD->CAD = 1.35`, a `10 x 100` occurrence -> the
forecast projects `1,350` and posting commits `1,350`, never `1,500`; and when
`USD->CAD` is unavailable, the forecast shows the projection as unavailable while
posting refuses -- neither surface uses the stale `1.50` or a `1` fallback.

### Embedded investment splits settle end-to-end at the effective rate

An embedded split-investment schedule (an ordinary split parent carrying an
investment split line) has no single settlement rate -- each investment line
settles its own security's currency -- so the read model exposes an effective
*total* rather than a rate, and posting recomputes each split's cash amount:

- **Posting** (`postOccurrence`, all three surfaces -- inline, override, base
  scheduled splits) resolves each investment split's cash amount through
  `resolveEffectiveSplitCash`: the stored rate when its recorded pair still
  matches, otherwise a freshly resolved one, and the split's cash `amount` is
  `investmentSplitCashAmount(action, qty, price, commission, effectiveRate)` --
  the single definition of that figure, shared with
  `createEmbeddedForSplit`'s consistency check. The parent amount is then
  re-summed from the recomputed split amounts (`validateSplitAmountSum` would
  otherwise refuse the post). An unresolvable cross-currency pair throws
  `exchangeRateUnavailable`, so posting refuses rather than committing a stale
  amount or throwing `embeddedSplitAmountMismatch`.
- **The read model** (`findAll`) attaches a read-only
  `investmentForecastAmount: number | null` for split-investment schedules: the
  base splits re-summed with each investment line's current effective rate
  (`resolveInvestmentForecastSplitAmount`), or `null` when any line's current
  rate is unknown. Non-split and non-investment-split schedules get `null` and
  are unaffected.
- **The forecast** (`frontend/src/lib/forecast.ts`) projects
  `investmentForecastAmount` for a split-investment schedule instead of the stale
  stored `amount`; a `null` withholds the whole cumulative series through
  `missingCurrencies`, the same treatment as an unknown parent-investment rate.

Because posting emits `investmentSplitCashAmount(..., effectiveRate)` and
`createEmbeddedForSplit` recomputes `expected` from the same function against the
same forwarded rate, the two halves of the split cannot disagree by construction;
`test/integration/scheduled-investment-split-fx.integration.spec.ts` proves it
across `create -> createSplits -> createEmbeddedForSplit` and proves a stale
amount is refused there rather than written.

## Invariants

- **A stored rate that carries provenance is reused only for its own pair.** A
  provenance mismatch forces re-resolution; the stale scalar is never applied.
- **The pair travels with the rate.** Clearing the rate clears the provenance;
  storing a rate stores the provenance for the settlement tuple being written.
- **One pair derivation.** `resolveSettlementCurrencyPair` is the sole definition
  of `(source, settlement)`; `resolveCashExchangeRate` consumes it, and a guard
  test (`investment-transactions.service.spec.ts`) keeps the resolver delegating
  to it.
- **Every posting surface re-resolves, including inline (F5-1).** The manual Post
  dialog resends the scheduled/override splits as inline `postDto.splits`, echoing
  the persisted rate and its provenance. An inline investment split is routed
  through the same effective-rate path as the stored surfaces -- reused only when
  its echoed pair still matches, otherwise re-resolved; an inline split with no
  provenance is re-resolved, never trusted. The frontend carries the provenance
  through `toSplitRows`/`toOverrideSplits` so the round-trip is checkable.
- **Provenance carry-forward is keyed by security AND rate (F5-3).** One schedule
  can hold two investment splits for the same security at different rates; keyed by
  security alone the second overwrites the first, so a resent-unchanged rate that
  lost the collision is mis-stamped with the current pair. `provenanceKey(securityId,
  rate)` keys both the store and the lookup, so each tuple keeps its own pair.
- **A split's FX provenance is decided by stable identity, not by value (F4).** The
  value key still collides when a rate is *changed* to exactly another split's old
  value. Every split carries a stable id (scheduled splits from the DB, override
  splits server-generated), the client echoes it as `sourceSplitId` on edit/post,
  and the server correlates the incoming split to its source row by id: an unchanged
  rate carries the source's pair, a changed one stamps the current pair. The value
  key remains only as the fallback for a client that echoes no id.
- **A user-edited inline rate is honoured, an echoed one is not trusted (F2).** At
  the manual Post dialog, a rate whose value differs from its source split's is a
  fresh rate for the current pair -- reused, not re-resolved -- while an unchanged
  echoed rate goes through the stale-check. The two are told apart by `sourceSplitId`
  identity, so dropping the echoed provenance in the rate editor no longer loses the
  user's figure. The rate editor also preserves the recorded pair across field edits
  as defence in depth.
- **Overrides forecast their own effective total (F5-2).** A per-occurrence override
  carrying investment splits is FX-sensitive too; its stored `amount` is a stale
  snapshot. The read model attaches `investmentForecastAmount` to each override, and
  the forecast projects that (or withholds the occurrence when unknown) rather than
  the override's scalar -- covering both an override that replaces an investment base
  occurrence and one that introduces investment splits over a plain base.

## Test matrix (regression obligations)

For each of the three surfaces:

1. **Stale pair re-resolves.** Store a rate with provenance for pair A; change the
   security (or settlement account) currency so the current pair is B; post; assert
   the posting resolver was called to produce a fresh rate for pair B, and the
   stale scalar was not forwarded.
2. **Matching pair reuses.** Store a rate with provenance for pair A; post with the
   pair still A; assert the stored rate is forwarded (no re-resolution).
3. **Legacy row (no provenance) is re-resolved.** A stored rate with null
   provenance is unknown, not current, so it is dropped and re-resolved at
   posting (never forwarded unchanged).
4. **Store-time provenance.** Creating with a supplied rate records the from/to
   pair; clearing the rate (settlement-basis change, mode switch) clears the
   provenance. A presentation-only edit that leaves the rate and its settlement
   pair unchanged preserves the existing provenance (parent: value-difference;
   split/override: the old pair is carried forward per security), so a still-valid
   stored rate keeps working while a since-changed pair is still caught at posting.

5. **Embedded split re-resolves end-to-end.** For an embedded split-investment
   schedule with a stale-provenance rate, post; assert the split's forwarded rate
   and cash amount are the re-resolved (effective) ones, the parent amount is the
   re-summed total, and an unresolvable pair refuses the post before any write.
   The forecast half: assert the read model's `investmentForecastAmount` is the
   effective total (not the stale stored `amount`), and `null` for an unresolvable
   line, and that `forecast.ts` projects the effective total / withholds on `null`.

6. **Inline post re-resolves (F5-1).** Post an inline split echoing a stale rate +
   its provenance; assert it re-resolves and the parent is re-summed. Post an inline
   split whose provenance still matches; assert the rate is honoured with no
   re-resolution. Post an inline split with a bare scalar (no provenance); assert it
   is re-resolved, never trusted. A frontend test asserts `toSplitRows` ->
   `toOverrideSplits` carries the provenance so the round-trip is possible at all.

7. **Multiple same-security splits keep distinct provenance (F5-3).** Two splits for
   one security at different stored rates; change the security currency; cosmetic
   edit resending both rates unchanged; assert neither is re-stamped with the current
   pair (both keep their original pair, so posting still catches both as stale).

8. **Override forecast parity (F5-2).** An investment override replacing an investment
   base occurrence, and an override introducing an investment split over a plain base:
   assert the forecast projects the override's `investmentForecastAmount` (not its
   stale scalar, not the base), and withholds the series when the override's rate is
   unknown.

9. **Stable identity, changed-to-collide rate (F4).** Two same-security splits; change
   one's rate to exactly the other's old value; assert -- correlating by `sourceSplitId`
   -- the unchanged one keeps its pair and the changed one stamps the current pair.

10. **User-edited inline rate honoured (F2).** Post an inline split whose rate differs
    from its source split's, with the echoed provenance dropped; assert the edited rate
    is honoured for the current pair (not re-resolved to the market), recognised by
    `sourceSplitId`. A frontend test asserts the source id round-trips through
    `toSplitRows` -> `toOverrideSplits`.

11. **Parent forecast reuses a valid pinned rate (F1).** A schedule with a valid pinned
    rate whose pair still matches forecasts that rate (what posting reuses), not the
    current market rate; a stale one falls back to the resolved rate.

12. **Top-level investment override forecast (F3).** An override changing
    quantity/price/total projects the override's effective cash amount, not the base.

Adversarial inputs drawn from `docs/testing-contract.md`: same-currency pair (rate
1, provenance recorded as `{X, X}` and always matches), a security-less amount-only
action (source = account currency), and a funding-account BUY vs a linked-cash BUY
(two different settlement currencies for the same brokerage).
