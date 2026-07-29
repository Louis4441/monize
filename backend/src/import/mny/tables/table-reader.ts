import { MnyDatabase, MnyRow, MnyTable, MnyValue } from "../msisam/open-mny";

/**
 * Spec-driven, version-tolerant table reading.
 *
 * Money's schema drifted across releases: `TRN` carries the payee in `hpay`
 * through Money 2002 and in `lHpay` from Money Plus, `BILL` does not exist
 * before Money 2002, and Money Plus added dozens of columns. A reader states
 * which column (or columns, in preference order) feeds each field and how to
 * convert it; anything the file does not have simply reads as null and the
 * converter supplies its default. Nothing throws for a missing table or
 * column.
 */

/** How one output field is read from a Money table. */
export interface ColumnSpec<TValue> {
  /**
   * Money column name, or names to try in order. The first name the file
   * actually has wins, so version aliases are declared newest-first.
   */
  readonly from: string | readonly string[];
  /** Converts the raw value. Receives null when no listed column exists. */
  readonly as: (value: MnyValue) => TValue;
}

/** A full row spec: one `ColumnSpec` per field of `TRow`. */
export type RowSpec<TRow> = {
  readonly [Field in keyof TRow]-?: ColumnSpec<TRow[Field]>;
};

/** What a file did and did not supply for one table. */
export interface TableAvailability {
  readonly table: string;
  /** False when this Money version has no such table at all. */
  readonly present: boolean;
  /** Rows read, or 0 when the table is absent. */
  readonly rowCount: number;
  /**
   * Fields whose declared columns are all missing from this file. They took
   * their converter's default; the preview surfaces them as notices.
   */
  readonly missingFields: readonly string[];
  /** For each field, the column name actually used. */
  readonly resolvedColumns: Readonly<Record<string, string | null>>;
}

export interface TableReadResult<TRow> {
  readonly rows: TRow[];
  readonly availability: TableAvailability;
}

function columnCandidates(spec: ColumnSpec<unknown>): readonly string[] {
  return typeof spec.from === "string" ? [spec.from] : spec.from;
}

/**
 * Reads a table through `spec`, tolerating an absent table and absent columns.
 *
 * @param table The table, or null when this Money version does not have it
 * @returns the mapped rows plus what the file was able to supply
 */
export function readTable<TRow>(
  table: MnyTable | null,
  tableName: string,
  spec: RowSpec<TRow>,
): TableReadResult<TRow> {
  const fields = Object.keys(spec) as (keyof TRow & string)[];

  const resolvedColumns: Readonly<Record<string, string | null>> =
    Object.fromEntries(
      fields.map((field) => [
        field,
        columnCandidates(spec[field]).find((column) =>
          table?.hasColumn(column),
        ) ?? null,
      ]),
    );
  const missingFields = fields.filter(
    (field) => resolvedColumns[field] === null,
  );

  if (!table) {
    return {
      rows: [],
      availability: {
        table: tableName,
        present: false,
        rowCount: 0,
        missingFields,
        resolvedColumns,
      },
    };
  }

  const columns = fields
    .map((field) => resolvedColumns[field])
    .filter((column): column is string => column !== null);
  const raw = table.rows([...new Set(columns)]);

  const rows = raw.map(
    (row: MnyRow) =>
      Object.fromEntries(
        fields.map((field) => {
          const column = resolvedColumns[field];
          return [field, spec[field].as(column === null ? null : row[column])];
        }),
      ) as TRow,
  );

  return {
    rows,
    availability: {
      table: tableName,
      present: true,
      rowCount: rows.length,
      missingFields,
      resolvedColumns,
    },
  };
}

/** Reads a table by name straight from an open database. */
export function readTableByName<TRow>(
  db: MnyDatabase,
  tableName: string,
  spec: RowSpec<TRow>,
): TableReadResult<TRow> {
  return readTable(db.getTableOrNull(tableName), tableName, spec);
}
