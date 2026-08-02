import {
  EMPTY_COMPOSITION,
  GemSecurityComposition,
  compositionOverlap,
  dimensionFor,
  hasWeightings,
  matchHolding,
  overlapContributions,
  overlapPercent,
  weightsByName,
} from "./gem-composition.util";

const composition = (
  overrides: Partial<GemSecurityComposition>,
): GemSecurityComposition => ({ ...EMPTY_COMPOSITION, ...overrides });

describe("gem-composition.util", () => {
  describe("weightsByName", () => {
    it("keys weights case- and whitespace-insensitively", () => {
      const weights = weightsByName([
        { name: " United States ", weight: 0.6 },
        { name: "china", weight: 0.4 },
      ]);
      expect(weights.get("united states")).toBeCloseTo(0.6, 6);
      expect(weights.get("china")).toBeCloseTo(0.4, 6);
    });

    it("sums a name listed twice instead of keeping the last row", () => {
      const weights = weightsByName([
        { name: "India", weight: 0.2 },
        { name: "india", weight: 0.1 },
      ]);
      expect(weights.size).toBe(1);
      expect(weights.get("india")).toBeCloseTo(0.3, 6);
    });

    it("scales a breakdown that adds up to more than the whole fund", () => {
      const weights = weightsByName([
        { name: "A", weight: 0.8 },
        { name: "B", weight: 0.8 },
      ]);
      expect(weights.get("a")).toBeCloseTo(0.5, 6);
      expect(weights.get("b")).toBeCloseTo(0.5, 6);
    });

    it("folds the spellings this codebase itself produces", () => {
      // The allocation editor takes free text and Yahoo writes "Stocks", so
      // one fund described by hand and the next filled by the provider used to
      // share no name at all and score a confident zero overlap.
      const weights = weightsByName([
        { name: "Equities", weight: 0.5 },
        { name: "stock", weight: 0.5 },
      ]);
      expect(weights.size).toBe(1);
      expect(weights.get("stocks")).toBeCloseTo(1, 6);

      expect([
        ...weightsByName([{ name: "U.S.A.", weight: 1 }]).keys(),
      ]).toEqual(["united states"]);
      expect([
        ...weightsByName([{ name: "Cash & Equivalents", weight: 1 }]).keys(),
      ]).toEqual(["cash"]);
    });

    it("ignores accents and punctuation when matching a name", () => {
      const weights = weightsByName([
        { name: "Türkiye", weight: 0.5 },
        { name: "turkiye", weight: 0.5 },
      ]);
      expect(weights.size).toBe(1);
      expect(weights.get("turkiye")).toBeCloseTo(1, 6);
    });

    it("drops rows that say nothing", () => {
      expect(
        weightsByName([
          { name: "", weight: 0.5 },
          { name: "A", weight: 0 },
          { name: "B", weight: Number.NaN },
        ]).size,
      ).toBe(0);
      expect(weightsByName(null).size).toBe(0);
      expect(hasWeightings(null)).toBe(false);
    });
  });

  describe("dimensionFor", () => {
    it("compares an equity role on country and nothing else", () => {
      // The equity roles are geographies. Asset class would call an S&P 500
      // fund and an emerging-markets fund a perfect match -- both are wholly
      // stocks -- and sector nearly so, since both are about a quarter
      // technology. Either would report the wrong market as fully compliant.
      expect(
        dimensionFor(
          composition({ COUNTRY: [{ name: "Brazil", weight: 1 }] }),
          "EM_EQUITY",
        ),
      ).toBe("COUNTRY");
      expect(
        dimensionFor(
          composition({
            ASSET_CLASS: [{ name: "Stocks", weight: 1 }],
            SECTOR: [{ name: "Technology", weight: 1 }],
          }),
          "US_EQUITY",
        ),
      ).toBeNull();
    });

    it("compares a defensive role on asset class, then country", () => {
      expect(
        dimensionFor(
          composition({
            ASSET_CLASS: [{ name: "Bonds", weight: 1 }],
            COUNTRY: [{ name: "United States", weight: 1 }],
          }),
          "SAFE",
        ),
      ).toBe("ASSET_CLASS");
      expect(
        dimensionFor(
          composition({ COUNTRY: [{ name: "United States", weight: 1 }] }),
          "RISK_FREE",
        ),
      ).toBe("COUNTRY");
    });

    it("never decides anything on sector", () => {
      const sectorOnly = composition({
        SECTOR: [{ name: "Technology", weight: 1 }],
      });
      for (const role of [
        "US_EQUITY",
        "EX_US_EQUITY",
        "EM_EQUITY",
        "SAFE",
        "RISK_FREE",
      ] as const) {
        expect(dimensionFor(sectorOnly, role)).toBeNull();
      }
    });

    it("is null for a security nobody described, or with no role to fill", () => {
      expect(dimensionFor(EMPTY_COMPOSITION, "EM_EQUITY")).toBeNull();
      expect(
        dimensionFor(composition({ COUNTRY: [] }), "EM_EQUITY"),
      ).toBeNull();
      expect(
        dimensionFor(
          composition({ COUNTRY: [{ name: "Brazil", weight: 1 }] }),
          null,
        ),
      ).toBeNull();
    });
  });

  describe("compositionOverlap", () => {
    it("is the share of the holding sitting in the target's markets", () => {
      // A world tracker a tenth of which is emerging markets, against an
      // all-EM target: a tenth of it is already where the strategy wants it.
      const world = [
        { name: "United States", weight: 0.6 },
        { name: "Japan", weight: 0.3 },
        { name: "China", weight: 0.1 },
      ];
      const emerging = [{ name: "China", weight: 1 }];
      expect(compositionOverlap(world, emerging)).toBeCloseTo(0.1, 6);
    });

    it("is 1 for two identical breakdowns", () => {
      const weights = [
        { name: "China", weight: 0.5 },
        { name: "India", weight: 0.5 },
      ];
      expect(compositionOverlap(weights, [...weights])).toBeCloseTo(1, 6);
    });

    it("is 0 when the markets do not meet", () => {
      expect(
        compositionOverlap(
          [{ name: "United States", weight: 1 }],
          [{ name: "China", weight: 1 }],
        ),
      ).toBe(0);
    });

    it("counts undescribed weight as unknown, not as a match", () => {
      // The holding accounts for 40% of itself; the other 60% could be
      // anything, so it cannot be claimed as overlap.
      expect(
        compositionOverlap(
          [{ name: "China", weight: 0.4 }],
          [{ name: "China", weight: 1 }],
        ),
      ).toBeCloseTo(0.4, 6);
    });

    it("is 0 when either side is undescribed", () => {
      expect(compositionOverlap(null, [{ name: "China", weight: 1 }])).toBe(0);
      expect(compositionOverlap([{ name: "China", weight: 1 }], null)).toBe(0);
    });
  });

  describe("matchHolding", () => {
    const target = composition({
      COUNTRY: [
        { name: "China", weight: 0.5 },
        { name: "India", weight: 0.5 },
      ],
    });

    it("scores a described holding by its contents", () => {
      const match = matchHolding({
        isTarget: false,
        holding: composition({
          COUNTRY: [
            { name: "China", weight: 0.2 },
            { name: "United States", weight: 0.8 },
          ],
        }),
        target,
        dimension: "COUNTRY",
      });
      expect(match.overlap).toBeCloseTo(0.2, 6);
      expect(match.byInstrument).toBe(false);
    });

    /**
     * PRODUCT DECISION -- see `matchHolding`. Partial coverage is the storage
     * format, not an edge case: the securities editor drops the "Other" bucket
     * and the DTO says the slices need not sum to 1. The overlap computed over
     * it is a floor, and the floor is shown -- withholding it turned the whole
     * exposure column into "no data" for real funds, which reads as "Monize
     * cannot see the overlap" rather than "the description is partial".
     *
     * Minimal mutation: return `overlap: null` when either side is partial.
     * Test that fails under it: this one.
     */
    it("reports a floor against a partially described target", () => {
      const match = matchHolding({
        isTarget: false,
        // A China-only fund against a target recorded as 30% China and nothing
        // else: at least 0.30, possibly as much as 1.00.
        holding: composition({ COUNTRY: [{ name: "China", weight: 1 }] }),
        target: composition({ COUNTRY: [{ name: "China", weight: 0.3 }] }),
        dimension: "COUNTRY",
      });

      expect(match.overlap).toBeCloseTo(0.3, 6);
      expect(match.partial).toBe(true);
      expect(match.matched).toEqual([{ name: "China", weight: 0.3 }]);
      expect(match.byInstrument).toBe(false);
    });

    it("reports a floor of zero when a partial description shares nothing", () => {
      const match = matchHolding({
        isTarget: false,
        holding: composition({ COUNTRY: [{ name: "Brazil", weight: 1 }] }),
        target: composition({ COUNTRY: [{ name: "China", weight: 0.3 }] }),
        dimension: "COUNTRY",
      });

      // Zero of the *described* part is shared, and the 70% nobody described
      // may add to it -- which is exactly what "at least 0%" says.
      expect(match.overlap).toBe(0);
      expect(match.partial).toBe(true);
      expect(match.matched).toEqual([]);
    });

    it("reports a floor for a partially described holding", () => {
      const match = matchHolding({
        isTarget: false,
        holding: composition({ COUNTRY: [{ name: "China", weight: 0.2 }] }),
        target,
        dimension: "COUNTRY",
      });
      expect(match.overlap).toBeCloseTo(0.2, 6);
      expect(match.partial).toBe(true);
    });

    it("tolerates rounding in an otherwise complete breakdown", () => {
      const match = matchHolding({
        isTarget: false,
        holding: composition({
          COUNTRY: [
            { name: "China", weight: 0.201 },
            { name: "United States", weight: 0.79 },
          ],
        }),
        target,
        dimension: "COUNTRY",
      });
      // 0.991 is a provider rounding its percentages, not a fund described in
      // part.
      expect(match.overlap).toBeCloseTo(0.201, 6);
    });

    it("falls back to the instrument when the holding is undescribed", () => {
      const undescribed = {
        holding: EMPTY_COMPOSITION,
        target,
        dimension: "COUNTRY" as const,
      };
      expect(matchHolding({ isTarget: true, ...undescribed })).toEqual({
        overlap: 1,
        byInstrument: true,
        partial: false,
        matched: [],
      });
      expect(matchHolding({ isTarget: false, ...undescribed })).toEqual({
        overlap: 0,
        byInstrument: true,
        partial: false,
        matched: [],
      });
    });

    it("falls back for every holding when the target is undescribed", () => {
      const match = matchHolding({
        isTarget: false,
        holding: composition({ COUNTRY: [{ name: "China", weight: 1 }] }),
        target: EMPTY_COMPOSITION,
        dimension: null,
      });
      expect(match).toEqual({
        overlap: 0,
        byInstrument: true,
        partial: false,
        matched: [],
      });
    });

    it("counts the target instrument in full despite a partial breakdown", () => {
      // Holding exactly what was asked for is complete by definition; a
      // description covering only 70% of it must not read as 30% off-target.
      const match = matchHolding({
        isTarget: true,
        holding: composition({ COUNTRY: [{ name: "China", weight: 0.7 }] }),
        target: composition({ COUNTRY: [{ name: "China", weight: 0.7 }] }),
        dimension: "COUNTRY",
      });
      expect(match).toEqual({
        overlap: 1,
        byInstrument: false,
        // Not a floor either: holding the named instrument is 100%, full stop.
        partial: false,
        matched: [{ name: "China", weight: 0.7 }],
      });
    });
  });

  describe("overlapContributions", () => {
    it("names which markets the overlap is made of, largest first", () => {
      expect(
        overlapContributions(
          [
            { name: "China", weight: 0.1 },
            { name: "India", weight: 0.3 },
            { name: "United States", weight: 0.6 },
          ],
          [
            { name: "China", weight: 0.5 },
            { name: "India", weight: 0.5 },
          ],
        ),
        // The holding's own spelling, not the comparison key: the canonical
        // form is lowercased and folds synonyms, so pushing it out renamed the
        // market on screen ("united states" for "United States", and "USA" for
        // a target that said so).
      ).toEqual([
        { name: "India", weight: 0.3 },
        { name: "China", weight: 0.1 },
      ]);
    });

    it("keeps the holding's spelling even when the target's differs", () => {
      expect(
        overlapContributions(
          [{ name: "United States", weight: 0.6 }],
          [{ name: "USA", weight: 1 }],
        ),
      ).toEqual([{ name: "United States", weight: 0.6 }]);
    });

    it("caps each market at the target's own weight in it", () => {
      // The holding is 80% China but the target only 50%: the shared part is
      // the smaller of the two, not the holding's whole position.
      expect(
        overlapContributions(
          [{ name: "China", weight: 0.8 }],
          [{ name: "China", weight: 0.5 }],
        ),
      ).toEqual([{ name: "China", weight: 0.5 }]);
    });

    it("is empty when the markets do not meet", () => {
      expect(
        overlapContributions(
          [{ name: "Japan", weight: 1 }],
          [{ name: "China", weight: 1 }],
        ),
      ).toEqual([]);
    });
  });

  describe("overlapPercent", () => {
    it("reports an overlap as a percentage, and unknown as unknown", () => {
      expect(overlapPercent(0.1234)).toBe(12.34);
      expect(overlapPercent(null)).toBeNull();
    });
  });
});
