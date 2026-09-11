# Frontend: financial figures

The client-side half of the financial contracts: scheduled occurrences, portfolio baselines and ranges, loan figures and history, chart reductions, and how an unknown value is rendered. The cross-layer rules live in `docs/financial-semantics.md`, `docs/time-series-contract.md` and `docs/financial-calculation-contract.md`; this document holds the frontend-specific decisions that implement them. Read it before rendering, deriving or totalling a money figure.

Paths beginning with `src/` or `scripts/`, and layer configuration filenames, are relative to `frontend/`; other source paths (including `test/...`) are relative to `frontend/src/`. Explicit repository prefixes are preserved. `frontend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## A scheduled occurrence's amount is `nextOccurrenceEffectiveAmount`, never `nextOverride?.amount ?? amount`

`ScheduledTransaction.amount` was computed at whatever FX rate was current when it was written, so for a top-level investment schedule (whose `amount` is the *security-currency* cash impact) or a split parent carrying an investment line it is a stale snapshot -- and it is labelled with the brokerage account's `currencyCode`, not the settlement currency the cash lands in. Read `effectiveAmount` / `effectiveAmountComplete` / `effectiveCurrencyCode` through `lib/scheduled-effective-amount.ts` (`scheduleEffectiveAmount`, `overrideEffectiveAmount`, `nextOccurrenceEffectiveAmount`, `sumEffectiveOccurrences`).

`null` means the server could not work the amount out. Render `UnknownAmount` (`components/ui/UnknownAmount.tsx`) -- never the stored figure and never a zero -- and withhold any total containing it, keeping the partial sum under its own name. An **absent** field is an older backend mid rolling deploy, which the helper already reads as unknown for an FX-sensitive schedule and as the stored amount for everything else.

**The date is the other half, and `nextDueDate` is not it.** That column is the recurrence *slot*; an override addressed to the slot can move the occurrence, so filter, sort and print `nextOccurrenceDueDate(st)`. A surface that reads the slot announces a payment on a day the user has already changed -- the same defect as reading the stored amount, applied to the date.

**Which account an occurrence charges is `occurrenceSettlementAccountId`, never `st.accountId`.** A scheduled investment's `accountId` is the *brokerage*; its cash settles in the named funding account or the brokerage's linked cash account. The dashboard's below-zero projection ran on `accountMap.get(item.accountId)`, so a purchase whose funding account covers it to the cent was flagged as overdrawing a balance the trade never moves, and the account that pays was left out of the projection altogether. The server sends `settlementAccountId` on the `findAll` read model -- the same decision `resolveSettlementAccountId` makes for the posting -- and the helper falls back to the funding/linked account when the field is absent (an older backend), answering `undefined` rather than naming the brokerage when neither resolves; a caller projects nothing there. `effectiveCurrencyCode` is that account's currency by construction, which is what makes adding the two sound -- compare them before you add, and treat a mismatch as unknown. A running balance is also rounded at each step (`roundMoney`): 647.67 + 301.70 - 949.37 is exactly zero in `decimal(20,4)` and a shade below it in binary floating point, which is all `< 0` needs to raise the warning. `scheduled-effective-amount.guard.test.ts` fails a `<map>.get(<x>.accountId)` in any file that resolves an occurrence's amount.

**A total over occurrences is converted, never added.** `sumEffectiveOccurrences` (`lib/scheduled-effective-amount.ts`) takes the converter and cannot be called without one; its predecessor accepted an `EffectiveScheduledAmount` accessor and read only the `amount`, so the Upcoming Bills report and the budget panel summed a CAD occurrence beside a USD one and formatted the result in the reader's default currency. Check `isComplete` before displaying the value, and format a *row* with its own `currencyCode` -- `formatCurrency(amount)` with no code labels a CAD figure with whatever the reader's default is. `UnknownAmount`'s `reason` tells the two causes apart: `displayFx` is a missing display rate (fix it on Currencies), `scheduledFx` is the occurrence's own settlement rate.

**A list of occurrences comes from the server, not from a loop here.** `scheduledTransactionsApi.getOccurrences({ through })` returns one row per occurrence with the amount THAT occurrence would post; expanding the recurrence in the browser can produce dates but never per-occurrence amounts, which is how the Upcoming Bills report came to print, total and export one schedule-level figure against every occurrence it drew. `lib/forecast.ts`, the bills calendar and `OccurrenceDatePicker` are the named exemptions, each for a reason the guard records.

`lib/scheduled-effective-amount.guard.test.ts` scans `src/` for the `override.amount ?? …amount` fingerprint, for a client-side recurrence expansion outside those exemptions, and for the report actually calling `getOccurrences` -- import presence is not proof, since the report imported this helper throughout the period it was applying one amount to every occurrence. `PostTransactionDialog` is the one fallback exemption: it seeds the POST form's editable field, which is the write path. Issue #1247, INV-OCCURRENCE-003.

## A scheduled transaction has four kinds, not two -- `scheduledKind`

`amount < 0` / `> 0` answers half the question: a **transfer** between own accounts is neither bill nor deposit, and exactly **zero** is a deliberate placeholder for an amount unknown until it arrives. A sign ternary paints the zero green, and a `!st.isTransfer` filter deleted a scheduled transfer from both calendars (issue #1124).

Classify with `scheduledKind` (`lib/scheduled-kind.ts`) -- `bill | deposit | transfer | reminder` -- and colour from `SCHEDULED_KIND_CHIP_CLASSES` / `SCHEDULED_KIND_AMOUNT_CLASSES`. Where the surface is about one occurrence, classify it with `occurrenceKind(occurrence, schedule)` from the same file rather than composing an amount at the call site: kind is a question about direction, an exchange rate is positive, so the schedule's *sign* still classifies correctly when the occurrence's own magnitude is unknown -- and `Number(null)` would paint an unpriceable bill as a grey reminder. `scheduled-effective-amount.guard.test.ts` scans for the composed `scheduledKind({ amount: x ?? y })` shape.

A surface listing *occurrences* includes every active schedule whatever its kind. Filtering by kind is for a surface genuinely about bills or deposits, and there a `reminder` belongs in neither bucket -- except where the surface is about *what the user still has to pay*, where a zero-amount reminder counts as an upcoming bill contributing nothing (`BudgetUpcomingBills`). A **money total** is a separate decision from the count: a transfer is counted as upcoming but its amount never joins a bills-and-deposits sum (`UpcomingBillsReport`'s `summary.totalOf`), and a reminder's zero is never given a sign or a red/green treatment.

## A stored occurrence price is an instruction; the market close is a suggestion

An investment price *or quantity* the user saved is a decision, not a stale default: live market data may be *offered* beside it but never *written over* it. `OverrideEditorDialog` auto-fills from the latest close only when the occurrence has no price of its own and the user has not typed a total (`hasStoredPrice` false, `userEditedTotal` false, field empty), otherwise exposing an explicit "use latest close" action. `PostTransactionDialog` skips its market-price refresh when the prefill came from a per-occurrence override (`investmentFromStoredOverride`, keyed off a stored price *or* quantity) or when the user has edited any field (`userEditedInvestment`).

Both fills are **total-first** (issue #1148): they preserve the amount invested and re-derive the share count. The two guards differ because the state each fill runs against differs: the override editor blocks only on a typed **total** (the one state where the fill would rescale the quantity), while the post dialog always carries a total and so blocks on **anything** typed. The fetch is asynchronous -- it can resolve after the dialog opens, and a value typed in the meantime is the user's instruction. A NaN or zero close is not a usable price -- normalize to null where `marketPrice` is set (`usableClose`).

`marketPrice == null` is three states at once (loading, failed lookup, genuinely empty history), so it must not gate the "no price history, enter manually" hint. Each surface carries a `priceHistoryEmpty` flag set true *only* when a request completes with no usable close, reset while in flight, left false on rejection.

Three surfaces fill these fields -- the two dialogs and `ScheduledTransactionForm` -- and all three do the price/quantity/total arithmetic through `lib/investmentFold.ts` (`totalFromQuantity` / `quantityFromTotal`: one rounding scale, one signed commission fold). Never hand-roll the fold; `lib/investmentFold.guard.test.ts` scans for the 8dp share-precision rounding that fingerprints a hand-rolled copy. State a stored price's provenance truthfully ("saved on this occurrence" vs "from the schedule" are different keys); format "latest close" copy through `useNumberFormat().formatPrice` (a price is not money: up to six decimals, Intl-trimmed), never a hand-rolled `toFixed`. Compose any "Label: value" line in the catalog as one string a translator can reorder, never `{t('label')}: {value}` fragments.

`ScheduledTransactionForm` adds two invariants because its `Total Value` is a shown figure that submit recomputes: **the displayed total and the persisted amount must never disagree** -- every field that moves the economic total (price, quantity, **commission, and the BUY/SELL action whose sign flips the fee**) recomputes the shown total through the same fold, and an async close arriving mid-entry preserves a typed total and re-derives the quantity. And **a market price belongs to one security**: changing the selected security clears the auto-filled price and the seen-market-price latch. Gate the "Latest:" placeholder on a positive `roundedMarketPrice`, never a bare `marketPrice != null`, so it never renders "Latest: NaN".

## A short-range portfolio change is measured from the prior close

On `1d`, `1w` and `mtd` the Change and Change % measure from the close of the last trading day *before* the window -- the convention every quote source reports against. The longer ranges measure from their first point (their window opens on a day whose first point already is that day's close). Which ranges are which lives in `PRIOR_CLOSE_BASELINE_RANGES`.

This was briefly a user preference (migration 152, dropped by 153); it was removed because the prior close is the right answer rather than a taste. `usesPriorCloseBaseline` takes the range and nothing else -- if you find yourself adding a second argument, first ask whether the alternative is actually defensible.

Both halves come from **one hook**, `hooks/usePortfolioChangeBaseline.ts` (`usesPriorClose` and the `priorClose` together); the arithmetic and range set live once in `components/investments/portfolio-change-baseline.ts`. Deciding *whether* a prior close applies in one place and reading the close in another is the specific bug the single hook prevents. The baseline is looked up for the **first point on screen**, never the requested window start (on a weekend the 1D chart shows the last session). A baseline that has not loaded makes the change **unknown** -- both cards read N/A, never the first-point change.

The change itself is `portfolioSeriesChange(values, { usesPriorClose, priorCloseValue })`, read by the Investments chart and the Portfolio Value widget alike, so no surface can report a different move for the same window. A **baseline of zero has no percentage**: the money change is still known, the percentage is `null`, and 0% -- which would say the portfolio held its ground -- is never shown.

## The window a price chart requests is not the period its range names

`resolveRangePreset` answers "what period is the user asking about", and ten reports depend on that answer. A *price* chart asks a narrower question -- **which close is the series measured from** -- so it has its own function: `components/investments/portfolio-range-window.ts` holds the table (`PORTFOLIO_WINDOW_STARTS`), and the Portfolio Value report, the Investments chart and the dashboard widget resolve through `usePortfolioRangeWindow`. Do not reach for `resolveRangePreset` in a fourth portfolio surface, and do not "fix" a range by editing the shared resolver.

The rules are not uniform -- each matches the platform being compared against:

- **3M, 6M, 1Y, 2Y, 5Y** open on the calendar day *before* the period (2Y follows the calendar, not a 730-day count).
- **YTD** opens on the year's first *trading* day (`netWorthApi.getFirstPricedDay` answers from `security_prices`). A null answer keeps the calendar boundary rather than claiming a trading day nobody observed.
- **1M** keeps its window and collapses its first *day* to that day's close (`trimIntradayToFirstDayClose`) -- it is an intraday chart, and opening mid-session a month ago mixes a mid-session price into a series of closes. 1D deliberately opens at the open; 1W and MTD are measured from the prior close already.

Both intraday adjustments live inside `trimIntradayPoints`, which every intraday render site calls -- a shaping step applied at three of four call sites is a chart that disagrees with itself.

**A range served monthly cannot honour a day-precision rule.** 2Y and 5Y use month buckets, so their first point is a month-end close. Switch the range to daily if the exact opening close matters; do not prepend a single daily point to a monthly series (the sampling splice `docs/time-series-contract.md` section 1.2 exists to stop).

`mtd` is a chart range with no backend series of its own: it rides on the rolling 1M series and is trimmed client-side. Both halves go through `portfolio-chart-utils.tsx` -- `intradayRangeParam` before every intraday request, `trimIntradayPoints` on every response, including the sessionStorage-cached one and the per-security breakdown. Sending `mtd` verbatim is a 400 from `IntradayValueQueryDto`'s enum; a response used untrimmed puts last month's bars in a month-to-date chart. A guard test asserts every member of `INTRADAY_RANGES` maps onto a range the endpoint accepts.

## A loan's payment, payoff and remaining interest are decided once -- `deriveLoanFigures`

Three figures appear on every amortizing-debt surface (the loan detail page's summary cards, the transactions Details sidebar), and each has a state that is neither a number nor "unknown":

- A **settled** debt owes nothing: remaining interest is a known **zero** and the payoff is "Paid off" -- not `null`. Settled means *nothing outstanding* (`-balance <= 0.01`), so an overpaid loan in credit is settled too (`Math.abs` read that credit as debt).
- A projection that hits its horizon without paying off (`paidOff` false) has no payoff date, and its accumulated interest is a subtotal -- both figures are unknown; printing the horizon's number under "Est. Remaining Interest" is a total's label over a partial sum.

`lib/loan-figures.ts` makes the decision once and both surfaces render its output. The data comes from `hooks/useLoanProjection.ts` or a `baseline` the caller already has -- never a second copy of the branching. A failed history load is `status: 'error'` with every figure unknown, never an empty history (which would project a plausible payoff from no payments at all).

## "Today" for a financial decision is the user's day -- `useFinancialToday()`, never `toISOString()`

`new Date().toISOString().slice(0, 10)` is a UTC calendar day, and the backend has never used one: `RequestContextInterceptor` resolves `todayYMD()` from `user_preferences.timezone`, falling back to the `X-Client-Timezone` header the axios interceptor sends. A client that slices a UTC instant is on a third calendar for the first hours after local midnight east of Greenwich (fourteen at UTC+14) and the mirror window before it in the west -- long enough that the loan report accepted an anchor the bill had already called overdue and projected from a balance the ledger no longer held.

`lib/financial-today.ts` (`financialTodayYmd`) is that resolution, and `hooks/useFinancialToday.ts` is how a component gets it. Pass the day into the pure calculation rather than letting it read the clock -- a boundary case is then a stated day and a pinned instant, not a test that only fails when the runner's `TZ` sits on the wrong side. `lib/loan-projection-today.guard.test.ts` fails a projection call that omits `todayYmd`, one whose day comes from anywhere else, and any `toISOString()` day-slice in `lib/loan-history.ts` or its call sites. (`getLocalDateString` stays right for a browser-local default like a form's date field; it is not the answer to "which day is this loan being priced on".)

## A historical loan row states the ledger; only a projection may estimate

`deriveLoanPaymentHistory` reports what a payment actually recorded -- a recorded interest split, else the separate interest expense paired to its date, else **zero**. It never derives interest from the balance and the rate: a $450 principal-only transfer was printed as Payment $500 / Principal $450 / Interest $50, and that fabricated $50 flowed into Interest Paid, every cumulative total, the CSV and PDF exports and the installment the forward projection is seeded with (issue #1255). Estimating is the projection's job, and a projected row is labelled as one. Nothing in `lib/loan-history.ts` reads `getPeriodicRate` to produce an *amount*; a matrix in `loan-history.test.ts` asserts zero interest for a principal-only payment across every account type, Canadian/variable flag, frequency and rate-timeline combination, because each was a separate door into the estimate.

**Not estimating has a price, and the place to pay it is the seed, not the history.** A loan booking its interest outside the app yields `principal + 0` as its observed installment, which `generateLoanSchedule` refuses outright, taking the payoff date and remaining interest with it. `resolveSeedPayment` therefore falls back to the stored contractual `paymentAmount` -- but only for an **incomplete** installment, and the two cases look identical from the number alone. **Complete** (the row's interest was recorded) is the payment, whether or not it still covers the interest: a payment that has fallen behind a rate rise is a real financial state and the schedule refusing it is the honest answer. **Incomplete** (`principal + 0`) is not a smaller payment but a partial one, and the contractual figure is the only complete payment fact such a loan has. Do not restore the estimate to keep a projection alive, and do not pick the largest number to hand -- that dresses a refusal up as a decision about the loan.

**"Current Payment" and the projection seed are one function.** They were two, resolved separately, and disagreed: the card read `principal + 0` = "$450" beside a payoff computed from the contractual $950 -- issue #1255 inverted, with the payment understated by its whole interest portion instead of the interest being invented. The analytic estimate had been hiding it by making the two agree. `resolveCurrentLoanTerms` and `buildLoanProjectionInput` both return `resolveSeedPayment`'s answer -- the rate as well as the payment, so the summary card, the PDF, the two loan reports and the transactions sidebar all print the terms the schedule beside them is built from. A surface needing "the terms in effect" calls that one function; `observedInstallment` is the only derivation of the raw last-installment figure, and the `deriveCurrentInstallment`/`resolveCurrentInstallment` pair it replaced is gone rather than left exported with the pre-change semantics for someone to call by mistake.

**A projection's rate and payment come from one effective state, and the rate timeline is it.** Recording a rate change deliberately does *not* write `account.interestRate` / `account.paymentAmount` — the backend keeps them user-owned, settable only from the account edit form — so after any change entered through the rate-history UI the scalars hold the *old* terms while `loan_rate_changes` holds the current ones. `buildLoanProjectionInput` resolves both from the rows dated at or before today, falling back to the scalar only when no row applies; taking the payment from one source and the rate from the other prices a payoff at a rate nobody is paying (a stale 5% against a real 12% makes a payment $100 short of the interest look comfortably amortizing). Two consequences worth spelling out:

- **Every surface that projects must load the timeline.** The Loan Amortization and Debt Payoff Timeline reports passed `[]` for years, so the same loan had two payoff dates depending on which screen you opened. Both now fetch it inside their existing request key.
- **Do not reach for `buildRateTimeline`'s `startingAnnualRate` / `startingPaymentAmount` for a schedule anchored *today*.** Those carry a deliberate "before the earliest row, the earliest row applies" fallback, which is right for a schedule anchored at **origination** (`loan-past-impact.ts` builds the contractual schedule that way) and wrong here: under it a rate change dated next year sets today's rate *and* is applied again as a future step. Rows dated ahead are steps, never the current state. `resolveEffectiveLoanTerms` (`lib/loan-schedule.ts`) is the today-anchored answer, living beside `buildRateTimeline` so a test pins the difference between the two anchors.
- **An `initial` row's payment is neither authoritative nor worthless.** Two things write that source and it means different things in each, with nothing on the row to tell them apart: `insertInitialRowIfFirst` copies `account.paymentAmount` verbatim (a snapshot that goes stale the moment the user corrects that field), while `RateChangeInferenceService`'s first segment carries the *modal observed* payment. So `resolveEffectiveLoanTerms` returns it as `snapshotPaymentAmount`, and `resolveSeedPayment` ranks it with the account's scalar and tests it against the period's interest: an observation that amortizes is used, a stale copy that no longer covers the interest falls through to the corrected scalar. Seeding it unconditionally pinned the projection to the snapshot; discarding it threw away the observation. Its *rate* is authoritative either way -- that really is the origination rate. Only `manual` and `inferred` rows state a payment outright; detection writes null when interest is booked separately.
- **The amortization guard is evaluated at the rate row 1 will run at, not today's.** `firstPaymentDate` is a full period ahead and `generateLoanSchedule` applies every step dated on or before a row to that row, so a change recorded for next week lands on row 1; guarding at today's rate passes a candidate the next line then refuses, and the projection vanishes instead of using one that works. Same "a preview computes what the commit will do, through the same code" rule as the FX previews.
- **A surface listing debt accounts cannot assume the selected one has a rate history.** Every `/accounts/:id/rate-changes` route answers **400** for anything but LOAN and MORTGAGE, and all three loan reports list `LINE_OF_CREDIT` too. Gate the fetch with `supportsRateChanges` (`lib/loan-rate-changes.ts`, where the endpoint's precondition is written once); an ungated fetch replaced a whole report with its error state, persisted in localStorage so it stayed broken across reloads with no in-page way to pick another account. The report tests missed it because their mock resolved `[]` for every account type -- a fixture the API cannot produce.

  "Written once" is a claim about four other lists, so a test makes it one: `lib/loan-rate-changes.contract.test.ts` checks `RATE_CHANGE_ACCOUNT_TYPES` against the backend's copy (parsed out of `loan-rate-changes.service.ts`, since the two cannot import each other), against the account page's detail-view registry, and against the overpayment simulator's debt-account list -- and it enumerates every caller of `loanRateChangesApi.getAll`, so a fifth one fails the suite until it either gates on the predicate or is tied structurally like the four. `useLoanProjection`'s "amortizing debt" set derives from the export rather than repeating it, which is load-bearing rather than tidy: that hook fetches rate history for every type in the set, so a type in one list and not the other would take a 400 on every load and report the projection as `error`.

**The amortization report's projection is anchored on the next scheduled bill, not on today.** `account.currentBalance` runs through today, so a future-dated or between-occurrences principal payment left the report's first projected row disagreeing with the bill the backend prepares from the ledger through the schedule's due date (issue #1253, INV-LOAN-006). `scheduledTransactionsApi.getLoanProjectionAnchor(accountId)` returns that boundary -- `{ nextDueDate, debt }`, both null when the loan has no active scheduled payment -- and `LoanAmortizationReport` fetches it inside the same request key as the history and passes it to `buildLoanProjectionInput` / `resolveCurrentLoanTerms` as the optional `anchor`. Anchored, the first projected row and the next bill are measured at the same date against the same balance. The **rate** comes from the same place on both sides: the backend resolves the bill's rate through the timeline too (`effectiveAnnualRateOn`), against a truth table both layers assert (`loan-rate-timeline-cases.json`). Which surfaces pass an anchor is enumerated by `lib/loan-projection-anchor.guard.test.ts` -- an omitted optional argument is otherwise indistinguishable from a deliberate today-anchored projection, which is how #1247 recurred. Unanchored surfaces (loan detail payoff, Debt Payoff Timeline, Overpayment Simulator) deliberately keep the today-anchored semantics; they make no per-installment parity claim. Like the rate history, the anchor is a prerequisite: a failed fetch reaches the report's error state rather than silently projecting from today.

The rate history is therefore a prerequisite, not decoration: a failed `loanRateChangesApi.getAll` fails the account-detail load rather than degrading to `[]`. The scenarios list beside it still degrades with a toast, because no headline figure is derived from it — that difference is the whole rule.

**An amortization guard filters candidates; it does not overrule the authoritative one.** The rate timeline's `startingPaymentAmount` is the payment *in effect* (`LoanRateChangesService.resolveCurrentTimeline`), and it can never be a principal-only figure -- `RateChangeInferenceService.persistSegments` writes `newPaymentAmount: null` outright when interest is booked separately, for exactly that reason. So `buildLoanProjectionInput` seeds it whether or not it amortizes: a timeline payment that no longer covers the interest is a fact about the loan (a rate rise the installment has not caught up with), and swapping in the independently user-owned `account.paymentAmount` reports a payoff computed from a payment the timeline says nobody is making. Rank candidates by *authority* first and test only the unranked ones against the guard.

**A failure identity must be retired by the success that answers it.** `useLoanProjection` stamps both its payload and its failure with the account they belong to, and the failure is checked first -- so a success that does not clear it leaves fresh, complete data outranked by a stale error, and no in-page refresh recovers the figures. Clear it inside the state updater (`setFailedAccountId((failed) => (failed === accountId ? null : failed))`), never against the render's value, so a failure recorded for a *different* account mid-flight survives. Do not clear it when the load *starts*: that turns a truthful error into `loading` before the retry has proved anything. This is the retry half of "asynchronous data belongs to the request that produced it", and the test that catches it has to combine two states -- failure, then same-account refresh, then success -- which is why per-state tests all passed while the latch shipped.

**The rate is a separate fact from the interest, and the fix for one must not drop the other.** With no recorded rate history the Rate column is reconstructed from the interest charged -- but a row that charged nothing still has a known rate when the loan is *fixed*: `assignObservedRates` falls back to the configured `interestRate` there, and only there. A variable-rate loan's scalar rate is only today's, so its unrecorded history stays `null`.

**0% is a rate, and `Number(null)` is 0 -- so the test is `!= null`, never `> 0` or truthiness.** That one coercion produced the same defect at three depths of the same feature: `assignObservedRates` gated its fixed-rate fallback on `configuredRate > 0` and so drew "--" on every row of an interest-free loan; `observedInstallment` read `interest > 0` as "the interest is known" and marked a 0% loan's fully stated `principal + 0` installment *incomplete*, refusing the payoff of the one loan whose figures are certain; and five render sites read the resolved `annualRate` for truthiness and printed "Not set" over a recorded 0%. The rule is symmetric with the unknown-value rule below and easy to get backwards: **an unknown must not render as a measured zero, and a measured zero must not render as unknown.** Decide which of the two a branch is in before writing it. `lib/loan-history.guard.test.ts` scans `src/` for the render half.

**Interest is identified by provenance, not by absence.** `readRecordedInterest` used to take "the first split that is not the principal transfer" — a predicate that says what a line is *not*. A real mortgage payment has more than two lines (principal to the loan, escrow or property tax, insurance, a fee, the interest), so whichever non-principal line happened to be listed first became Interest Paid: $500 of escrow reported as interest on a payment whose interest was $300, and on into every cumulative total, export and projection seed. The loan already names its interest category, so the rule is `categoryId === account.interestCategoryId`, summed over matching lines and order-independent by construction. Without a configured category only a *single* category line is unambiguous; two or more return `null` so the caller falls through to a paired separate expense and then to zero, because guessing one is the defect. A transfer leg is never interest — interest is paid to the lender, so it is an expense, and the old `!== loanAccountId` predicate accepted a transfer to any third account.

**"A categorized line" means the same thing on both sides of that rule.** `readRecordedInterest` and `ScheduledTransactionLoanService` (which recalculates the templates it reads back) both count `categoryId && !transferAccountId`. They differed by that one clause, so `[principal, categorized interest, uncategorized fee]` was one candidate line to the writer and two to the reader -- ambiguous, and reported as no interest at all while the recorded amount sat in the split. A parent with no categorized line still falls back to a single uncategorized non-transfer line, which is how legacy splits recorded interest.

The writer's ambiguous case resolves differently from the reader's on purpose, and in the opposite direction to the one that looks safe. It rewrites the parent as principal + interest + extra, so it understands exactly that template shape; a template carrying an escrow, tax or insurance line would come out with a parent that no longer equals the sum of its children, and the posting path's exact-4dp split validator then refuses **every** occurrence -- the bill stops posting with the amount it would have charged nowhere on screen. So `ScheduledTransactionLoanService` **declines the recalculation and returns without writing** (logging which of the two reasons applied, and what to configure) whenever no line carries the loan's interest category or any line falls outside principal/interest/extra. The cost is a P/I split frozen at last period's figures; the alternative cost is a schedule that never posts again. Declining is also what removes the last place a line was chosen by *position* -- picking the first categorized line is what put an amortization figure onto a property-tax line. The reader, which only reports, returns `null` for the same ambiguity and lets a paired separate expense answer.

**Standalone interest is attributed by category + source account, which is not per-loan (`INV-LOAN-HISTORY-001`, `partial`).** `fetchLoanInterestTransactions` selects on exactly that pair and nothing on those rows names the loan, so two loans paid from one account and sharing one interest category absorb each other's interest -- and the setup default manufactures that state, because `LoanPaymentSetupService` falls back to the single user-level `Loan -> Loan Interest` category for every loan. Until a durable provenance link exists (the loan account, or the principal payment the interest belongs to, recorded on the transaction), a loan that books interest separately needs its **own** interest category, and any new surface reading standalone interest inherits the same limitation rather than working around it. Do not add a heuristic discriminator here: a date-and-amount guess would be the escrow-ordering defect again, one layer up.

`accounts.interestBookingMode` (`AUTO | SPLIT | SEPARATE`) is *not* that mechanism today -- it is persisted, offered in the account form and written by the MNY importer, but no reader branches on it, so it constrains nothing. Defining what it means for the historical reader, rate detection and scheduled posting needs a cross-layer truth table first; adding a branch on it without one would make a `SPLIT` loan silently stop counting interest it has always counted.

**In `lib/loan-history.ts` an empty list is a claim, so nothing in that module catches.** An empty `interestTransactions` is what tells the derivation "these payments booked no interest"; a `catch { return [] }` in `fetchLoanInterestTransactions` therefore turned a timeout into a confident Interest Paid of $0.00. Every failure propagates to a caller that owns an error-and-retry state -- `useReportData` in the three loan reports, `failedAccountId` in `useLoanProjection`, the page error on the account detail route. `lib/loan-history.guard.test.ts` fails on any `catch` reappearing in the module.

## A chart reduction is rendering; it never reaches a count, a total or an export

A long series is reduced before it can be drawn, and that reduction is the only
thing it is for. The Debt Payoff Timeline built **one** array -- payment events,
aggregated by month, then sampled down to about 60 points for the axis -- and
read "Payments Made" off it, so a loan with 300 payments reported 61 (issue
#1244). Keep the sets apart and name them apart: the full data every figure is
derived from, and the reduced series a chart is handed.

Which reduction depends on what the series *is*, and `lib/chart-sampling.ts`
holds both:

- **A stock** (a balance, a running total) has a value at a point in time, so
  `sampleStockSeries` draws every Nth point: resolution drops, and every point
  still drawn means exactly what it meant. Pass `keep` for the points that carry
  meaning beyond their value -- the last historical row and the first projected
  one, which the "Today" line and the area join sit on.
- **A flow** (what a period paid) only means anything over an interval, so
  dropping a point *deletes* the months it stood for and the chart shows a
  subset presented as the whole. `bucketFlowSeries` sums contiguous groups
  instead, and its `boundary` keeps a bucket from straddling the
  history/projection line -- one bar cannot honestly be half measured and half
  predicted.

**Monthly aggregation is the same mistake one step earlier: a month is not a
payment.** A biweekly loan makes 26 a year, extra principal payments are their
own events, and two payments in one month are two. The count is
`historicalPaymentCount(history)` (`lib/loan-history.ts`), read by both loan
reports so one loan cannot have two answers.

**Provenance is part of an aggregation's identity, never computed from its
members.** A weekly, biweekly or semi-monthly loan routinely has a real payment
and a projected one in the same calendar month. Grouped on the month alone and
then asked `group.every((item) => item.isProjected)`, August came out
*historical* while holding two thirds forecast principal and the projection's
end-of-month balance -- and when the loan paid off inside that month, no
projected row survived at all, so the "Today" divider and the Est. Payoff card
went with it. `bucketFlowSeries`'s `boundary` cannot repair that: by the time it
runs the two sides are one row. Group on the month *and* the side of the line,
over a date-ordered series and as contiguous runs, so a future-dated posted
payment landing among the projected rows opens its own run. And ask the
projection whether a projection exists -- not the buckets.

**A label is not an identity.** Two chart rows share one -- the month either
side of the line, and a bucketed flow row labelled as the span it covers --
while recharts keys its category axis, its tooltip lookup and every
`ReferenceLine` on the datum's own value. Give each row an `axisKey`
(`axisKeyFor` in `lib/chart-sampling.ts`: its position, then its label), key the
axis on that, and pass `axisTickLabel` as the `tickFormatter` so the tick still
reads "Aug 2026". Keyed on the label, the two rows collapse onto one category
and the divider lands on whichever came first.

**A marker drawn on a reduced series is keyed to that series.** A recharts
`ReferenceLine` whose value matches no axis category is silently not drawn, so
the Payment Distribution chart's "Today" divider comes from the first projected
*bucket's own axis key* -- the balance chart's key addresses a row of a
different series, and the divider disappears on exactly the long loans bucketing
exists for.

Assigning a reduced series back over its source (`points = points.filter(...)`)
is how this happens -- once the two are one variable, nothing downstream can
tell which it holds. So is renaming it on the way out
(`return { points: chartPoints }`), which hands a caller the reduced series
under the full one's name. `lib/chart-reduction.guard.test.ts` scans for a count
taken by filtering a schedule on `isProjected`, for both reports reading the
shared count, and for any reduced series -- or any name one is aliased to in the
same file -- being *measured* (`.length`, `.reduce`, `.filter`, `.some`,
`.every`, `.forEach`); a `.find` for the row a tooltip hovers is allowed,
because a lookup cannot aggregate. It also scans for a group's provenance
derived from its members (`.every(... isProjected ...)`) and pins the Debt
Payoff Timeline's three axes to `dataKey="axisKey"`. INV-REPORT-002.

## An unknown value must not render as a measured zero

The server sends `null` rather than `0` for anything it could not work out (`docs/financial-calculation-contract.md`), and the last hundred pixels are where that gets thrown away:

- **`connectNulls` on a line chart** draws a measured-looking segment through the gap. Default to `connectNulls={false}`.
- **A bar, gauge or meter at zero width** beside an "unknown" label reads as a measured zero. Draw a distinct no-data treatment, or nothing.
- **A row that disappears** when its value is `null` conflates "not applicable" with "could not be computed" -- where the payload can tell them apart, render the row with an unknown marker.
- **`?? 0`, `|| 0`, `?? 1` on an API value** is the same mistake in arithmetic form. Guard with an `isKnown()`-style check first.

Whoever adds the `null` on the server owns how it looks; a component test asserting the gap, marker or absent fill is what keeps it.

**A missing exchange rate is the same class.** `useExchangeRates().convert` / `convertToDefault` / `convertWithRateMap` return `number | null`; they previously returned the amount *unconverted*, so a 100.00 USD balance with no rate was formatted as "100.00 EUR" and summed into Net Worth. Pick the treatment from what the figure is:

- **An aggregate** uses `sumConverted` / `combineTotals` (`lib/currency-total.ts`), which keep the subtotal and the missing currencies together, rendered through `PartialTotal`. Incompleteness is a union: net worth built from a complete asset total and a partial liability total is partial.
- **A single displayed value** shows an unknown marker, or nothing. Never the unconverted number beside the target currency's symbol.
- **A chart series** uses `null` and `connectNulls={false}`; a bar, slice or gauge cannot say "unknown", so an unconvertible component leaves the chart.
- **A cumulative series** (a running balance, a forecast) is withheld whole: one missing rate invalidates every point after it, so `buildForecast` returns no points and names the currencies; `buildMultiAccountForecast` withholds every line and the total together.
- **A summary over a series** (`computeBalanceSummary`) refuses when any point is unknown -- "minimum" and "goes negative" are claims about all of it.

Same currency is 1:1 *by definition* and stays a known conversion -- keep it distinguishable from the missing case, and keep a real zero rendering as a number.

**And a rate table that has not loaded is not a table missing that rate.** `useExchangeRates` starts with no rates and keeps none if the fetch fails, so every cross-currency `convert` returns `null` in both states: a surface that names the missing pair then instructs the reader to add a rate that already exists. Check `ratesUnavailable` (loading or failed) before naming any pair; `ratesFailed` tells an outage from a table still arriving. The reporting currency itself comes from `preferredCurrency` (`lib/default-currency.ts`) -- never a hand-written `|| 'CAD'`, which is how ten call sites came to disagree with each other and with the server.

**Where more than one thing can withhold a figure, the reader is told about all of them.** The bills page's Monthly Net can be incomplete because a schedule could not be priced *and* because a currency has no rate; naming one makes the reader fix it and watch nothing change. Compose the causes, do not pick between them.

## Withholding a figure is only honest if the reader learns why

A cumulative series with one unpriceable occurrence is withheld whole -- but a blank forward line is indistinguishable from "nothing scheduled". `BalanceForecastResult.gaps` names the schedule, the currency pair and the cause, and `BalanceForecastUnavailable` renders the fix (refresh rates on Currencies; check the security's and settlement account's currency). A `null` with no explanation is a dead end, not a correction.
