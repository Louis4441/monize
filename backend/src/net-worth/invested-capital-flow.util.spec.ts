import { RateIndex } from "../common/time-series/rate-index.util";
import {
  foldInvestedFlows,
  investedCapitalFlowSql,
  loadInvestedCapitalFlowRows,
} from "./invested-capital-flow.util";

const logger = { warn: jest.fn() };

/** One stored observation, in the shape `resolveFxRate` reads through the index. */
function index(pair: string, date: string, rate: number): RateIndex {
  return new Map([[pair, [{ date, rate }]]]);
}

describe("investedCapitalFlowSql", () => {
  const sql = investedCapitalFlowSql();

  it("binds every placeholder it names, and names no other", () => {
    // PostgreSQL refuses at PARSE when a statement carries a parameter it never
    // references ("could not determine data type of parameter $n"), which no
    // mocked-query spec can see -- the lesson the mixed-split count taught.
    const named = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

    expect([...new Set(named)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("reads rows as effects: a VOID investment row moved no value", () => {
    expect(sql).toContain("it.status != 'VOID'");
  });

  it("bounds the window exclusively below and inclusively above", () => {
    // IV(b) is a close and already holds everything dated b.
    expect(sql).toContain("it.transaction_date > $2");
    expect(sql).toContain("it.transaction_date <= $3");
  });

  it("records each row in its security's own currency", () => {
    // `total_amount` is stored in the security's currency, so the day's rate is
    // applied from there and never from the account's.
    expect(sql).toContain("COALESCE(s.currency_code, a.currency_code)");
  });

  it("renders the day with TO_CHAR, never ::TEXT", () => {
    // The caller keys a per-day map on this string; a DATE rendered through the
    // session's DateStyle is not obliged to be YYYY-MM-DD.
    expect(sql).toContain("TO_CHAR(it.transaction_date, 'YYYY-MM-DD')");
  });
});

describe("loadInvestedCapitalFlowRows", () => {
  it("passes the user, the window and the scope, in that order", async () => {
    const query = jest.fn(async () => []);

    await loadInvestedCapitalFlowRows(query, {
      userId: "user-1",
      afterDate: "2026-01-02",
      throughDate: "2026-06-01",
      accountIds: ["acct-1", "acct-2"],
    });

    expect(query).toHaveBeenCalledWith(investedCapitalFlowSql(), [
      "user-1",
      "2026-01-02",
      "2026-06-01",
      ["acct-1", "acct-2"],
    ]);
  });

  it("asks nothing of an empty scope: nothing is in it, so it totals nothing", async () => {
    const query = jest.fn(async () => []);

    await expect(
      loadInvestedCapitalFlowRows(query, {
        userId: "user-1",
        afterDate: "2026-01-02",
        throughDate: "2026-06-01",
        accountIds: [],
      }),
    ).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("coerces the driver's numeric strings at this boundary", async () => {
    const query = jest.fn(async () => [
      {
        date: "2026-02-02",
        currency: "USD",
        action: "BUY",
        total: "8000.0000",
        gross: "7990.0000",
      },
    ]);

    await expect(
      loadInvestedCapitalFlowRows(query, {
        userId: "user-1",
        afterDate: "2026-01-02",
        throughDate: "2026-06-01",
        accountIds: ["acct-1"],
      }),
    ).resolves.toEqual([
      {
        date: "2026-02-02",
        currency: "USD",
        action: "BUY",
        total: 8000,
        gross: 7990,
      },
    ]);
  });
});

describe("foldInvestedFlows", () => {
  const row = (partial: Partial<Parameters<typeof rowOf>[0]> = {}) =>
    rowOf({
      date: "2026-02-02",
      currency: "CAD",
      action: "BUY",
      total: 8000,
      gross: 8000,
      ...partial,
    });

  function rowOf(r: {
    date: string;
    currency: string;
    action: string;
    total: number;
    gross: number;
  }) {
    return r;
  }

  it("splits capital from income by the shared action constant", () => {
    const { byDay } = foldInvestedFlows(
      [
        row(),
        row({ action: "SELL", total: 9000 }),
        row({ action: "DIVIDEND", total: 100 }),
      ],
      "CAD",
      new Map(),
      logger,
    );

    expect(byDay.get("2026-02-02")).toEqual({
      capitalIn: 8000,
      capitalOut: 9000,
      income: 100,
      complete: true,
      missingPairs: [],
    });
  });

  it("counts a split and a reinvestment as neither: they move no value in", () => {
    // A reinvested distribution never landed as cash; its shares simply appear
    // in IV, and counting it as capital would subtract the return it was.
    const { byDay } = foldInvestedFlows(
      [
        row({ action: "SPLIT", total: 0, gross: 200 }),
        row({ action: "REINVEST", total: 0, gross: 500 }),
      ],
      "CAD",
      new Map(),
      logger,
    );

    expect(byDay.size).toBe(0);
  });

  it("values a share-moving leg from quantity x price, which carries no total", () => {
    const { byDay } = foldInvestedFlows(
      [row({ action: "TRANSFER_IN", total: 0, gross: 3000 })],
      "CAD",
      new Map(),
      logger,
    );

    expect(byDay.get("2026-02-02")?.capitalIn).toBe(3000);
  });

  it("converts each day at the rate of its own day", () => {
    const rates: RateIndex = new Map([
      [
        "USD->CAD",
        [
          { date: "2026-02-02", rate: 1.25 },
          { date: "2026-03-02", rate: 1.5 },
        ],
      ],
    ]);

    const { byDay } = foldInvestedFlows(
      [
        row({ currency: "USD", total: 1000 }),
        row({ date: "2026-03-02", currency: "USD", total: 1000 }),
      ],
      "CAD",
      rates,
      logger,
    );

    expect(byDay.get("2026-02-02")?.capitalIn).toBe(1250);
    expect(byDay.get("2026-03-02")?.capitalIn).toBe(1500);
  });

  it("marks the day incomplete, and names the pair, when a rate is missing", () => {
    // Never 1, never the unconverted amount: the day is unknown, which
    // withholds the period rather than shrinking it.
    const { byDay, gaps } = foldInvestedFlows(
      [row({ currency: "EUR", total: 1000 })],
      "CAD",
      index("USD->CAD", "2026-02-02", 1.25),
      logger,
    );

    expect(byDay.get("2026-02-02")).toMatchObject({
      capitalIn: 0,
      complete: false,
      missingPairs: ["EUR->CAD"],
    });
    expect(gaps).toEqual([
      { date: "2026-02-02", missingRatePairs: ["EUR->CAD"] },
    ]);
  });
});
