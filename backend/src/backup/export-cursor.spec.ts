import { EntityManager } from "typeorm";
import { createExportReader } from "./export-cursor";
import { emulatePgCursors } from "../test-helpers/pg-cursor-mock";

/**
 * The cursor reader is what turns "read a table" from one allocation the size of
 * the table into a bounded number of rows at a time (issue #1070). What it has to
 * get right is small and entirely about the statements it emits.
 */
describe("createExportReader", () => {
  const userId = "user-1";

  /** A manager double recording every statement, with cursors emulated. */
  function managerDouble(rowsBySql: Record<string, Record<string, unknown>[]>) {
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    const query = jest.fn(
      emulatePgCursors((sql: string) => {
        const match = Object.entries(rowsBySql).find(([needle]) =>
          String(sql).includes(needle),
        );
        return Promise.resolve(match ? match[1] : []);
      }),
    );
    const recording = jest.fn((sql: string, params?: unknown[]) => {
      statements.push({ sql: String(sql).trim(), params });
      return query(sql, params);
    });
    return {
      manager: { query: recording } as unknown as EntityManager,
      statements,
    };
  }

  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }));

  it("declares a cursor for the query and fetches it in batches", async () => {
    const { manager, statements } = managerDouble({
      "FROM things": rows(5),
    });
    const reader = createExportReader(manager, userId);

    const batches: Record<string, unknown>[][] = [];
    for await (const batch of reader.rows("SELECT * FROM things", 2)) {
      batches.push(batch);
    }

    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    const declare = statements.find((s) => s.sql.startsWith("DECLARE"));
    // The user id is still a bound parameter: `DECLARE ... CURSOR FOR` takes the
    // query's parameters, and interpolating an id into SQL is not a thing this
    // repository does even for a server-supplied value.
    expect(declare?.sql).toContain("CURSOR FOR SELECT * FROM things");
    expect(declare?.params).toEqual([userId]);
    expect(statements.filter((s) => s.sql.startsWith("FETCH"))).toHaveLength(3);
    expect(statements.some((s) => s.sql.startsWith("CLOSE"))).toBe(true);
  });

  it("stops fetching once a short batch says the cursor is spent", async () => {
    const { manager, statements } = managerDouble({ "FROM things": rows(3) });
    const reader = createExportReader(manager, userId);

    let seen = 0;
    for await (const batch of reader.rows("SELECT * FROM things", 10)) {
      seen += batch.length;
    }
    expect(seen).toBe(3);

    // One FETCH, not two: a short batch is the end, and asking again costs a
    // round trip per table on the common case of a small table.
    expect(statements.filter((s) => s.sql.startsWith("FETCH"))).toHaveLength(1);
  });

  it("closes the cursor when the consumer abandons it early", async () => {
    // A plain export holds its snapshot for the length of the download, so a
    // cursor left open by a failed write holds its resources for all of it.
    const { manager, statements } = managerDouble({ "FROM things": rows(50) });
    const reader = createExportReader(manager, userId);

    for await (const batch of reader.rows("SELECT * FROM things", 2)) {
      expect(batch).toHaveLength(2);
      break;
    }

    expect(statements.some((s) => s.sql.startsWith("CLOSE"))).toBe(true);
  });

  it("closes the cursor when the pipeline downstream of it throws", async () => {
    const { manager, statements } = managerDouble({ "FROM things": rows(50) });
    const reader = createExportReader(manager, userId);

    await expect(
      (async () => {
        for await (const batch of reader.rows("SELECT * FROM things", 2)) {
          throw new Error(`the response went away after ${batch.length} rows`);
        }
      })(),
    ).rejects.toThrow("the response went away after 2 rows");

    expect(statements.some((s) => s.sql.startsWith("CLOSE"))).toBe(true);
  });

  it("refuses a batch size that is not a positive integer", async () => {
    // The count reaches SQL: `FETCH FORWARD n` cannot take a bind parameter, so
    // the only thing standing between it and a splice is this check.
    const { manager } = managerDouble({});
    const reader = createExportReader(manager, userId);

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        (async () => {
          for await (const batch of reader.rows("SELECT 1", bad)) {
            throw new Error(`unreachable: ${batch.length}`);
          }
        })(),
      ).rejects.toThrow(/positive integer/);
    }
  });

  it("gives each cursor its own name so two tables can be open at once", async () => {
    const { manager, statements } = managerDouble({ "FROM things": rows(1) });
    const reader = createExportReader(manager, userId);

    for await (const outer of reader.rows("SELECT * FROM things", 1)) {
      // A nested read, as the attachment trailing rows do inside a table.
      for await (const inner of reader.rows("SELECT * FROM things", 1)) {
        expect(inner).toEqual(outer);
      }
    }

    const names = statements
      .filter((s) => s.sql.startsWith("DECLARE"))
      .map((s) => s.sql.split(/\s+/)[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("reads a whole result when asked for one", async () => {
    const { manager, statements } = managerDouble({ "FROM small": rows(2) });
    const reader = createExportReader(manager, userId);

    await expect(reader.read("SELECT * FROM small")).resolves.toHaveLength(2);
    expect(statements.every((s) => !s.sql.startsWith("DECLARE"))).toBe(true);
  });
});
