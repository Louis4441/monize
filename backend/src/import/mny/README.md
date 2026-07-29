# Microsoft Money (`.mny`) import

Native TypeScript pipeline for importing complete Microsoft Money files. Design and task list:
`docs/future-plans/mny-import.md`.

```
.mny upload -> msisam/msisam-decrypt.ts -> mdb-reader -> msisam/open-mny.ts
  -> tables/*.ts (tolerant row readers) -> map/*.ts (pure functions)
  -> writer (withScopedDb) -> verification report
```

Implemented so far: the decrypt, reader, table and coded-value layers (Phase 0, tasks M0.1–M0.4
and M0.6).

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
  message ever contains the file password.

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
