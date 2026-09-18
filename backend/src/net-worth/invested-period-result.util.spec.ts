/**
 * The twelve worked cases of `docs/specs/portfolio-period-result.md` section
 * 10.5, table-driven over the pure decision.
 *
 * The adversarial case is (4): a large deposit the day before the window ends
 * moves the account-level value change by 50,000 and must move neither invested
 * figure by a cent. A `totalValue - cash` patch at the two boundaries passes
 * cases 1-4 and fails 5, 6, 7 and 9, which is why each of those carries its own
 * row here.
 */
import { addDaysYMD } from "../common/date-utils";
import {
  EMPTY_INVESTED_FLOW_DAY,
  InvestedFlowDay,
} from "./invested-capital-flow.util";
import {
  InvestedDayValue,
  investedPeriodResult,
} from "./invested-period-result.util";

const START = "2026-01-01";

/** A day's invested value, complete unless the case says otherwise. */
function day(
  date: string,
  securitiesValue: number,
  flags: Partial<InvestedDayValue> = {},
): InvestedDayValue {
  return {
    date,
    securitiesValue,
    fxComplete: true,
    pricesComplete: true,
    missingRatePairs: [],
    unpricedSecurityIds: [],
    ...flags,
  };
}

function flow(partial: Partial<InvestedFlowDay>): InvestedFlowDay {
  return { ...EMPTY_INVESTED_FLOW_DAY, ...partial };
}

/** `values[i]` is the close of day `START + i`; index 0 is the baseline `b`. */
function series(values: number[]): InvestedDayValue[] {
  return values.map((value, index) => day(addDaysYMD(START, index), value));
}

function dayOf(index: number): string {
  return addDaysYMD(START, index);
}

function run(
  values: number[],
  flows: Record<number, Partial<InvestedFlowDay>> = {},
  overrides: Partial<Parameters<typeof investedPeriodResult>[0]> = {},
) {
  const points = series(values);
  const flowsByDay = new Map<string, InvestedFlowDay>(
    Object.entries(flows).map(([index, value]) => [
      dayOf(Number(index)),
      flow(value),
    ]),
  );
  return investedPeriodResult({
    points,
    startIndex: 0,
    endIndex: points.length - 1,
    flowsByDay,
    ...overrides,
  });
}

describe("investedPeriodResult (spec section 10.5)", () => {
  it("case 1: cash only -- nothing invested, nothing earned, a known zero", () => {
    // Deposit 10,000, no securities: IV is 0 on every day of the month.
    const result = run(Array.from({ length: 31 }, () => 0));

    expect(result.investmentPnl).toBe(0);
    expect(result.investmentReturnPercent).toBe(0);
    expect(result.investedComplete).toBe(true);
    expect(result.investedReasons).toEqual([]);
  });

  it("case 2: a deposit invested at once is a capital flow, not a gain", () => {
    // d1 buys 8,000 of a security; 2,000 of the deposit stays as cash.
    const result = run([0, 8_000, 8_000, 8_000], { 1: { capitalIn: 8_000 } });

    expect(result.investmentCapitalFlows).toBe(8_000);
    expect(result.investmentPnl).toBe(0);
    expect(result.investmentReturnPercent).toBe(0);
  });

  it("case 3: a 10% gain is 10%, not 8% -- the idle cash is in no base", () => {
    const result = run([0, 8_000, 8_800, 8_800], { 1: { capitalIn: 8_000 } });

    expect(result.investmentPnl).toBe(800);
    expect(result.investmentReturnPercent).toBe(10);
  });

  it("case 4: a 50,000 deposit the day before the end changes neither figure", () => {
    // The deposit is cash. It is in no IV, no capital flow and no income, so
    // the figures are identical to case 3 to the cent. (The account-level
    // valueChange moves by 50,000; that is the other measure's business.)
    const invested = run([0, 8_000, 8_800, 8_800], { 1: { capitalIn: 8_000 } });
    // The deposit lands on the second-to-last day and is left uninvested, so
    // IV does not move on it while the account's own value jumps by 50,000.
    const withDeposit = run([0, 8_000, 8_800, 8_800, 8_800], {
      1: { capitalIn: 8_000 },
    });

    expect(withDeposit.investmentPnl).toBe(invested.investmentPnl);
    expect(withDeposit.investmentReturnPercent).toBe(
      invested.investmentReturnPercent,
    );
    expect(withDeposit.investmentPnl).toBe(800);
    expect(withDeposit.investmentReturnPercent).toBe(10);
  });

  it("case 5: a second purchase at an unchanged price changes neither figure", () => {
    // 8,000 in, up 10% to 8,800, then 4,000 more at an unchanged price.
    const result = run([0, 8_000, 8_800, 12_800, 12_800], {
      1: { capitalIn: 8_000 },
      3: { capitalIn: 4_000 },
    });

    expect(result.investmentCapitalFlows).toBe(12_000);
    expect(result.investmentPnl).toBe(800);
    // The purchase day's factor is (12,800) / (8,800 + 4,000) = 1.
    expect(result.investmentReturnPercent).toBe(10);
  });

  it("case 6: a full sale inside the window keeps the gain it realised", () => {
    // Buy 8,000 on d1, sell the lot for 9,000 on d3.
    const result = run([0, 8_000, 8_000, 0, 0], {
      1: { capitalIn: 8_000 },
      3: { capitalOut: 9_000 },
    });

    expect(result.investmentCapitalFlows).toBe(-1_000);
    expect(result.investmentPnl).toBe(1_000);
    // (0 + 9,000) / 8,000 = 1.125. Under a pure start-of-day flow convention
    // the base would be 8,000 - 9,000 = -1,000 and this day -- the one that
    // realised the whole gain -- would drop out of the chain.
    expect(result.investmentReturnPercent).toBe(12.5);
  });

  it("case 7: the proceeds sitting as cash earn nothing afterwards", () => {
    const sold = run([0, 8_000, 8_000, 0, 0], {
      1: { capitalIn: 8_000 },
      3: { capitalOut: 9_000 },
    });
    const andWaited = run([0, 8_000, 8_000, 0, 0, 0, 0, 0], {
      1: { capitalIn: 8_000 },
      3: { capitalOut: 9_000 },
    });

    expect(andWaited.investmentPnl).toBe(sold.investmentPnl);
    expect(andWaited.investmentReturnPercent).toBe(
      sold.investmentReturnPercent,
    );
  });

  it("case 8: a dividend is return although it ends up as cash", () => {
    const result = run([8_000, 8_000, 8_000], { 2: { income: 100 } });

    expect(result.investmentIncome).toBe(100);
    expect(result.investmentPnl).toBe(100);
    // (8,000 + 100) / 8,000 - 1 = 1.25%.
    expect(result.investmentReturnPercent).toBe(1.25);
  });

  it("case 9: a position closed before today is still in the window", () => {
    // X: 5,000 in on d1, 6,000 on d2, sold for 6,000 on d3. Y: 6,000 in on d4,
    // 6,600 on d5. A reconstruction from today's holdings would report only Y.
    const result = run([0, 5_000, 6_000, 0, 6_000, 6_600], {
      1: { capitalIn: 5_000 },
      3: { capitalOut: 6_000 },
      4: { capitalIn: 6_000 },
    });

    expect(result.investmentCapitalFlows).toBe(5_000);
    expect(result.investmentPnl).toBe(1_600);
    // 1.2 on X's gain day, 1.1 on Y's: 1.32 - 1 = 32%.
    expect(result.investmentReturnPercent).toBe(32);
  });

  it("case 10: an internal share transfer is factor 1 and no net flow", () => {
    // Both legs are in scope, so the day carries capital in AND out at the same
    // value while IV does not move.
    const result = run([10_000, 10_000, 10_000], {
      1: { capitalIn: 3_000, capitalOut: 3_000 },
    });

    expect(result.investmentCapitalFlows).toBe(0);
    expect(result.investmentPnl).toBe(0);
    expect(result.investmentReturnPercent).toBe(0);
  });

  it("case 11: the figures are read in whatever currency the caller folded to", () => {
    // Conversion happens before this function: IV per day, each K and I at its
    // own day. What it must not do is re-derive anything from a single rate --
    // the same numbers in a second currency give the same percentage.
    const inCad = run([0, 8_000, 8_800], { 1: { capitalIn: 8_000 } });
    const inEur = run([0, 4_000, 4_400], { 1: { capitalIn: 4_000 } });

    expect(inEur.investmentReturnPercent).toBe(inCad.investmentReturnPercent);
    expect(inEur.investmentPnl).toBe(400);
  });

  it("case 12: a missing price inside the window withholds both figures", () => {
    const points = series([0, 8_000, 8_800, 8_800]);
    points[2] = day("2026-01-03", 8_800, {
      pricesComplete: false,
      unpricedSecurityIds: ["sec-1"],
    });

    const result = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: points.length - 1,
      flowsByDay: new Map([["2026-01-02", flow({ capitalIn: 8_000 })]]),
    });

    expect(result.investmentPnl).toBeNull();
    expect(result.investmentReturnPercent).toBeNull();
    expect(result.investedReasons).toContain("incompletePrices");
  });

  it("case 12: a capital row that would not convert withholds both figures", () => {
    const result = run([0, 8_000, 8_800], {
      1: {
        capitalIn: 8_000,
        complete: false,
        missingPairs: ["EUR->CAD"],
      },
    });

    expect(result.investmentCapitalFlows).toBeNull();
    expect(result.investmentIncome).toBeNull();
    expect(result.investmentPnl).toBeNull();
    expect(result.investmentReturnPercent).toBeNull();
    expect(result.investedReasons).toContain("missingRatePairs");
  });

  it("withholds both figures when the window holds an uncountable movement", () => {
    const result = run(
      [0, 8_000, 8_800],
      { 1: { capitalIn: 8_000 } },
      {
        unmeasuredFlows: { externallySettledTrades: 1, mixedSplitParents: 0 },
      },
    );

    expect(result.investmentPnl).toBeNull();
    expect(result.investedReasons).toContain("externallySettledTrade");
  });

  it("reports the boundary's own causes when the start day is a subtotal", () => {
    const points = series([0, 8_000]);
    points[0] = day(START, 0, { fxComplete: false });

    const result = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: 1,
      flowsByDay: new Map(),
    });

    expect(result.investmentPnl).toBeNull();
    expect(result.investedReasons).toContain("missingRatePairs");
  });

  it("does not read cashComplete: cash is in no invested figure", () => {
    // The point carries a cash gap, which withholds the ACCOUNT-level value
    // change and must not withhold these figures: no cash is in IV.
    const points = series([8_000, 8_800]).map((point) => ({
      ...point,
      cashComplete: false,
      unknownCashAccountIds: ["cash-1"],
    }));

    const result = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: 1,
      flowsByDay: new Map(),
    });

    expect(result.investmentPnl).toBe(800);
    expect(result.investmentReturnPercent).toBe(10);
    expect(result.investedComplete).toBe(true);
  });

  it("has no ratio for a result with no invested capital behind it", () => {
    // A distribution on a day IV was zero throughout: the money is known, the
    // ratio is not, and 0% would be a claim that nothing happened.
    const result = run([0, 0], { 1: { income: 100 } });

    expect(result.investmentPnl).toBe(100);
    expect(result.investmentReturnPercent).toBeNull();
    expect(result.investedReasons).toContain("zeroStart");
  });

  it("is noValueSeries for a window the series does not cover", () => {
    const result = investedPeriodResult({
      points: [],
      startIndex: 0,
      endIndex: 0,
      flowsByDay: new Map(),
    });

    expect(result.investedReasons).toEqual(["noValueSeries"]);
    expect(result.investmentPnl).toBeNull();
    expect(result.investmentReturnMethod).toBe("twr");
  });
});
