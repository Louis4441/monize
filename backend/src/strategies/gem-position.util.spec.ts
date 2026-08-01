import { readFileSync } from "fs";
import { join } from "path";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { EMPTY_COMPOSITION } from "./gem-composition.util";
import {
  GemHolding,
  buildPositionMath,
  estimateCommission,
  estimateTax,
} from "./gem-position.util";

const holding = (
  overrides: Partial<GemHolding> & { role: GemAssetRole | null },
): GemHolding => ({
  securityId: `sec-${overrides.role ?? "other"}`,
  symbol: overrides.role ?? "OTHER",
  name: null,
  quantity: 10,
  marketValue: 1000,
  costBasis: 800,
  ...overrides,
});

describe("gem-position.util", () => {
  describe("buildPositionMath", () => {
    it("reports the position the signal wants moved out of", () => {
      const math = buildPositionMath(
        [
          holding({
            role: "US_EQUITY",
            quantity: 51,
            marketValue: 23076.23,
            costBasis: 18281.46,
          }),
        ],
        "EM_EQUITY",
      );

      expect(math.current?.role).toBe("US_EQUITY");
      expect(math.totalMarketValue).toBeCloseTo(23076.23, 2);
      expect(math.exactTargetPercent).toBe(0);
      expect(math.changeRequired).toBe(true);
      expect(math.transferValue).toBeCloseTo(23076.23, 2);
      expect(math.realizedGainLoss).toBeCloseTo(4794.77, 2);
    });

    it("sums a role held in more than one account", () => {
      const math = buildPositionMath(
        [
          holding({ role: "EM_EQUITY", quantity: 100, marketValue: 3500 }),
          holding({
            role: "EM_EQUITY",
            securityId: "sec-EM_EQUITY",
            quantity: 40,
            marketValue: 1400,
          }),
        ],
        "EM_EQUITY",
      );

      expect(math.totalMarketValue).toBe(4900);
      // Both rows are the target instrument, in two accounts.
      expect(math.exactTargetPercent).toBe(100);
      expect(math.changeRequired).toBe(false);
      expect(math.transferValue).toBeNull();
    });

    it("counts a holding outside the strategy against compliance", () => {
      // The whole portfolio has to sit in the target, so an instrument the
      // strategy never assigned is exactly what makes it non-compliant.
      const math = buildPositionMath(
        [
          holding({ role: "EM_EQUITY", marketValue: 4000 }),
          holding({ role: null, symbol: "WTAI", marketValue: 6000 }),
        ],
        "EM_EQUITY",
      );

      expect(math.totalMarketValue).toBe(10000);
      expect(math.exactTargetPercent).toBe(40);
      expect(math.changeRequired).toBe(true);
      expect(math.transferValue).toBe(6000);
      expect(math.offTarget.map((entry) => entry.symbol)).toEqual(["WTAI"]);
    });

    it("moves every off-target instrument, largest first", () => {
      const math = buildPositionMath(
        [
          holding({ role: null, symbol: "AGGG", marketValue: 1500 }),
          holding({ role: null, symbol: "VWRA", marketValue: 4000 }),
          holding({ role: "SAFE", marketValue: 2500 }),
          holding({ role: "EM_EQUITY", marketValue: 2000 }),
        ],
        "EM_EQUITY",
      );

      expect(math.current?.symbol).toBe("VWRA");
      expect(math.offTarget.map((entry) => entry.symbol)).toEqual([
        "VWRA",
        "SAFE",
        "AGGG",
      ]);
      expect(math.transferValue).toBe(8000);
      expect(math.exactTargetPercent).toBe(20);
    });

    it("treats a partially switched portfolio as non-compliant", () => {
      const math = buildPositionMath(
        [
          holding({ role: "EM_EQUITY", marketValue: 6400 }),
          holding({ role: "US_EQUITY", marketValue: 3600 }),
        ],
        "EM_EQUITY",
      );

      expect(math.exactTargetPercent).toBe(64);
      expect(math.changeRequired).toBe(true);
      expect(math.transferValue).toBe(3600);
    });

    it("ignores dust quantities", () => {
      const math = buildPositionMath(
        [holding({ role: "US_EQUITY", quantity: 0.00001 })],
        "EM_EQUITY",
      );

      expect(math.holdings).toHaveLength(0);
      expect(math.totalMarketValue).toBeNull();
      // An empty set of accounts still needs the target bought.
      expect(math.changeRequired).toBe(true);
      expect(math.exactTargetPercent).toBeNull();
    });

    it("keeps an unpriced holding unvalued rather than worth zero", () => {
      const math = buildPositionMath(
        [holding({ role: "US_EQUITY", marketValue: null, costBasis: null })],
        "EM_EQUITY",
      );

      expect(math.holdings[0].marketValue).toBeNull();
      expect(math.totalMarketValue).toBeNull();
      expect(math.transferValue).toBeNull();
      expect(math.realizedGainLoss).toBeNull();
    });

    it("leaves the realized result unknown without a cost basis", () => {
      const math = buildPositionMath(
        [holding({ role: "US_EQUITY", marketValue: 1200, costBasis: null })],
        "EM_EQUITY",
      );

      expect(math.transferValue).toBe(1200);
      expect(math.realizedGainLoss).toBeNull();
    });

    it("requires no change and moves nothing without a target", () => {
      const math = buildPositionMath(
        [holding({ role: "US_EQUITY", marketValue: 1000 })],
        null,
      );

      expect(math.exactTargetPercent).toBeNull();
      expect(math.changeRequired).toBe(false);
      expect(math.offTarget).toEqual([]);
      expect(math.transferValue).toBeNull();
    });
  });

  describe("composition-based compliance", () => {
    const emergingTarget = {
      securityId: "sec-eem",
      composition: {
        COUNTRY: [
          { name: "China", weight: 0.5 },
          { name: "India", weight: 0.5 },
        ],
        ASSET_CLASS: null,
        SECTOR: null,
      },
    };

    it("counts the part of a world tracker already in the target's markets", () => {
      // 10000 in a world fund that is 20% emerging markets, against an all-EM
      // target: 2000 is already where the strategy wants it, which is what the
      // compliance figure reports -- and the whole 10000 still has to move,
      // because those 2000 cannot be kept without keeping the other 8000 too.
      const math = buildPositionMath(
        [
          holding({
            role: null,
            securityId: "sec-world",
            marketValue: 10000,
            costBasis: 6000,
            composition: {
              COUNTRY: [
                { name: "United States", weight: 0.8 },
                { name: "China", weight: 0.1 },
                { name: "India", weight: 0.1 },
              ],
              ASSET_CLASS: null,
              SECTOR: null,
            },
          }),
        ],
        "EM_EQUITY",
        emergingTarget,
      );

      expect(math.basis).toBe("COMPOSITION");
      expect(math.dimension).toBe("COUNTRY");
      // A fifth of the fund is in the target's markets, which is exposure and
      // not compliance: none of it is the instrument the signal named.
      expect(math.marketExposurePercent).toBe(20);
      expect(math.exactTargetPercent).toBe(0);
      // The executable trade, not the notional off-target slice: moving only
      // 8000 leaves the portfolio 84% emerging markets, never the 100% asked
      // for, because 80% of the fund's own EM sleeve goes out with the sale.
      expect(math.transferValue).toBe(10000);
      // Selling it whole realizes the whole 4000 gain, which is what the tax
      // estimate has to be built on.
      expect(math.realizedGainLoss).toBeCloseTo(4000, 4);
      expect(math.holdings[0].overlap).toBeCloseTo(0.2, 6);
      expect(math.holdings[0].matchedByInstrument).toBe(false);
      expect(math.changeRequired).toBe(true);
    });

    it("will not call a portfolio compliant while a holding has no price", () => {
      // The regression: an unpriced holding was dropped from the denominator
      // but counted as zero in the numerator, so 10,000 in the target plus one
      // off-target holding nobody could value came out at exactly 100% -- and
      // `changeRequired` false. The report said there was nothing to do about
      // a position it could not see.
      const math = buildPositionMath(
        [
          holding({
            role: "EM_EQUITY",
            securityId: "sec-emim",
            marketValue: 10000,
            costBasis: 8000,
          }),
          holding({
            role: null,
            securityId: "sec-unpriced",
            marketValue: null,
            costBasis: null,
          }),
        ],
        "EM_EQUITY",
        emergingTarget,
      );

      expect(math.exactTargetPercent).toBeNull();
      expect(math.changeRequired).toBe(true);
      expect(math.sold.map((entry) => entry.securityId)).toEqual([
        "sec-unpriced",
      ]);
    });

    it("reports no total and no transfer while a holding has no price", () => {
      // A sum that skips what it could not value is not the total, and it is
      // read as one -- on screen, and by the backtest when it sizes the
      // commission drag against the portfolio.
      const math = buildPositionMath(
        [
          holding({
            role: null,
            securityId: "sec-priced",
            marketValue: 4000,
            costBasis: 3000,
          }),
          holding({
            role: null,
            securityId: "sec-unpriced",
            marketValue: null,
            costBasis: null,
          }),
        ],
        "EM_EQUITY",
        emergingTarget,
      );

      expect(math.totalMarketValue).toBeNull();
      expect(math.transferValue).toBeNull();
      // And the gain is unknown too: one of the positions being sold has no
      // price and no cost, so a figure from the other is not the result.
      expect(math.realizedGainLoss).toBeNull();
    });

    it("does not let cash answer for a holding whose cost is unknown", () => {
      // Cash "realizes" nothing and its cost equals its value, so counting it
      // among the realizable positions turned an unknowable gain -- and the
      // tax on it -- into a confident zero.
      const math = buildPositionMath(
        [
          holding({
            role: null,
            securityId: "sec-uncosted",
            marketValue: 5000,
            costBasis: null,
          }),
          holding({
            role: null,
            securityId: null,
            marketValue: 1000,
            costBasis: 1000,
            isCash: true,
          }),
        ],
        "EM_EQUITY",
        emergingTarget,
      );

      expect(math.realizedGainLoss).toBeNull();
      // The transfer is still known: both positions have a market value.
      expect(math.transferValue).toBe(6000);
    });

    it("realizes nothing when the switch only spends cash", () => {
      const math = buildPositionMath(
        [
          holding({
            role: "EM_EQUITY",
            securityId: "sec-emim",
            marketValue: 9000,
            costBasis: 7000,
          }),
          holding({
            role: null,
            securityId: null,
            marketValue: 1000,
            costBasis: 1000,
            isCash: true,
          }),
        ],
        "EM_EQUITY",
        emergingTarget,
      );

      expect(math.sold).toEqual([]);
      expect(math.realizedGainLoss).toBe(0);
      expect(math.transferValue).toBe(1000);
    });

    it("sells a partially overlapping fund whole, whatever its overlap", () => {
      // The regression this guards: overlap used to scale the sale, so a fund
      // 90% on target moved only a tenth of itself and the report called the
      // result compliant. Units are indivisible by market -- the sale is all
      // or nothing, and only the compliance figure is a fraction.
      const nearlyThere = buildPositionMath(
        [
          holding({
            role: null,
            securityId: "sec-mostly-em",
            marketValue: 10000,
            costBasis: 4000,
            composition: {
              COUNTRY: [
                { name: "China", weight: 0.45 },
                { name: "India", weight: 0.45 },
                { name: "Japan", weight: 0.1 },
              ],
              ASSET_CLASS: null,
              SECTOR: null,
            },
          }),
        ],
        "EM_EQUITY",
        emergingTarget,
      );

      expect(nearlyThere.marketExposurePercent).toBe(90);
      // Exposure is not compliance: none of it is the target instrument.
      expect(nearlyThere.exactTargetPercent).toBe(0);
      expect(nearlyThere.transferValue).toBe(10000);
      expect(nearlyThere.realizedGainLoss).toBeCloseTo(6000, 4);
      expect(nearlyThere.changeRequired).toBe(true);
    });

    it("needs no change when the contents already match, ticker aside", () => {
      const math = buildPositionMath(
        [
          holding({
            role: null,
            securityId: "sec-other-em",
            marketValue: 5000,
            composition: emergingTarget.composition,
          }),
        ],
        "EM_EQUITY",
        emergingTarget,
      );

      expect(math.marketExposurePercent).toBe(100);
      // A different fund with identical contents is still a different fund,
      // and GEM asks for the named one: the position is sold, not kept.
      expect(math.exactTargetPercent).toBe(0);
      expect(math.changeRequired).toBe(true);
      expect(math.transferValue).toBe(5000);
    });

    it("compares by instrument when the target is undescribed, and says so", () => {
      const math = buildPositionMath(
        [
          holding({
            role: null,
            securityId: "sec-world",
            marketValue: 10000,
            composition: {
              COUNTRY: [{ name: "China", weight: 1 }],
              ASSET_CLASS: null,
              SECTOR: null,
            },
          }),
        ],
        "EM_EQUITY",
        { securityId: "sec-eem", composition: EMPTY_COMPOSITION },
      );

      expect(math.basis).toBe("INSTRUMENT");
      expect(math.dimension).toBeNull();
      expect(math.instrumentMatchedCount).toBe(1);
      expect(math.exactTargetPercent).toBe(0);
      // Nothing to compare contents with, so the exposure is unknown -- not a
      // confident zero printed beside a fund nobody measured.
      expect(math.marketExposurePercent).toBeNull();
      expect(math.marketExposureAvailable).toBe(false);
    });

    it("falls back per holding, and counts how many fell back", () => {
      const math = buildPositionMath(
        [
          holding({
            role: null,
            securityId: "sec-world",
            marketValue: 5000,
            composition: {
              COUNTRY: [{ name: "China", weight: 0.5 }],
              ASSET_CLASS: null,
              SECTOR: null,
            },
          }),
          // Undescribed and not the target: judged the old way, so 0.
          holding({ role: null, securityId: "sec-mystery", marketValue: 5000 }),
        ],
        "EM_EQUITY",
        emergingTarget,
      );

      expect(math.basis).toBe("COMPOSITION");
      expect(math.instrumentMatchedCount).toBe(1);
      // One fund cannot be placed at all, so the exposure of the whole is
      // unknown: 25% would be the exposure of the half that was measurable,
      // printed where the reader expects the total.
      expect(math.marketExposurePercent).toBeNull();
      expect(math.exactTargetPercent).toBe(0);
    });
  });

  describe("exact allocation versus estimated exposure", () => {
    /** The signal names EMIM, described by its country split. */
    const emim = {
      securityId: "sec-emim",
      composition: {
        COUNTRY: [
          { name: "China", weight: 0.5 },
          { name: "India", weight: 0.5 },
        ],
        ASSET_CLASS: null,
        SECTOR: null,
      },
    };
    /** The same target, with nothing recorded about what it holds. */
    const undescribed = { securityId: "sec-emim", composition: EMPTY_COMPOSITION };

    const worldish = (symbol: string, marketValue: number) =>
      holding({
        role: null,
        securityId: `sec-${symbol.toLowerCase()}`,
        symbol,
        marketValue,
        composition: {
          COUNTRY: [
            { name: "United States", weight: 0.8 },
            { name: "China", weight: 0.2 },
          ],
          ASSET_CLASS: null,
          SECTOR: null,
        },
      });

    it("A: none of the target held and no way to estimate exposure", () => {
      const math = buildPositionMath(
        [
          holding({ role: null, securityId: "sec-iusq", symbol: "IUSQ", marketValue: 4000 }),
          holding({ role: null, securityId: "sec-vwra", symbol: "VWRA", marketValue: 3000 }),
          holding({ role: null, securityId: "sec-wtai", symbol: "WTAI", marketValue: 2000 }),
          holding({ role: null, securityId: "sec-aggg", symbol: "AGGG", marketValue: 1000 }),
        ],
        "EM_EQUITY",
        undescribed,
      );

      expect(math.exactTargetPercent).toBe(0);
      expect(math.changeRequired).toBe(true);
      expect(math.sold.map((entry) => entry.symbol)).toEqual([
        "IUSQ",
        "VWRA",
        "WTAI",
        "AGGG",
      ]);
      // Unknown, not four confident zeroes beside four funds nobody measured.
      expect(math.marketExposurePercent).toBeNull();
      expect(math.marketExposureAvailable).toBe(false);
      expect(math.holdings.map((entry) => entry.overlap)).toEqual([
        null,
        null,
        null,
        null,
      ]);
    });

    it("B: none of the target held, but the exposure can be estimated", () => {
      const math = buildPositionMath(
        [worldish("IUSQ", 6000), worldish("VWRA", 4000)],
        "EM_EQUITY",
        emim,
      );

      // A fifth of each fund is in the target's markets.
      expect(math.marketExposurePercent).toBe(20);
      expect(math.marketExposureAvailable).toBe(true);
      // And none of it is the instrument the signal named, so all of it goes.
      expect(math.exactTargetPercent).toBe(0);
      expect(math.changeRequired).toBe(true);
      expect(math.sold.map((entry) => entry.symbol)).toEqual(["IUSQ", "VWRA"]);
      expect(math.transferValue).toBe(10000);
    });

    it("C: the target plus other holdings keeps the target and sells the rest", () => {
      const math = buildPositionMath(
        [
          holding({
            role: "EM_EQUITY",
            securityId: "sec-emim",
            symbol: "EMIM",
            marketValue: 5000,
          }),
          worldish("IUSQ", 3000),
          worldish("AGGG", 2000),
        ],
        "EM_EQUITY",
        emim,
      );

      expect(math.exactTargetPercent).toBe(50);
      expect(math.changeRequired).toBe(true);
      expect(math.sold.map((entry) => entry.symbol)).toEqual(["IUSQ", "AGGG"]);
      expect(math.transferValue).toBe(5000);
    });

    it("D: only the target held is the finished state", () => {
      const math = buildPositionMath(
        [
          holding({
            role: "EM_EQUITY",
            securityId: "sec-emim",
            symbol: "EMIM",
            marketValue: 5000,
          }),
        ],
        "EM_EQUITY",
        emim,
      );

      expect(math.exactTargetPercent).toBe(100);
      expect(math.changeRequired).toBe(false);
      expect(math.sold).toEqual([]);
      expect(math.transferValue).toBeNull();
    });

    it("keeps the exposure estimate out of every operational decision", () => {
      // A fund 90% in the target's markets is nine tenths of the way to the
      // exposure and none of the way to the instruction. It is sold whole, at
      // its full value, and the operation is not complete.
      const math = buildPositionMath(
        [
          holding({
            role: null,
            securityId: "sec-almost",
            symbol: "ALMOST",
            marketValue: 10000,
            costBasis: 4000,
            composition: {
              COUNTRY: [
                { name: "China", weight: 0.45 },
                { name: "India", weight: 0.45 },
                { name: "Japan", weight: 0.1 },
              ],
              ASSET_CLASS: null,
              SECTOR: null,
            },
          }),
        ],
        "EM_EQUITY",
        emim,
      );

      expect(math.marketExposurePercent).toBe(90);
      expect(math.exactTargetPercent).toBe(0);
      expect(math.changeRequired).toBe(true);
      expect(math.transferValue).toBe(10000);
      expect(math.realizedGainLoss).toBeCloseTo(6000, 4);
    });
  });

  describe("estimateTax", () => {
    it("taxes a gain at the configured rate", () => {
      expect(estimateTax(4794.9, 19)).toBeCloseTo(911.031, 3);
    });

    it("owes nothing on a loss", () => {
      expect(estimateTax(-500, 19)).toBe(0);
    });

    it("is unknown without a gain figure or a rate", () => {
      expect(estimateTax(null, 19)).toBeNull();
      expect(estimateTax(1000, null)).toBeNull();
    });
  });

  describe("estimateCommission", () => {
    it("charges one commission per trade the switch takes", () => {
      // Three holdings to sell out of plus the target to buy: four trades.
      expect(estimateCommission(29.9, 3)).toBeCloseTo(119.6, 4);
      expect(estimateCommission(29.9, 1)).toBeCloseTo(59.8, 4);
    });

    it("charges one commission for a first purchase", () => {
      expect(estimateCommission(29.9, 0)).toBeCloseTo(29.9, 4);
    });

    it("is unknown without a configured commission", () => {
      expect(estimateCommission(null, 3)).toBeNull();
    });

    it("is described as per trade everywhere the field is named", () => {
      // The stored amount is charged once per trade, so any copy calling it
      // "per switch" contradicts the arithmetic above -- and understates
      // exactly the switches that cost the most, which is the direction that
      // matters. The frontend half of this contract lives in
      // `GemTransferCard.test.tsx`, which pins the settings label and the
      // displayed estimate together.
      const sources = [
        "dto/update-gem-strategy.dto.ts",
        "dto/create-gem-strategy.dto.ts",
        "entities/gem-strategy.entity.ts",
        "gem-report.types.ts",
      ].map((file) => readFileSync(join(__dirname, file), "utf8"));

      for (const source of sources) {
        expect(source).not.toMatch(/commission[^\n]*per switch/i);
      }
    });
  });
});
