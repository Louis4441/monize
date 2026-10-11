# Spec: one security per bond program

Status: requested by the owner on 2026-10-11 (WMP/monize#24): "one security =
the bond type (EDO)", the treasury bonds view under Securities. Supersedes the
one-security-per-series link of `polish-retail-bonds.md` section 12.1 before
it ships.

## 1. Goal

A person who buys EDO every month holds one security, "EDO", not one per
series. Adding the security is choosing the program (the product, e.g. EDO);
recording a purchase is choosing the series (prefilled from the date). The
security page summarises the whole program, with the series the person holds
first and most prominent. An optional switch on the security asks Monize to
fetch every new series of the program automatically.

## 2. Model

### 2.1 Program

`bond_programs` (global reference data, RLS-exempt, immutable like
`bond_instruments`): `id` (UUIDv5 of `issuerCountryCode|issuerCode|programCode`,
deterministic like the instrument id), `issuer_country_code`, `issuer_code`,
`program_code`, `currency_code`. `bond_instruments.bond_program_id` references
it (NOT NULL). The catalog seed and a series fetch insert the program in the
same transaction as its first instrument (`INSERT ... ON CONFLICT DO NOTHING`).

### 2.2 Security

`securities.bond_program_id` (nullable, `ON DELETE RESTRICT`) replaces
`securities.bond_instrument_id`. `securities.bond_auto_fetch BOOLEAN NOT NULL
DEFAULT false`. The link is checked in the write's transaction exactly as the
series link was (`assertBondLink`): the program exists, the security's type is
`BOND`, its currency equals the program's currency, and every share-moving
transaction's price is within [0.5, 2] x the face value of its series. The
unmerged migrations of this PR are rewritten in place (no release carried
`bond_instrument_id` on `securities`); a database that applied the earlier
version is rebuilt (demo only).

### 2.3 Transaction series

`investment_transactions.bond_instrument_id` (nullable, `ON DELETE RESTRICT`):
the series a share-moving row of a program-linked security acts on.

- **Acquisition** (`BUY`, `REINVEST`, `ADD_SHARES`, an unpaired
  `TRANSFER_IN`): the series is the one given, or, when none is given, the
  program's series whose stored `saleWindow` contains the transaction date
  (exactly one exists for a Polish program). The server stores the resolved id.
  A given series must belong to the security's program (`SERIES_NOT_IN_PROGRAM`);
  no stored series covering the date is `SERIES_NOT_DETERMINED` with the date
  and program, and the message says to fetch the series. Both refusals run in
  the write's own transaction, before anything is written.
- **Removal** (`SELL`, `REDEEM`, `REMOVE_SHARES`, an unpaired `TRANSFER_OUT`):
  the series is optional. Given, the quantity leaves that series' lots of the
  row's account first-in first-out; absent, it leaves the account's lots
  first-in first-out across series. A given series the account does not hold
  enough of makes the lots unknown (`REMOVAL_EXCEEDS_SERIES`), as an
  over-removal does today.
- **Paired transfers** move lots with their series and purchase dates.
- Every write path sets it the same way: the UI service, bulk, AI action, MCP,
  import, undo/redo (the snapshot carries the column).

A security that is not program-linked never has the column set (refused).

### 2.4 Lots, valuation, prices

A lot is `{ accountId, instrumentId, purchaseDate, quantity, purchaseDateAssumed }`.
The valuation loads the reference data of every series the lots name (once
each) and values each lot by its own series' terms; totals are summed as
today. The daily `bond_engine` price is the blend over all lots of all series,
as today over accounts. Scenarios assume a benchmark for every series that
reads it; a series that does not read it is unchanged.

### 2.5 Auto-fetch

`bond_auto_fetch` is per security, off by default, on a switch on the security
page and in the form. The daily series cron fetches the current offer and runs
the backfill only for the programs that at least one security has switched
on (read in the cron's system context; it reads program ids, never anything
else of the user). Without it, a series enters the catalog by the curated
seed, by a fetch from the purchase form, or by the "fetch the current offer
now" action of the bonds view (user-initiated, throttled like the series
fetch).

## 3. Views

### 3.1 Treasury bonds view

Moves from `/investments/bonds` to `/securities/bonds`, reached from the
Securities page header ("Treasury bonds"); the Investments header button is
removed and its links point to the new route. It gains the "fetch the current
offer now" action.

### 3.2 Security form

Type `BOND` shows a program picker (the catalog's programs, by translated
name, e.g. "EDO: 10-year inflation-indexed savings bonds") instead of the
series picker. Choosing it fills symbol (`EDO`), name and currency, and shows
the auto-fetch switch.

### 3.3 Transaction form

For a program-linked security, a share-moving action shows a series picker:
for an acquisition it is prefilled with the series on sale on the transaction
date and offers the program's stored series; if none covers the date it offers
"fetch the series from the official source" (the existing fetch). For a
removal it lists the series the account holds, with "oldest first" as the
default.

### 3.4 Security page

For a program-linked security, from top:

1. **Your series** (most prominent): one row per held series with quantity,
   purchase dates, current value, accrued interest, early redemption value,
   current rate and next rate change, and its maturity; totals for the
   program. A row expands to the existing per-lot detail (rate schedule,
   indexation notice, interest chart, scenarios).
2. **The program**: rate rule in words, length, capitalization, current fee
   and floor, the auto-fetch switch.
3. **On sale now** for this program (from `GET /bonds/offer`), with the
   comparison figures.
4. **History** of the program's terms (from `GET /bonds/history`), the series
   held marked on the chart and highlighted in the table.

## 4. API changes

- `GET /bonds/programs`: the catalog's programs (id, country, issuer, program
  code, currency, series count, newest series).
- Valuation response: each lot carries `instrumentId` and `seriesCode`;
  `termsSource` and `redemptionTerms` move per series
  (`series: [{ instrumentId, seriesCode, termsSource, redemptionTerms }]`).
- Investment transaction DTOs gain optional `bondInstrumentId` (UUID,
  `ParseUUIDPipe` semantics); responses carry it.
- `POST /bonds/offer/fetch` `{ countryCode }`: fetch every series of the current
  offer that is not stored (throttled, 2 a minute per user).
- Security DTOs: `bondProgramId` and `bondAutoFetch` replace `bondInstrumentId`.

## 5. Invariants

- INV-BOND-005 unchanged in meaning (engine price per security, now blended
  over series).
- INV-BOND-007 (new): every share-moving row of a program-linked security
  names a series of that program; an acquisition's series is resolved and
  stored by the server, never trusted from a client without the program check.

## 6. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| Migration | schema | `verify-schema.sh` no-op; programs and both columns present; FKs RESTRICT; immutability trigger on programs |
| Link | unit, integration | program link checks (exists, BOND, currency, price range across series); auto-fetch default false |
| Series on write | unit, integration | acquisition inferred from the date, explicit accepted, foreign program refused, no series refused before writing; removal with and without series; every entry point (UI service, bulk, AI, MCP, import, undo) |
| Lots | unit | two series in one account; removal by series; FIFO across series; paired transfer keeps series; over-removal of a series |
| Valuation, prices | unit, integration | two series valued by their own terms; blend; scenarios per series; recompute after a write |
| Auto-fetch | unit | cron fetches only programs switched on; off by default |
| Views | unit | program picker; series picker prefill and fetch; security page order and highlight; route move |
