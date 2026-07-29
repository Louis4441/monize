import { MnyRow, MnyTable, MnyValue } from "../msisam/open-mny";
import { RowSpec, readTable } from "./table-reader";

interface SampleRow {
  id: number;
  label: string;
}

const SAMPLE_SPEC: RowSpec<SampleRow> = {
  id: { from: "hid", as: (value) => (typeof value === "number" ? value : -1) },
  label: { from: ["szNew", "szOld"], as: (value) => String(value ?? "none") },
};

/** Minimal MnyTable stand-in; the reader only needs these three members. */
function fakeTable(columns: readonly string[], rows: MnyRow[]): MnyTable {
  const present = new Set(columns);
  return {
    name: "SAMPLE",
    rowCount: rows.length,
    columnNames: columns,
    hasColumn: (column) => present.has(column),
    rows: (requested) =>
      requested === undefined
        ? rows
        : rows.map((row) =>
            Object.fromEntries(
              requested
                .filter((column) => present.has(column))
                .map((column) => [column, row[column] ?? null]),
            ),
          ),
  };
}

describe("readTable", () => {
  it("maps rows through the spec", () => {
    const table = fakeTable(
      ["hid", "szNew"],
      [
        { hid: 1, szNew: "first" },
        { hid: 2, szNew: "second" },
      ],
    );

    const result = readTable(table, "SAMPLE", SAMPLE_SPEC);

    expect(result.rows).toEqual([
      { id: 1, label: "first" },
      { id: 2, label: "second" },
    ]);
    expect(result.availability).toMatchObject({
      table: "SAMPLE",
      present: true,
      rowCount: 2,
      missingFields: [],
    });
  });

  it("prefers the first alias the file actually has", () => {
    // Money Plus renamed TRN.hpay to lHpay; declaring the newest name first
    // means a Money 2002 file still resolves to the old one.
    const table = fakeTable(["hid", "szOld"], [{ hid: 7, szOld: "legacy" }]);

    const result = readTable(table, "SAMPLE", SAMPLE_SPEC);

    expect(result.rows[0].label).toBe("legacy");
    expect(result.availability.resolvedColumns.label).toBe("szOld");
  });

  it("falls back to the converter default when no alias exists", () => {
    const table = fakeTable(["hid"], [{ hid: 3 }]);

    const result = readTable(table, "SAMPLE", SAMPLE_SPEC);

    expect(result.rows).toEqual([{ id: 3, label: "none" }]);
    expect(result.availability.missingFields).toEqual(["label"]);
    expect(result.availability.resolvedColumns.label).toBeNull();
  });

  it("returns no rows and reports absence for a table this version lacks", () => {
    const result = readTable(null, "BILL", SAMPLE_SPEC);

    expect(result.rows).toEqual([]);
    expect(result.availability).toEqual({
      table: "BILL",
      present: false,
      rowCount: 0,
      missingFields: ["id", "label"],
      resolvedColumns: { id: null, label: null },
    });
  });

  it("requests each column once even when fields share one", () => {
    const requested: (readonly string[] | undefined)[] = [];
    const table = fakeTable(["hid"], [{ hid: 1 }]);
    const spy: MnyTable = {
      ...table,
      rows: (columns) => {
        requested.push(columns);
        return table.rows(columns);
      },
    };
    const sharedSpec: RowSpec<{ a: MnyValue; b: MnyValue }> = {
      a: { from: "hid", as: (value) => value },
      b: { from: "hid", as: (value) => value },
    };

    readTable(spy, "SAMPLE", sharedSpec);

    expect(requested).toEqual([["hid"]]);
  });

  it("handles an empty table", () => {
    const result = readTable(
      fakeTable(["hid", "szNew"], []),
      "SAMPLE",
      SAMPLE_SPEC,
    );

    expect(result.rows).toEqual([]);
    expect(result.availability.present).toBe(true);
    expect(result.availability.rowCount).toBe(0);
  });
});
