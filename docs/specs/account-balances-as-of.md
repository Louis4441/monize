# Spec: point-in-time account balances

Status: approved for implementation on `claude/account-balance-suggestions-u3an4n`.
Governs: issue #1198 -- the Account Balances report advertises "balance history
over a selected time period" and offers no date at all.

Read `docs/financial-calculation-contract.md` sections 1 and 8.1, and
`docs/specs/fx-conversion-completeness.md`, before changing anything here.

## 1. What the report is

A balance is measured at a single instant, so the report answers exactly one
question: **what was each account worth at the end of `asOfDate`?** The date is
free -- any day in the past or the future -- and defaults to the caller's today.

Everything else the issue asks for (which accounts are included, how they are
grouped, how they are sorted) is presentation over that one figure and is
decided on the client.

## 2. The behaviour this replaces

The report previously rendered `currentBalance + futureTransactionsSum`: today's
posted balance plus *every* future-dated transaction, however far out. That is
not a point in time -- it is a projection to the end of the ledger, and it was
labelled "balance". Two accounts with the same balance today but different
scheduled activity read as different balances with nothing on screen saying as
of when.

Under this spec the default view (`asOfDate` = today) shows today's balance, and
the end-of-ledger figure is reachable by picking that date. **This changes the
numbers the report displays for any user holding future-dated transactions**;
`AccountBalancesReport.test.tsx` carries the case that pins it.

## 3. Definitions

For an account `a` and a date `d` (YYYY-MM-DD):

**Ledger balance** -- the same expression `recalculateCurrentBalance` uses, with
`d` in place of today:

```
opening_balance + SUM(amount)
  over transactions WHERE account_id = a
    AND (status IS NULL OR status <> 'VOID')   -- a VOID row moved no money
    AND parent_transaction_id IS NULL          -- a split child is not a movement
    AND transaction_date <= d
```

**Market value** (holdings accounts only -- `INVESTMENT_BROKERAGE`, or
`INVESTMENT` with no sub-type): replay every non-VOID investment transaction
dated `<= d` through `applyActionToQuantity`, then value each non-zero position
at the security's close **standing for `d`**, converted into the account's
currency at the exchange rate standing for `d`.

"Standing for `d`" is `closeAt` (`backend/src/common/time-series/price-boundary.util.ts`),
the one door in `docs/time-series-contract.md` section 2.1: the most recent
observation at or before `d`, and only when it was struck within
`BOUNDARY_LAG_DAYS`. A rate is an observation on a date exactly as a close is,
so both go through it. Each query is bounded on both sides to exactly the window
the door accepts, so the read and the rule cannot disagree.

The bound is what stops a position last quoted months ago being reported at that
price under `d`'s heading -- an instrument that would then appear to have gone
nowhere since, from a single observation. A security outside the window is
**unpriced** for `d`, which makes the account's total null (section 4), not
smaller.

Carrying the last accepted close forward is also what makes a future date
meaningful: the position is held at the most recent figure anybody knows, which
is the only honest answer a valuation can give about a day that has not
happened. It is *not* a forecast, and today's close is always inside the window.

## 4. Missing data

Per the contract, a total is `null` unless every component is known.

| Condition | `marketValue` | `knownMarketValueSubtotal` | flags |
|---|---|---|---|
| every position priced and converted | the total | same number | `valuationComplete: true` |
| a held position has no accepted close for `d` -- none at all, or none newer than the boundary window | `null` | sum of the priced ones | `unpricedHoldingsCount > 0`, `pricesComplete: false` |
| a position's currency has no accepted rate to the account's currency | `null` | sum of the converted ones | `missingRatePairs` names the pair, `fxComplete: false` |
| account holds no positions at `d` | `0` | `0` | complete -- an empty portfolio is worth zero, not unknown |
| account is not a holdings account | `null` | `0` | `valuationComplete: true`; the field does not apply |

`balance` is never `null`: a ledger sum over rows the database holds is always
known, and an account with no transactions before `d` sits at its opening
balance.

`valuationComplete` means *every component of every figure this row reports is
known*. A consumer reads it as `=== false`, never `!`, so a response from a
backend that predates the field reads as "no information" rather than
"incomplete".

## 5. Shape

```typescript
interface AccountBalanceAsOf {
  accountId: string;
  currencyCode: string;
  /** Ledger balance in the account's own currency at the end of asOfDate. */
  balance: number;
  /** Holdings valued at asOfDate, account currency. null unless complete. */
  marketValue: number | null;
  /** The part of marketValue that is known. 0 for a non-holdings account. */
  knownMarketValueSubtotal: number;
  /** Held positions with no price at or before asOfDate. */
  unpricedHoldingsCount: number;
  /** "USD->CAD" for each pair with no rate at or before asOfDate. */
  missingRatePairs: string[];
  pricesComplete: boolean;
  fxComplete: boolean;
  valuationComplete: boolean;
}

interface AccountBalancesAsOfResponse {
  /** Echoes the date actually used, so a payload carries its own request key. */
  asOfDate: string;
  accounts: AccountBalanceAsOf[];
}
```

The response echoes `asOfDate` because the client offers actions beside it: a
payload without the date that produced it cannot be told from the previous one
(`frontend/CLAUDE.md`, "Asynchronous data carries the request that produced it").

## 6. Numerical examples

| Setup | `asOfDate` | `balance` | `marketValue` |
|---|---|---|---|
| opening 100, +50 on 2026-01-10, +25 on 2026-06-01 | 2026-03-01 | 150 | n/a |
| same | 2026-06-30 | 175 | n/a |
| same, the 2026-06-01 row VOID | 2026-06-30 | 150 | n/a |
| BUY 10 @ 20 on 2026-01-05, close 22 on 2026-02-27, none later | 2026-03-01 | 0 | 220 |
| same, plus SPLIT ratio 2 on 2026-02-01 | 2026-03-01 | 0 | 440 |
| same, but no close on or before the date | 2026-01-04 | 0 | `null` |
| same, last close 2025-09-30 (outside the window) | 2026-03-01 | 0 | `null` |
| BUY 10 @ 20 USD in a CAD account, no USD->CAD rate | any | 0 | `null` |

## 7. Display currency

Conversion of each account's figure into the user's display currency stays on
the client, at **current** rates, exactly as it does today -- the report's
summary cards, group subtotals and chart already go through `convertToDefault`
and `PartialTotal`. Only the security-to-account-currency leg inside a holdings
account uses the as-of rate, because that leg is part of the account's own
figure rather than of its presentation.

This is a deliberate split, not an oversight: "what my 2019 balance is worth to
me now" is the question the display currency answers.

## 8. Test matrix

The backend spec must cover, at minimum:

1. Ledger balance at a past date excludes later rows, at a future date includes
   them, and at today equals `current_balance` for an account with no future
   rows.
2. A VOID row contributes nothing at any date.
3. A split child contributes nothing (its parent already carries the total).
4. An account with no transactions before the date reports its opening balance.
5. Holdings replay honours SPLIT as a ratio, and ADD_SHARES / REMOVE_SHARES.
6. A position with no price at or before the date -> `marketValue: null`,
   `unpricedHoldingsCount` counts it, `knownMarketValueSubtotal` holds the rest.
7. A position whose currency has no rate -> `marketValue: null` and the pair is
   named.
7a. A close, and separately a rate, older than `BOUNDARY_LAG_DAYS` is refused
   the same way; one a few days old carries forward across a weekend.
8. A holdings account with no positions -> `marketValue: 0`, complete.
9. A rejected date (not YYYY-MM-DD) is a 400 and writes nothing.

The client tests must cover the filters, the grouping keys, the sort orders, and
the default-date change in section 2.
