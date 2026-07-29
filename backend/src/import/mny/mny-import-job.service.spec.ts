import { returnedRows } from "./mny-import-job.service";

/**
 * The job service's behaviour lives in
 * `test/integration/mny-import-job.integration.spec.ts`: an atomic claim and
 * interval-based reaping are properties of Postgres, and mocking them would
 * assert the mock.
 *
 * What belongs here is the result-shape guard, because the bug it prevents is
 * silent. TypeORM hands back `[rows, rowCount]` from a data-modifying `query()`
 * with RETURNING and bare rows from a `SELECT`; reading the tuple as rows makes
 * `length > 0` always true, so every conditional claim looks like a winner and
 * two workers import the same file.
 */
describe("returnedRows", () => {
  it("unwraps the [rows, rowCount] tuple a data-modifying query returns", () => {
    expect(returnedRows([[{ id: "job-1" }], 1])).toEqual([{ id: "job-1" }]);
  });

  it("reports no rows when the conditional update matched nothing", () => {
    expect(returnedRows([[], 0])).toEqual([]);
  });

  it("passes bare SELECT rows through", () => {
    expect(returnedRows([{ id: "job-1" }, { id: "job-2" }])).toEqual([
      { id: "job-1" },
      { id: "job-2" },
    ]);
  });

  it("treats an empty result as no rows", () => {
    expect(returnedRows([])).toEqual([]);
  });

  it("treats a non-array result as no rows rather than throwing", () => {
    expect(returnedRows(undefined)).toEqual([]);
    expect(returnedRows(null)).toEqual([]);
    expect(returnedRows({ rowCount: 1 })).toEqual([]);
  });

  it("does not mistake a tuple for two rows", () => {
    // The actual defect: length 2 on the tuple read as "two rows updated".
    expect(returnedRows([[], 0])).toHaveLength(0);
  });
});
