import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ExchangeRateHistoryService } from "@/currencies/exchange-rate-history.service";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { UserPreference } from "@/users/entities/user-preference.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The coverage aggregate against a real PostgreSQL database.
 *
 * The unit suite drives `manager.query` through a mock, so only this test
 * exercises the SQL itself: that the two stored directions of a pair are read
 * as one pair, that `observations` counts calendar days rather than the rows
 * (each fetch writes two), and that the bounds come back as `YYYY-MM-DD`
 * strings in every process time zone rather than as whatever the DATE parser
 * would have made of them.
 */
describe("ExchangeRateHistoryService.getCoverage (integration)", () => {
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
       VALUES ('EUR', 'Euro', 'E', 2, true), ('PLN', 'Zloty', 'z', 2, true)
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
});
