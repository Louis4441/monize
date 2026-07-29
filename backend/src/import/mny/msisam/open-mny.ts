import MDBReader from "mdb-reader";
import type { Value } from "mdb-reader";

import { MnyUnreadableDatabaseError } from "../mny-errors";
import { MsisamEncryptionScheme } from "./jet-header";
import { decryptMsisamInPlace } from "./msisam-decrypt";

/**
 * Opens a decrypted `.mny` file with `mdb-reader` and exposes it through a
 * tolerant façade.
 *
 * Money's table and column set changed across releases -- Money 2001 has no
 * `BILL` table at all, which is what crash-looped the PR #192 proof of concept.
 * Nothing above this layer may call `getTable` directly: reads go through
 * `getTableOrNull` and `MnyTable.rows`, which silently drops columns the file
 * does not have instead of throwing.
 *
 * `mdb-reader` is ESM-only. TypeScript's `nodenext` module resolution emits a
 * `require()` for it, which Node 22 resolves natively, and Jest transforms it
 * to CommonJS via the `transformIgnorePatterns` allowlist the repo already
 * uses for `openid-client` and friends. That is why the reader is a plain
 * dependency here rather than the vendored copy the design document proposed.
 */

export type MnyValue = Value;
export type MnyRow = Record<string, MnyValue>;

export interface MnyTable {
  /** Table name as stored in the Money file, e.g. "TRN". */
  readonly name: string;
  /** Number of rows the table holds. */
  readonly rowCount: number;
  /** Every column name present in this file's version of the table. */
  readonly columnNames: readonly string[];
  /** True when this file's version of the table has the given column. */
  hasColumn(column: string): boolean;
  /**
   * Reads rows, keeping only the requested columns that actually exist.
   * Reading all columns (no argument) is the tolerant default.
   */
  rows(columns?: readonly string[]): MnyRow[];
}

export interface MnyDatabase {
  /** Key-derivation scheme the source file used. */
  readonly scheme: MsisamEncryptionScheme;
  /** True when a non-blank password was needed to open the file. */
  readonly passwordProtected: boolean;
  /** Every user table present in the file, in file order. */
  readonly tableNames: readonly string[];
  /** True when the file has the named table. */
  hasTable(name: string): boolean;
  /** The named table, or null when this Money version does not have it. */
  getTableOrNull(name: string): MnyTable | null;
}

function wrapTable(reader: MDBReader, name: string): MnyTable {
  const table = reader.getTable(name);
  const columnNames = table.getColumnNames();
  const present = new Set(columnNames);

  return {
    name,
    rowCount: table.rowCount,
    columnNames,
    hasColumn: (column) => present.has(column),
    rows: (columns) => {
      const requested = columns?.filter((column) => present.has(column));
      if (requested !== undefined && requested.length === 0) {
        // Asking mdb-reader for an empty column list returns empty objects;
        // returning one per row keeps row counts meaningful for callers.
        return Array.from({ length: table.rowCount }, () => ({}) as MnyRow);
      }
      return table.getData<MnyRow>(
        requested === undefined ? undefined : { columns: requested },
      );
    },
  };
}

/**
 * Decrypts and opens a `.mny` file.
 *
 * `buffer` is decrypted in place, so the caller must hand over ownership (see
 * `decryptMsisamInPlace`). Tables are materialised lazily -- `getTableOrNull`
 * reads a table's definition on first call, so a 200 MB file never has more
 * than one table resident at a time.
 *
 * @throws MnyImportError subclasses for unsupported, truncated, password
 *   protected or unparseable files
 */
export function openMnyFile(buffer: Buffer, password?: string): MnyDatabase {
  const { scheme, passwordProtected } = decryptMsisamInPlace(buffer, password);

  let reader: MDBReader;
  let tableNames: string[];
  try {
    reader = new MDBReader(buffer);
    tableNames = reader.getTableNames();
  } catch (error) {
    throw new MnyUnreadableDatabaseError(error);
  }

  const present = new Set(tableNames);
  const cache = new Map<string, MnyTable>();

  return {
    scheme,
    passwordProtected,
    tableNames,
    hasTable: (name) => present.has(name),
    getTableOrNull: (name) => {
      if (!present.has(name)) {
        return null;
      }
      const cached = cache.get(name);
      if (cached) {
        return cached;
      }
      try {
        const table = wrapTable(reader, name);
        cache.set(name, table);
        return table;
      } catch (error) {
        throw new MnyUnreadableDatabaseError(error);
      }
    },
  };
}
