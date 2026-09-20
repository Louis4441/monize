import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ExchangeRateHistoryService,
  STORED_RATE_ROW_CAP,
} from "@/currencies/exchange-rate-history.service";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { UserPreference } from "@/users/entities/user-preference.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The pair's two reads against a real PostgreSQL database.
 *
 * The unit suite drives `manager.query` through a mock, so only this test
 * exercises the SQL itself: that the two stored directions of a pair are read
 * as one pair, that `observations` counts calendar days rather than the rows,
 * that a date a pre-collapse writer left in both orientations is listed once,
 * and that dates come back as `YYYY-MM-DD` strings in every process time zone
 * rather than as whatever the DATE parser would have made of them.
 */
describe("ExchangeRateHistoryService reads (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: ExchangeRateHistoryService;
  let userId: string;

  /** Never called here: this spec is about the read, not the provider. */
  const exchangeRateService = {
    fillRateWindow: jest.fn(),
  } as unknown as ExchangeRateService;

  const insertRate = (
    from: string,
    to: string,
    date: string,
    rate: string,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ($1, $2, $3::DATE, $4, 'test')`,
      [from, to, date, rate],
    );

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    service = new ExchangeRateHistoryService(dataSource, exchangeRateService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "exchange_rates",
      "user_preferences",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    await dataSource.manager.save(
      dataSource.manager.create(UserPreference, {
        userId,
        defaultCurrency: "PLN",
      }),
    );
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('EUR', 'Euro', 'E', 2, true), ('PLN', 'Zloty', 'z', 2, true),
              ('USD', 'Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
  });

  it("reads both stored directions as one pair and counts days, not rows", async () => {
    // What a fetch actually writes: each day forwards and inverted.
    await insertRate("EUR", "PLN", "2026-01-02", "4.3000000000");
    await insertRate("PLN", "EUR", "2026-01-02", "0.2325581395");
    await insertRate("EUR", "PLN", "2026-06-19", "4.2500000000");
    await insertRate("PLN", "EUR", "2026-06-19", "0.2352941176");
    // A row about a different pair must not reach this answer.
    await insertRate("EUR", "EUR", "2026-07-01", "1.0000000000");

    const coverage = await withUserContext(userId, () =>
      service.getCoverage(userId, "EUR"),
    );

    expect(coverage).toEqual({
      from: "EUR",
      to: "PLN",
      earliestDate: "2026-01-02",
      latestDate: "2026-06-19",
      observations: 2,
    });
  });

  it("reports null bounds for a pair with no rows at all", async () => {
    const coverage = await withUserContext(userId, () =>
      service.getCoverage(userId, "EUR"),
    );

    expect(coverage).toEqual({
      from: "EUR",
      to: "PLN",
      earliestDate: null,
      latestDate: null,
      observations: 0,
    });
  });

  it("finds a pair stored only in the reverse direction", async () => {
    await insertRate("PLN", "EUR", "2025-12-31", "0.2325581395");

    const coverage = await withUserContext(userId, () =>
      service.getCoverage(userId, "EUR"),
    );

    expect(coverage.earliestDate).toBe("2025-12-31");
    expect(coverage.observations).toBe(1);
  });

  describe("getStoredRates", () => {
    it("lists a date held in both orientations once, keeping the canonical row", async () => {
      // What a pre-collapse writer left behind: two rows for one date that are
      // not reciprocal. The canonical orientation is the one every writer
      // maintains now, and the one the contract migration keeps.
      await insertRate("EUR", "PLN", "2026-01-02", "4.3000000000");
      await insertRate("PLN", "EUR", "2026-01-02", "0.9900000000");

      const list = await withUserContext(userId, () =>
        service.getStoredRates(userId, "EUR"),
      );

      expect(list.rates).toEqual([
        {
          rateDate: "2026-01-02",
          rate: 4.3,
          source: "test",
          inverted: false,
        },
      ]);
    });

    it("lists a pair stored the other way round as its reciprocal", async () => {
      // USD against PLN is stored canonically as PLN->USD, which is the reverse
      // of what a reader asking about USD wants.
      await insertRate("PLN", "USD", "2026-01-02", "0.2500000000");

      const list = await withUserContext(userId, () =>
        service.getStoredRates(userId, "USD"),
      );

      expect(list.rates).toEqual([
        {
          rateDate: "2026-01-02",
          rate: 4,
          source: "test",
          inverted: true,
        },
      ]);
    });

    it("returns whole dates, newest first, and nothing about another pair", async () => {
      await insertRate("EUR", "PLN", "2026-01-02", "4.3000000000");
      await insertRate("EUR", "PLN", "2026-06-19", "4.2500000000");
      await insertRate("EUR", "PLN", "2026-03-11", "4.2800000000");
      await insertRate("USD", "PLN", "2026-04-01", "3.9000000000");

      const list = await withUserContext(userId, () =>
        service.getStoredRates(userId, "EUR"),
      );

      expect(list.rates.map((rate) => rate.rateDate)).toEqual([
        "2026-06-19",
        "2026-03-11",
        "2026-01-02",
      ]);
      expect(list.truncated).toBe(false);
    });

    it("lists nothing for a pair with no rows at all", async () => {
      const list = await withUserContext(userId, () =>
        service.getStoredRates(userId, "EUR"),
      );

      expect(list).toEqual({
        from: "EUR",
        to: "PLN",
        rates: [],
        truncated: false,
        limit: STORED_RATE_ROW_CAP,
      });
    });
  });
});
