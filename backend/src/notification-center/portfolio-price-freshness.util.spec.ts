import { stalePricedSecurityIds } from "./portfolio-price-freshness.util";

describe("stalePricedSecurityIds", () => {
  const dates = (map: Record<string, string>) => (id: string) =>
    map[id] ?? null;

  it("accepts a position priced on the baseline date itself", () => {
    expect(
      stalePricedSecurityIds(
        [{ securityId: "s1", quantity: 10 }],
        dates({ s1: "2026-09-11" }),
        "2026-09-11",
      ),
    ).toEqual([]);
  });

  it("accepts a position priced after the baseline date", () => {
    expect(
      stalePricedSecurityIds(
        [{ securityId: "s1", quantity: 10 }],
        dates({ s1: "2026-09-14" }),
        "2026-09-11",
      ),
    ).toEqual([]);
  });

  it("reports a position whose latest close predates the baseline", () => {
    // The 94% component of issue #1391: this position's value is carried from
    // June, so the difference between the two runs is not a market move.
    expect(
      stalePricedSecurityIds(
        [
          { securityId: "s1", quantity: 10 },
          { securityId: "s2", quantity: 3 },
        ],
        dates({ s1: "2026-06-30", s2: "2026-09-14" }),
        "2026-09-11",
      ),
    ).toEqual(["s1"]);
  });

  it("reports a held position with no observation at all", () => {
    expect(
      stalePricedSecurityIds(
        [{ securityId: "s1", quantity: 10 }],
        dates({}),
        "2026-09-11",
      ),
    ).toEqual(["s1"]);
  });

  it("ignores a closed position, however old its last price", () => {
    // Nothing is held, so nothing is carried: a sold-out row cannot move.
    expect(
      stalePricedSecurityIds(
        [
          { securityId: "s1", quantity: 0 },
          { securityId: "s2", quantity: 0.000000001 },
        ],
        dates({ s1: "2019-01-02" }),
        "2026-09-11",
      ),
    ).toEqual([]);
  });

  it("names each stale security once, sorted", () => {
    expect(
      stalePricedSecurityIds(
        [
          { securityId: "s2", quantity: 1 },
          { securityId: "s1", quantity: 2 },
          { securityId: "s2", quantity: 4 },
        ],
        dates({}),
        "2026-09-11",
      ),
    ).toEqual(["s1", "s2"]);
  });

  it("holds a short position to the same rule as a long one", () => {
    expect(
      stalePricedSecurityIds(
        [{ securityId: "s1", quantity: -10 }],
        dates({ s1: "2026-06-30" }),
        "2026-09-11",
      ),
    ).toEqual(["s1"]);
  });
});
