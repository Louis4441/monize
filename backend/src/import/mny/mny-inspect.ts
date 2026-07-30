/**
 * Smoke harness for the `.mny` decrypt + reader layers.
 *
 *   npm run mny:inspect -- path/to/file.mny [--password secret] [--table TRN]
 *
 * Prints what the reader can see: encryption scheme, table list with row and
 * column counts, a summary of what the table readers made of the file, what the
 * mappers make of it (accounts, transaction counts, per-account final balances,
 * warnings), and optionally the first rows of one table. Its job is to prove
 * that a real-world file -- a 200 MB Money Plus Sunset file, a Money 2001 file
 * -- decrypts, reads and maps to sane numbers before an import is attempted.
 *
 * Per-account balances and per-security holdings are the mappers' own output, so
 * they are the same numbers the verification report reconciles against. That
 * makes this the validation harness task M0.5 asked for, now complete: a
 * per-account or per-holding discrepancy can be traced against a real file
 * without importing anything.
 */
import { MnyImportError } from "./mny-errors";
import { currencyCodesByHandle, mapAccounts } from "./map/map-reference";
import { mapTransactions } from "./map/map-transactions";
import { mapSecurities } from "./map/map-securities";
import { mapInvestments } from "./map/map-investments";
import { crossCheckHoldings } from "./map/check-holdings";
import { computeExpectedBalances, todayIsoDate } from "./mny-parser.service";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "./model/mny-import-options";
import { summarizeWarnings } from "./model/mny-warnings";
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

/**
 * What the mappers make of the file: which Monize accounts it produces, how many
 * transactions land in each, and each account's final balance computed from the
 * file. These are the numbers the verification report reconciles against, so
 * running this against a real file is how a per-account discrepancy gets traced
 * before an import is ever attempted (task M0.5).
 *
 * The holdings block is the trust-builder for investments: Money's open tax lots
 * against the mapper's own action replay, per account and security. A file where
 * those two disagree is one where an action code is being read wrong, and this
 * says which security to look at.
 */
export function mappingSummary(tables: MnyTables): string[] {
  const accounts = mapAccounts(
    tables.reference,
    DEFAULT_MNY_IMPORT_OPTIONS,
    "USD",
  );
  const transactions = mapTransactions({
    transactions: tables.transactions,
    accountKeyByHandle: accounts.keyByHandle,
    currencyByHandle: accounts.currencyByHandle,
    bills: tables.bills.bills,
  });
  const securities = mapSecurities({
    securities: tables.investments.securities,
    currencyByHandle: currencyCodesByHandle(tables.reference),
    baseCurrency: accounts.baseCurrency,
  });
  const investments = mapInvestments({
    transactions: tables.transactions,
    investments: tables.investments,
    accounts,
    securities,
    bills: tables.bills.bills,
  });
  const holdings = crossCheckHoldings({
    transactions: investments.transactions,
    lots: tables.investments.lots,
    accounts,
    securities,
  });
  const balances = computeExpectedBalances(
    accounts,
    transactions,
    todayIsoDate(),
    investments,
  );

  const counts = new Map<string, number>();
  for (const transaction of transactions.transactions) {
    counts.set(
      transaction.accountKey,
      (counts.get(transaction.accountKey) ?? 0) + 1,
    );
  }
  const nameByKey = new Map(
    accounts.accounts.map((account) => [account.key, account.name]),
  );

  return [
    "mapped import:",
    `  base currency:   ${accounts.baseCurrency}`,
    `  accounts:        ${accounts.accounts.length} (${accounts.skipped} skipped)`,
    `  transactions:    ${transactions.transactions.length} (${transactions.transfersLinked} transfers linked, ${transactions.skipped} skipped)`,
    `  securities:      ${securities.securities.length} (${securities.skipped} skipped as currencies or unusable)`,
    `  investments:     ${investments.transactions.length} (${investments.transfersPaired} share transfers paired, ${investments.splitsApplied} stock splits, ${investments.skipped} skipped)`,
    "",
    "  account                                    ccy   txns        opening          final",
    ...accounts.accounts.map((account) =>
      [
        `  ${account.name.slice(0, 40).padEnd(40)}`,
        account.currencyCode.padEnd(5),
        String(counts.get(account.key) ?? 0).padStart(5),
        account.openingBalance.toFixed(2).padStart(15),
        (balances.get(account.key) ?? 0).toFixed(2).padStart(15),
      ].join(" "),
    ),
    ...(holdings.checks.length > 0
      ? [
          "",
          "  holdings (open lots vs action replay):",
          "  account                        symbol            lots          replay  ",
          ...holdings.checks.map((check) =>
            [
              `  ${(nameByKey.get(check.accountKey) ?? check.accountKey).slice(0, 28).padEnd(28)}`,
              check.symbol.padEnd(10),
              check.lotQuantity.toFixed(4).padStart(15),
              check.replayQuantity.toFixed(4).padStart(15),
              check.matches ? "  ok" : "  MISMATCH",
            ].join(" "),
          ),
        ]
      : []),
    "",
    "  warnings:",
    ...summarizeWarnings([
      ...accounts.warnings,
      ...transactions.warnings,
      ...securities.warnings,
      ...investments.warnings,
      ...holdings.warnings,
    ]).map(
      (warning) =>
        `    ${warning.code.padEnd(32)} ${String(warning.count).padStart(6)}  ${warning.samples.join(", ")}`,
    ),
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
    const tables = readMnyTables(db);
    lines.push("", ...summarise(tables), "", ...mappingSummary(tables));
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
