# Financial Calculation Contract

The canonical rules for any code that computes, aggregates, or reports money.
They exist because the most tempting implementation of a financial calculation
-- filter out the nulls, sum what remains, default the unknown to zero -- is
syntactically clean and financially wrong. Every rule below was extracted from
a real defect where that pattern produced a plausible but incorrect number.

This contract applies to both surfaces that expose a calculation (REST API and
AI/MCP tools) and to every layer in between. `docs/time-series-contract.md`
covers the time-dimension rules (historical prices, backtests, period returns);
this document covers point-in-time calculation semantics. Rounding and
precision rules live in the root `CLAUDE.md` (Financial Math) and are not
repeated here.

## 1. Missing values propagate; they do not disappear

A field named `total*`, `portfolioValue`, `transferValue`, `gain`, `loss`,
`tax`, `costBasis`, or `estimated*` may only contain a value when **every**
component required for that calculation is known.

- Filtering out `null` components and summing the remainder produces a
  **subtotal**, not a total. It must never be returned under a field whose
  name says "total".
- If any component is unknown, the complete-total field is `null`. If the
  partial sum is still useful, return it in a **separate, explicitly named**
  field. One field must never silently represent both a complete total and a
  partial subtotal:

  ```typescript
  // The pair of fields a consumer can trust:
  totalMarketValue: number | null;     // null unless every position priced
  knownMarketValueSubtotal?: number;   // sum of the priced positions only
  unpricedPositionCount?: number;      // why the total is null
  ```

- The same applies to derived values: a percentage, allocation weight, or
  average computed from an incomplete total is itself incomplete and must be
  `null`, not computed from the subtotal as if it were the whole.
- When a response carries an incomplete value, it must also carry enough
  information for the consumer to see *what* is missing (a count, a list of
  affected ids, or an `incomplete: true` flag) -- silence is what turns a
  subtotal into a lie.

## 2. Cost basis and tax

Realized result is market value minus cost basis; tax applies only to gains.
When an operation sells multiple positions, the result is defined by this
truth table:

| Situation | Expected result |
| --- | --- |
| No securities are sold; the operation is funded only with cash | Realized result `0`, tax `0` |
| Every sold security has a known market value and a known cost basis | Compute the complete result |
| Any sold security lacks either its market value or its cost basis | Realized result `null`, tax `null` |
| Cash | Never contributes to realized gain or loss |

The pattern this table exists to forbid:

```typescript
// WRONG: computes a partial result and presents it as the result
// for the whole transaction.
positions.filter(
  (position) =>
    position.marketValue !== null && position.costBasis !== null,
);
```

A `0` and a `null` mean different things and must never be conflated: `0` is
a known result of zero (cash-only operation, break-even sale); `null` means
the result cannot be computed. Never default an unknown cost basis, price, or
tax input to `0` to keep a formula running.

## 3. Cash

Cash is a funding leg, not an instrument with a gain:

- Cash never contributes to realized or unrealized gain/loss.
- Cash is always "priced" -- a cash balance never makes a total `null`.
- Converting cash between currencies uses the exchange-rate rules of the
  operation's date; a missing exchange rate is missing data (rule 1), not a
  rate of `1`.

## 4. Valuation requirements

A calculation that needs a market value must state, and honour, where that
value may come from:

- A position without a usable price has `marketValue: null`, and rule 1
  propagates it. Do not substitute the purchase price, the last known price
  beyond the staleness bound, or zero.
- What counts as a "usable" price -- how recent it must be, and how close to a
  period boundary -- is defined in `docs/time-series-contract.md`.
- Multi-currency aggregation converts every component into the reporting
  currency before summing; a missing rate makes the affected component, and
  therefore the total, unknown.

## 5. Materialized derived results declare their inputs

Every materialized derived result -- stored signals, forecasts, cached
reports, snapshots, and any other persisted calculation -- must declare the
complete set of inputs that determine it (configuration such as cadence,
lookback, instrument and account selection; and the data it was computed
over).

- When any declared input changes, the old result must be **versioned,
  recomputed, or excluded**. Never silently reused.
- Results produced under different input revisions must never be combined
  into one aggregate, history, or simulation. A history that mixes revisions
  is not a history of anything.
- The practical mechanism is a configuration fingerprint (hash of the
  declared inputs) stored alongside each materialized row; a read that finds
  a fingerprint mismatch treats the row as stale.

## 6. `ON CONFLICT DO NOTHING` and read models

When an operation performs `INSERT ... ON CONFLICT DO NOTHING` and then
returns a read model, losing the insert race must not change what the caller
sees:

- After the insert attempt, **re-read the authoritative state** inside the
  same transaction and build the response from that fresh read.
- Never build the response from a snapshot loaded before the insert attempt
  -- the request that lost the race would return data missing the rows the
  winning request just inserted.

## 7. Testing requirements

"Add tests" is not sufficient for financial code -- a test written by the same
author as the implementation tends to confirm its assumptions. Every financial
calculation needs:

- **An edge-case matrix** covering, where applicable: no positions / one /
  many; all data known; only some data known; cash plus securities; multiple
  accounts and currencies; missing prices; stale prices; missing cost basis;
  simultaneous gains and losses; configuration changes; deleted or replaced
  instruments; concurrent requests; first-time materialization; and payloads
  that pass through the real validation pipeline (not hand-built objects).
- **At least one adversarial regression test per formula**: a case where a
  naive implementation using `filter(null)`, a default zero, or stale-value
  carry-forward would produce a plausible but incorrect result -- and the test
  fails on it. If the naive implementation would pass the whole suite, the
  suite is missing its most important case.

## 8. Specification before implementation

A financial feature of any substance starts from a short written design
document, approved before implementation, containing: the invariants, the
truth tables (like section 2), numerical examples, the missing-data policy,
versioning and recomputation rules, concurrency behaviour, and the test
matrix. A specification written after the code -- or grown out of review
findings -- documents decisions; it does not guide them. This is the
domain-level counterpart of the propose-first workflow in `CONTRIBUTING.md`.
