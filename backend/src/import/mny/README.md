# Microsoft Money (`.mny`) import

Native TypeScript pipeline for importing complete Microsoft Money files. Design and task list:
`docs/future-plans/mny-import.md`.

```
.mny upload -> msisam/msisam-decrypt.ts -> mdb-reader -> msisam/open-mny.ts
  -> tables/*.ts (tolerant row readers) -> map/*.ts (pure functions)
  -> writer (withScopedDb) -> verification report
```

Implemented so far: the whole pipeline through Phase 3 -- decrypt, readers, mappers, writers, the
background job and the wizard. Banking data, investments, scheduled bills and inferred loan terms
all import; what remains is Phase 4 hardening (see the design's task list).

## Coded values

`model/mny-model.ts` holds every Money code and its Monize equivalent -- account types, cleared
status and the `grftt` flag bits, investment actions, category classification, recurrence
frequencies. Each constant is labelled **confirmed** (asserted against the fixtures in
`mny-model.spec.ts`) or **unconfirmed** (carried from the format reference). An unconfirmed code
that turns up in a real file must become a warning in the verification report, never a silent
mapping: `mapAccountType`, `mapInvestmentAction` and `mapFrequency` all return null for codes they
do not know, and `MNY_UNCONFIRMED_ACTIONS` names the ones whose meaning is inferred.

## Reading tables

`readMnyTables(db)` (`tables/read-mny-tables.ts`) is the last layer that knows about Jet; mappers
take its `MnyTables` and never touch `mdb-reader`. Each reader is a declarative spec: a field
names the Money column (or columns, newest-first) it comes from plus a converter from
`model/mny-values.ts`. Field names are descriptive and `model/mny-rows.ts` documents the Money
column behind each one, so it doubles as the translation table for the format reference.

A missing table yields zero rows; a missing column yields the converter's default. Both are
reported in `TableAvailability` (`missingTables` / `missingFields`) so the wizard can say "this
file has no scheduled bills" instead of failing.

## Inspecting a real file

```bash
npm run mny:inspect -- path/to/file.mny [--password secret] [--table TRN] [--rows 5]
```

Prints the encryption scheme, whether a password was needed, every table with its row and column
counts, and a summary of what the readers made of the file -- base currency, entity counts, and
any table or field this Money version could not supply. Run it against a real Money Plus Sunset
file before trusting anything downstream; a table that fails to read is reported inline rather
than aborting the report.

It also ends with a `performance:` block -- stage timings and peak RSS as a multiple of file
size. That, and the `.mny import timing:` line a real import logs, are where the design's
acceptance numbers come from: they can only be measured on a 200 MB file that will never be
committed here, so the pipeline measures itself and the run is what gets recorded.

## Memory

An upload is buffered whole and decrypted in place, so peak usage is roughly **twice the file
size** above baseline. `MNY_IMPORT_LIMIT_MB` (default 300) bounds it; the pod needs at least
`2x` that plus headroom, which the default Helm limit of `150Mi` is nowhere near. A pod that hits
its limit mid-import is OOM-killed and the wizard reports a *stalled job*, naming the symptom and
not the cause -- see `helm/README.md` for the sizing table.

## Layering rules

- **Mappers never touch the database; the writer never parses.** Only the layers in `msisam/`
  need real `.mny` bytes -- everything above them is unit-tested against plain objects, which is
  what keeps the backend coverage gates reachable.
- **Never call `mdb-reader` directly.** `openMnyFile` is the only door. Money's table and column
  set changed across releases (Money 2001 has no `BILL` table at all), so reads go through
  `getTableOrNull` and `MnyTable.rows(columns)`, which drop absent tables and columns instead of
  throwing.
- **Every failure is an `MnyImportError` with a stable `code`** (`mny-errors.ts`). The controller
  maps the code to an i18n key; nothing below the controller formats user-facing text, and no
  message ever contains the file password. An untyped error escaping this layer is a defect
  twice over: the wizard gets a 500 with nothing to branch on, and a running job records the
  failure as *retryable*, offering Try again on a file that can never import.
- **Progress goes through `throttleProgress`, never straight from a chunk loop.** Each report
  escapes the import transaction by design, so it costs a second pool connection while the long
  transaction is open -- and the wizard only polls every 1500 ms, so a report per 500-row chunk
  writes a hundred-odd updates nobody reads.

## Traps

- **Page 0 is obfuscated.** Jet XORs bytes `0x18..0x95` of the header page with a fixed mask. The
  crypto salt at `0x72` is inside that window. Reading it from the raw file produces a key that
  decrypts everything to garbage with no error until the reader reports a wrong page type. Use
  `demaskHeaderPage`/`readMnyFileHeader` (`msisam/jet-header.ts`); never index raw page-0 bytes.
- **Non-blank crypt-check bytes do not mean the file has a password.** Money Plus writes them for
  unprotected files too, and they verify against the blank password. "Protected" means the blank
  password fails.
- **`decryptMsisamInPlace` takes ownership of its buffer.** It mutates and returns the same
  buffer, deliberately (ADR-6). Tests must read a fresh fixture per assertion --
  `readMnyFixture` does that.
- **Decrypt each buffer exactly once; RC4 is symmetric.** A second pass re-encrypts pages
  1..0xE, and the only symptom is `MnyUnreadableDatabaseError` from a layer that looks
  unrelated. Staged bytes are stored *decrypted* so the password is spent on the parse request
  and never persisted (ADR-2, ADR-7), so anything re-reading them uses `openDecryptedMnyFile`
  (or `parse({ alreadyDecrypted: true })`), never `openMnyFile`. This shipped broken through
  three phases because **every test staged raw fixture bytes** -- making the job's decrypt the
  only decrypt -- while the wizard's real upload-then-import path decrypted twice. A test that
  stages anything other than what `POST /parse` stages is not testing the import.
- **Money 2001 files use a different key derivation** ("old" scheme, flags bit `0x6` clear) that
  uses no password at all. Both schemes must keep working; the fixtures cover each.
- **`TRN` holds the payee in `lHpay` on Money Plus and `hpay` before it.** Reading one name only
  drops every payee on the other vintage. Column aliases belong in the reader spec, never in a
  mapper.
- **`SEC_SPLIT` has no security column.** Resolve it through `MnyInvestmentData.splitSecurities`,
  which is built from `SP.hss` -> `SP.hsec`.
- **"No date" is year 10000, not a two-digit-year pivot.** `toDate` returns null outside
  1900–2199; never parse Money dates by hand.
- **`act` 16 removes shares; it is not a sale.** Mapping it to SELL closes lots against a
  fabricated price and corrupts average cost. Direction always comes from `act` -- `TRN_INV.qty`
  is stored positive, so a quantity sign proves nothing.
- **`act` 4 (cash dividend) has no `TRN_INV` row.** Drive the investment mapper from `TRN`;
  iterating `TRN_INV` drops every dividend.
- **`SEC.sct` codes shift between releases** (the same index securities are `sct` 6 in Money
  2001/2002 and `sct` 7 in Money Plus), so the `sct = 4` currency test is not enough on its own.
  Use `isCurrencyPseudoSecurity`, which also matches the version-independent `/GBPUS` symbol
  shape.
- **`CAT.lType` says income or expense directly** -- `{2, 3}` income, `{0, 1}` expense, `-1` the
  two roots. Use `isIncomeCategoryType` and fall back to the root ancestor only for the roots.
- **`BILL` is an accumulation of instances, not a list of bills.** One row per occurrence, so a
  long history holds thousands (1,844 in the maintainer's file for ~20 real bills). Group by
  `hbillHead` and reduce each series to one representative before doing anything else.
- **Nothing filters on `BILL.st`.** No fixture has ever contained a `BILL` row, so no value of it
  has been observed. `mapBills` carries the raw value on every candidate and `mny:inspect` prints
  its distribution; adding an `st` filter needs a real file first, not a plausible constant.
- **An absent `options.bills` means "every candidate"; an empty list means "none".** They are
  different requests, and the wizard always sends the field explicitly so unticking every bill
  does not read as saying nothing.
- **An unticked bill is never written, not written inactive.** PR #192 created all 1,844 and
  bulk-deactivated the rest, which left the user a list to clean by hand.
- **A loan's interest category is only inferred when the payments name exactly one non-principal
  category.** Interest and escrow are both category legs and the file does not distinguish them,
  so two or more legs means the field stays null with a warning. Putting escrow into
  `interest_category_id` would make `RateChangeInferenceService` infer every rate from the wrong
  leg.
