# Backend: transactions, exports and money

Exporter labels, blank transfer payees, scheduled loan interest, category identity, the currency a value carries, fallbacks and the Money import mapping. The cross-layer money rules are in `AGENTS.md` and `docs/financial-semantics.md`; this document holds the backend decisions that implement them. Read this before touching a transaction write, an export or a loan or category derivation.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## A label the exporter writes itself must need no escaping

The CSV formula-injection guard in `account-export.service.ts` exists for user-controlled text; when one of the exporter's *own* strings trips it (`-- Split --` got an apostrophe prefix on every split parent row), rename the label so it opens with a character no spreadsheet evaluates (`CSV_SPLIT_CATEGORY_LABEL` is `(Split)`) -- do not exempt the literal. Assert the *field*, not the line (`toContain` is satisfied by the neutralized cell), and keep the document-level check: export an all-ordinary-text fixture and assert no cell carries the guard's prefix.

A transfer's label is `csvTransferLabel` in the same file, and it names the direction as well as the counterpart (`Transfer To Savings`); a split line is asked with its own amount, not the parent's. Its twin is `transferCsvLabel` in `frontend/src/lib/transfer-label.ts`; the QIF export keeps Quicken's `L[Account]` form deliberately.

## A blank transfer payee is stored blank and resolved at read time

A transfer created without a payee persists `payee_name` as NULL (issue #1214); the display label is resolved per read from the linked leg's account -- its CURRENT name, in the reader's language. The English form for machine-facing surfaces (CSV/QIF export, AI/MCP rows, custom reports) lives only in `src/transactions/transfer-payee-label.util.ts`, and `transfer-payee-stamp.guard.spec.ts` fails on a `Transfer to/from ${...}` template anywhere else in `src/`. Migration 161 blanked the legacy-stamped rows; `updateTransfer` heals a surviving stamp to NULL and never regenerates it. A read surface joining `linkedTransaction.account` for this must mask or restrict cross-owner counterparts the reader cannot read (the account export masks; the custom report query restricts the join to same-owner legs).

The guard also asks what a value *is* rather than what it starts with, matching its twin in `frontend/src/lib/csv-export.ts`: a value a spreadsheet reads as a number is data, and prefixing one stops the column adding up (issue #1134) -- amounts bypass `escapeCsv`, so the rule covers text columns that can still hold a number (a cheque number written `-123`).

## Scheduled loan interest prices a dated ledger balance, at the moment it is consumed

A scheduled loan installment's interest is `roundMoney(debt * periodicRate)` where **both inputs are dated at that installment's due date**: debt is opening balance plus every non-void, top-level transaction through it (via the shared `LEDGER_MOVEMENT_PREDICATE`, which every balance reader composes so they cannot disagree about which rows count), and the rate is the latest `loan_rate_changes` row effective by then -- never `accounts.interest_rate` alone, which a recorded rate change deliberately does not write, so pricing at it charges a rate nobody pays (`effectiveAnnualRateOn`, truth table shared with the frontend) -- never a value advanced from the previously stored split (money already rounded to 4dp, so the recurrence compounds the discarded fraction) and never `accounts.current_balance` (a through-today read model that excludes future-dated rows). And the stored P/I split is a *template*, not an executable instruction: a principal movement committed between occurrences leaves it stale with no mutation path recalculating it, so the posting path re-resolves the allocation at the consumption boundary (`resolvePostingAllocation`, inside the posting transaction, under the parent lock) and the amortization report anchors its projection on the same due-date-bounded debt (`getLoanProjectionAnchor`). One pricing path -- `ScheduledTransactionLoanService.resolveInstallment` -- serves all three, because each one answered differently is a reported drift. `docs/specs/scheduled-loan-installment-pricing.md` is the spec; INV-LOAN-006 (issue #1253).

## A category's leaf name is not its identity

"Cell Phone" under **Bills** and under **Business** is an ordinary chart of accounts, so a bare leaf name identifies nothing. Both halves go through `categories/category-name.util.ts`:

- **Emitting**: `qualifiedCategoryName` / `loadQualifiedCategoryNames` produce `"Business: Cell Phone"`. Analytics groups on `SPLIT_CATEGORY_ID` and resolves the label from the map -- there is deliberately no category-*name* SQL fragment left, and `transaction-split-query.util.spec.ts` fails if one reappears.
- **Accepting**: `resolveCategoryNamePaths` matches a name the model sends back, separator- and spacing-insensitive, and **refuses an ambiguous one** with the qualified candidates rather than picking a winner.

The test that matters is the round trip: every name we emit must resolve back to the category we emitted it for (`category-name.util.spec.ts`) -- four hand-rolled resolvers had drifted apart, and one rejected the exact spelling every tool description tells the model to type, falling through to a last-segment fallback that silently read the *other* "Cell Phone".

Also: `Uncategorized` (the user filed it nowhere) and `Unknown category` (we could not resolve the name of the category they did file it under) are different facts with different constants. Do not fold the second into the first.

## A money value carries the currency it was calculated into

Not the currency of the account it is filed under. `InvestmentTransaction.exchangeRate` converts a trade into the *settlement* account's currency (the funding account when named, else the brokerage's linked cash account), so a PLN brokerage funded from EUR holds a EUR cost basis. The amount and its currency travel together (`ReplayedLot.currencyCode`), and a consumer compares that field against what it is reporting in. A mismatch is **unknown**, not a conversion -- today's rate answers today's question, not the acquisition's -- and two acquisitions settled in different currencies cannot be summed at all.

## A fallback answers only the question it was asked

A lookup that fails is a fact about *that* lookup. A stale scenario id says nothing about the user's other scenarios, so an empty report hardcoding `strategies: []` made a second claim without looking -- and took away the switcher that was the only route back. Fall back to the default rather than to nothing, and fill the surrounding fields from a real read. And a retry has to change something: recursing with the same id after establishing the id is gone is a comment claiming a recovery that cannot happen.

## Money investment mapping is finalized after both mappers run

`mapInvestments` cannot know whether `mapTransactions` will preserve or collapse a cash split. Reconcile generated investment companions only after cash-source mapping: when a redemption remains embedded, its preserved sibling is the interest record, so the generated companion and mutual link must not be written as a second representation of that income.

## A behavior promised "when a filter is active" keys off the filter itself, carried explicitly on the command -- never off a transport detail that sometimes coincides with it

Bulk update keyed its split-line restriction off `mode === "filter"`, but hand-picked rows ship as mode `ids`, so the filter silently stopped applying. The client sends the active filter as its own field in both modes (`BulkUpdateDto.categoryFilterIds`) and the server restricts on that; regression tests assert the ids-mode payload carries it and honors it.

## What a category cost is its debits NET OF its credits

A refund, return, chargeback or cashback filed against an expense category is a debit that came back, so it belongs in that category's total. Every surface that reached for the gross (`WHERE amount < 0` + `SUM(ABS(...))`, `if (amount >= 0) return`, `summary.totalExpenses` alone) disagreed with the register's own balance for the same filter (issue #1125). Sum the signed amount over rows of **both** signs, per category, and decide what the row *is* from the net: `isNetSpending` and `NET_SPEND_AMOUNT` (`backend/src/built-in-reports/spending-reports.service.ts`) on the server; `netEntityTotal` (`frontend/src/components/transactions/widget-shared.ts`) for a summary scoped to one category. Never take `totalIncome` or `totalExpenses` alone as a category's headline -- those are a register's in/out split.

Dropping the sign filter means income now reaches the aggregate and has to leave by a different door: a bucket whose net is not spending is not a row in a spending report -- one predicate, not a per-call-site `> 0`. Netting is **within** one category, never across two; both halves come from the same filtered aggregate. (The payee surfaces are deliberately unchanged: `PayeeInfoWidget` prints received credits as their own line beside the spend, so netting them into the headline would count them twice.)

## A calendar day's TOTAL is its own read model, and it is two halves of one series

`GET /accounts/daily-balance-totals` (`accounts/daily-balance-totals.service.ts`) answers one question `GET /accounts/daily-balances` does not: what the accounts in scope are worth together, in one currency, on each day of a month. Its history half is `AccountsService.getDailyBalances` and its projection half is `BalanceForecastService.getBalanceForecast` per account; it computes no balance itself, and `currentBalance` is read on neither side, so both halves stay ledger sums under `LEDGER_MOVEMENT_PREDICATE` (INV-BALANCE-001).

Four rules make the two halves one honest series, and each one exists because its opposite is the plausible mistake:

- **Actual or projected is the SERVER's day.** The response carries `today` and the client compares against it. A browser west of the server rolls over hours later, so a cell that consults its own clock captions a settled day a projection.
- **A projected day is priced at TODAY's rate, a history day at its own.** The day a projection is about has no rate yet; reaching for the nearest one would report a forecast at a rate nobody struck. One rate index (`common/time-series/rate-index.util.ts`, shared with `NetWorthService`) answers both.
- **A single-currency scope converts nothing and reports in its own currency**, not in the reader's preference. That is what makes one account's calendar agree with its own register's balance column to the cent, and it is why `missingRatePairs` is always empty there.
- **An account that cannot be answered is an unknown component, never a smaller total.** `FxAggregate.addUnknown()` carries an account whose forecast was withheld whole (`BalanceForecastService`'s rule, issue #1247) or that this caller cannot project at all -- today, a joint account, whose forecast belongs to its owner's identity and which the response names in `forecast.unforecastableAccountIds`. The day's `total` is then `null` with `knownSubtotal` holding what WAS known, which may only be printed under a caption that says it is partial.

The date range is bounded by `CALENDAR_RANGE_MAX_DAYS` (`common/validators/calendar-range.validator.ts`), which every calendar DTO reads so the cap cannot drift apart per endpoint: an unbounded range walks a per-day series over every account in scope and asks the forecast to expand every schedule to the horizon.
