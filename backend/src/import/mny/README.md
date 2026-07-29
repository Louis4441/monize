# Microsoft Money (`.mny`) import

Native TypeScript pipeline for importing complete Microsoft Money files. Design and task list:
`docs/future-plans/mny-import.md`.

```
.mny upload -> msisam/msisam-decrypt.ts -> mdb-reader -> msisam/open-mny.ts
  -> tables/*.ts (tolerant row readers) -> map/*.ts (pure functions)
  -> writer (withScopedDb) -> verification report
```

Implemented so far: the decrypt, reader and table layers (Phase 0, tasks M0.1–M0.4).

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
