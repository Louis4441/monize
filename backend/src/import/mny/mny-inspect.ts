/**
 * Smoke harness for the `.mny` decrypt + reader layers.
 *
 *   npm run mny:inspect -- path/to/file.mny [--password secret] [--table TRN]
 *
 * Prints what the reader can see: encryption scheme, table list with row and
 * column counts, a summary of what the table readers made of the file, and
 * optionally the first rows of one table. Its job is to prove that a
 * real-world file -- a 200 MB Money Plus Sunset file, a Money 2001 file --
 * decrypts and reads before any mapping work depends on it.
 *
 * This is not the full validation CLI from task M0.5: per-account balances and
 * holdings need the mappers, which do not exist yet.
 */
import { MnyImportError } from "./mny-errors";
import { openMnyFile } from "./msisam/open-mny";
import {
  MnyTables,
  missingFields,
  missingTables,
  readMnyTables,
} from "./tables/read-mny-tables";

interface InspectOptions {
  file: string;
  password?: string;
  table?: string;
  rows: number;
}

export function parseInspectArgs(argv: readonly string[]): InspectOptions {
  const positional: string[] = [];
  let password: string | undefined;
  let table: string | undefined;
  let rows = 5;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--password":
        password = argv[++i];
        break;
      case "--table":
        table = argv[++i];
        break;
      case "--rows":
        rows = Number(argv[++i]);
        break;
      default:
        positional.push(argv[i]);
    }
  }

  if (positional.length !== 1) {
    throw new Error(
      "usage: mny:inspect -- <file.mny> [--password <password>] [--table <NAME>] [--rows <n>]",
    );
  }
  return { file: positional[0], password, table, rows };
}

/**
 * Summarises what the table readers made of the file: the counts a preview
 * will show, plus anything this Money version could not supply.
 */
export function summarise(tables: MnyTables): string[] {
  const { reference, transactions, investments, bills } = tables;
  const baseCurrency = reference.currencies.find(
    (currency) => currency.handle === reference.defaults?.defaultCurrency,
  );
  const absentTables = missingTables(tables);
  const defaulted = missingFields(tables);

  return [
    "summary:",
    `  base currency:   ${baseCurrency ? `${baseCurrency.isoCode} (${baseCurrency.name})` : "unknown"}`,
    `  accounts:        ${reference.accounts.length}`,
    `  payees:          ${reference.payees.length}`,
    `  categories:      ${reference.categories.length}`,
    `  currencies:      ${reference.currencies.length} (${reference.exchangeRates.length} exchange rates)`,
    `  transactions:    ${transactions.transactions.length} (${transactions.splits.length} split children, ${transactions.transfers.length} transfer pairs)`,
    `  securities:      ${investments.securities.length} (${investments.prices.length} prices, ${investments.securitySplits.length} stock splits, ${investments.lots.length} lots)`,
    `  bills:           ${bills.supported ? String(bills.bills.length) : "not supported by this Money version"}`,
    `  missing tables:  ${absentTables.length > 0 ? absentTables.join(", ") : "none"}`,
    `  defaulted fields:${defaulted.length > 0 ? ` ${defaulted.join(", ")}` : " none"}`,
  ];
}

/** Formats the report as lines so the shape is testable without stdout capture. */
export function inspect(
  buffer: Buffer,
  options: Omit<InspectOptions, "file">,
): string[] {
  const started = Date.now();
  const db = openMnyFile(buffer, options.password);
  const lines = [
    `encryption:        ${db.scheme}`,
    `password required: ${db.passwordProtected ? "yes" : "no"}`,
    `tables:            ${db.tableNames.length}`,
    "",
  ];

  for (const name of db.tableNames) {
    try {
      // Names come from the catalogue, so the table is present by definition;
      // it can still fail to read if its definition page is damaged.
      const table = db.getTableOrNull(name)!;
      lines.push(
        `  ${name.padEnd(28)} ${String(table.rowCount).padStart(8)} rows  ${table.columnNames.length} cols`,
      );
    } catch (error) {
      // One damaged table must not hide the rest of the report -- knowing
      // which table is broken is the point of running this.
      lines.push(
        `  ${name.padEnd(28)} unreadable: ${(error as Error).message}`,
      );
    }
  }

  try {
    lines.push("", ...summarise(readMnyTables(db)));
  } catch (error) {
    // A damaged table stops the readers but not the report: the table list
    // above is what tells you which one to look at.
    lines.push("", `summary unavailable: ${(error as Error).message}`);
  }

  if (options.table) {
    const table = db.getTableOrNull(options.table);
    lines.push("", `first rows of ${options.table}:`);
    if (!table) {
      lines.push("  (table not present in this Money version)");
    } else {
      for (const row of table.rows().slice(0, options.rows)) {
        lines.push(`  ${JSON.stringify(row)}`);
      }
    }
  }

  lines.push("", `read in ${Date.now() - started} ms`);
  return lines;
}

/* istanbul ignore next -- CLI entry point, exercised by hand against real files */
async function main(): Promise<void> {
  const { readFile } = await import("fs/promises");
  const options = parseInspectArgs(process.argv.slice(2));
  const buffer = await readFile(options.file);

  try {
    for (const line of inspect(buffer, options)) {
      process.stdout.write(`${line}\n`);
    }
  } catch (error) {
    if (error instanceof MnyImportError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

/* istanbul ignore next -- only runs when invoked as a script */
if (require.main === module) {
  void main();
}
