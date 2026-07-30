import { EntityManager } from "typeorm";
import {
  mnyExchangeRate,
  mnySecurityPrice,
} from "../__fixtures__/mny-row-builders";
import {
  MNY_PRICE_SOURCE,
  UPSERT_CHUNK_SIZE,
  dedupePrices,
  resolveExchangeRates,
  writeExchangeRates,
  writeSecurityPrices,
} from "./write-prices";

/**
 * Price and rate history is the largest thing a real Money file carries (68,000
 * `SP` rows in the maintainer's Money Plus file), so these two writers are the
 * ones whose statement shape matters: multi-row upserts on the natural key,
 * deduped before they get there because a `VALUES` list with a repeated
 * conflict key raises "cannot affect row a second time".
 */

const securityIds = new Map([
  [1, "ssssssss-0000-0000-0000-000000000001"],
  [2, "ssssssss-0000-0000-0000-000000000002"],
]);

function doubles() {
  const query = jest.fn().mockResolvedValue([]);
  const manager = { query } as unknown as EntityManager;
  return { manager, query };
}

describe("dedupePrices", () => {
  it("keeps the highest-handle row for a security and date", () => {
    const rows = dedupePrices(
      [
        mnySecurityPrice({
          handle: 1,
          security: 1,
          date: "2026-01-05",
          price: 10,
        }),
        mnySecurityPrice({
          handle: 9,
          security: 1,
          date: "2026-01-05",
          price: 12,
        }),
        mnySecurityPrice({
          handle: 4,
          security: 1,
          date: "2026-01-05",
          price: 11,
        }),
      ],
      securityIds,
    );

    expect(rows).toEqual([
      {
        securityId: securityIds.get(1),
        priceDate: "2026-01-05",
        closePrice: 12,
      },
    ]);
  });

  it("keeps distinct dates and securities apart", () => {
    const rows = dedupePrices(
      [
        mnySecurityPrice({ handle: 1, security: 1, date: "2026-01-05" }),
        mnySecurityPrice({ handle: 2, security: 1, date: "2026-01-06" }),
        mnySecurityPrice({ handle: 3, security: 2, date: "2026-01-05" }),
      ],
      securityIds,
    );

    expect(rows).toHaveLength(3);
  });

  it("drops rows with no date, no security or no price", () => {
    const rows = dedupePrices(
      [
        mnySecurityPrice({ handle: 1, date: null }),
        mnySecurityPrice({ handle: 2, security: null }),
        mnySecurityPrice({ handle: 3, price: 0 }),
        mnySecurityPrice({ handle: 4, price: -5 }),
      ],
      securityIds,
    );

    expect(rows).toEqual([]);
  });

  it("drops rows for a security that was not imported", () => {
    const rows = dedupePrices(
      [mnySecurityPrice({ security: 99 })],
      securityIds,
    );

    expect(rows).toEqual([]);
  });

  it("rounds to the column's six decimal places", () => {
    const rows = dedupePrices(
      [mnySecurityPrice({ security: 1, price: 1.2345678 })],
      securityIds,
    );

    expect(rows[0].closePrice).toBe(1.234568);
  });
});

describe("writeSecurityPrices", () => {
  it("upserts on (security, date) and marks the import as the source", async () => {
    const { manager, query } = doubles();

    const written = await writeSecurityPrices(
      manager,
      [mnySecurityPrice({ security: 1, date: "2026-01-05", price: 10 })],
      securityIds,
    );

    expect(written).toBe(1);
    expect(query.mock.calls[0][0]).toContain(
      "ON CONFLICT (security_id, price_date)",
    );
    expect(query.mock.calls[0][1]).toEqual([
      securityIds.get(1),
      "2026-01-05",
      10,
      MNY_PRICE_SOURCE,
    ]);
  });

  it("chunks a large history instead of building one giant statement", async () => {
    const { manager, query } = doubles();
    const prices = Array.from({ length: UPSERT_CHUNK_SIZE + 20 }, (_, index) =>
      mnySecurityPrice({
        handle: index,
        security: 1,
        date: `2026-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
      }),
    );

    await writeSecurityPrices(manager, prices, securityIds);

    for (const call of query.mock.calls) {
      expect(call[1].length).toBeLessThanOrEqual(UPSERT_CHUNK_SIZE * 4);
    }
  });

  it("issues no statement when nothing survives the dedupe", async () => {
    const { manager, query } = doubles();

    const written = await writeSecurityPrices(manager, [], securityIds);

    expect(written).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("reports progress after every chunk", async () => {
    const { manager } = doubles();
    const onProgress = jest.fn().mockResolvedValue(undefined);

    await writeSecurityPrices(
      manager,
      [
        mnySecurityPrice({ handle: 1, security: 1, date: "2026-01-05" }),
        mnySecurityPrice({ handle: 2, security: 1, date: "2026-01-06" }),
      ],
      securityIds,
      onProgress,
    );

    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });
});

describe("resolveExchangeRates", () => {
  const currencies = new Map([
    [1, "USD"],
    [2, "GBP"],
  ]);

  it("resolves handles into ISO codes", () => {
    const rows = resolveExchangeRates(
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0.79,
          date: "2026-01-05",
        }),
      ],
      currencies,
    );

    expect(rows).toEqual([
      {
        fromCurrency: "USD",
        toCurrency: "GBP",
        rate: 0.79,
        rateDate: "2026-01-05",
      },
    ]);
  });

  it("drops a self-rate, which is always 1 and only clutters lookups", () => {
    const rows = resolveExchangeRates(
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 1,
          rate: 1,
          date: "2026-01-05",
        }),
      ],
      currencies,
    );

    expect(rows).toEqual([]);
  });

  it("drops rows with no date, an unknown currency or a non-positive rate", () => {
    const rows = resolveExchangeRates(
      [
        mnyExchangeRate({ fromCurrency: 1, toCurrency: 2, date: null }),
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 99,
          date: "2026-01-05",
        }),
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0,
          date: "2026-01-05",
        }),
      ],
      currencies,
    );

    expect(rows).toEqual([]);
  });

  it("keeps the last row for a currency pair and date", () => {
    const rows = resolveExchangeRates(
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0.7,
          date: "2026-01-05",
        }),
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0.8,
          date: "2026-01-05",
        }),
      ],
      currencies,
    );

    expect(rows).toEqual([
      {
        fromCurrency: "USD",
        toCurrency: "GBP",
        rate: 0.8,
        rateDate: "2026-01-05",
      },
    ]);
  });
});

describe("writeExchangeRates", () => {
  it("upserts additively on the pair and date", async () => {
    const { manager, query } = doubles();

    const written = await writeExchangeRates(
      manager,
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0.79,
          date: "2026-01-05",
        }),
      ],
      new Map([
        [1, "USD"],
        [2, "GBP"],
      ]),
    );

    expect(written).toBe(1);
    expect(query.mock.calls[0][0]).toContain(
      "ON CONFLICT (from_currency, to_currency, rate_date)",
    );
    expect(query.mock.calls[0][1]).toEqual([
      "USD",
      "GBP",
      0.79,
      "2026-01-05",
      MNY_PRICE_SOURCE,
    ]);
  });

  it("issues no statement when the file has no usable rates", async () => {
    const { manager, query } = doubles();

    expect(await writeExchangeRates(manager, [], new Map())).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
