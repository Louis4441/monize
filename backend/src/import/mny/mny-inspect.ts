/**
 * Smoke harness for the `.mny` decrypt + reader layers.
 *
 *   npm run mny:inspect -- path/to/file.mny [--password secret] [--table TRN]
 *
 * Prints what the reader can see: encryption scheme, table list with row and
 * column counts, and optionally the first rows of one table. Its job is to
 * prove that a real-world file -- a 200 MB Money Plus Sunset file, a Money
 * 2001 file -- decrypts and parses before any mapping work depends on it.
 *
 * This is not the full validation CLI from task M0.5: per-account balances and
 * holdings need the table readers and mappers that do not exist yet.
 */
import { MnyImportError } from "./mny-errors";
import { openMnyFile } from "./msisam/open-mny";

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
