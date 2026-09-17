import { PortfolioMovementAlertService } from "./portfolio-movement-alert.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NotificationType } from "./entities/notification.entity";
import type {
  HoldingWithMarketValue,
  PortfolioService,
  PortfolioSummary,
} from "../securities/portfolio.service";
import type { ExchangeRateService } from "../currencies/exchange-rate.service";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
  withUserContext: jest.fn((_userId: string, fn: () => unknown) => fn()),
}));
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: () => "2026-09-14",
}));

/** Monday; the baseline was captured on the previous Friday. */
const TODAY = "2026-09-14";
const FRIDAY = "2026-09-11";
const SATURDAY = "2026-09-12";
const USER = "11111111-1111-4111-8111-111111111111";
const SECURITY = "22222222-2222-4222-8222-222222222222";

/**
 * A held position as `getPortfolioSummary().holdings` reports one. Typed to the
 * real interface, so a field the producer starts reading cannot be invented
 * here without `tsc` noticing it is not one the service could have received.
 */
const holding = (
  over: Partial<HoldingWithMarketValue> = {},
): HoldingWithMarketValue => ({
  id: "h1",
  accountId: "a1",
  securityId: SECURITY,
  symbol: "VTI",
  name: "Vanguard Total Market",
  securityType: "ETF",
  currencyCode: "USD",
  quantity: 100,
  averageCost: 200,
  costBasis: 20_000,
  costBasisAccountCurrency: 20_000,
  currentPrice: 250,
  marketValue: 25_000,
  gainLoss: 5_000,
  gainLossPercent: 25,
  ...over,
});

const summaryOf = (over: Partial<PortfolioSummary> = {}): PortfolioSummary => ({
  totalCashValue: 0,
  totalHoldingsValue: 100_000,
  totalCostBasis: 80_000,
  totalNetInvested: 80_000,
  totalPortfolioValue: 100_000,
  totalGainLoss: 20_000,
  totalGainLossPercent: 25,
  timeWeightedReturn: null,
  cagr: null,
  fxComplete: true,
  missingRatePairs: [],
  pricesComplete: true,
  unpricedSecurityIds: [],
  valuationComplete: true,
  holdings: [holding()],
  holdingsByAccount: [],
  allocation: [],
  ...over,
});

/** One row of `notification_portfolio_state`, as the producer's SELECT reads it. */
interface StateRow {
  move_alert_percent: string | null;
  baseline_value: string | null;
  baseline_currency: string | null;
  baseline_captured_on: string | null;
}

const stateOf = (over: Partial<StateRow> = {}): StateRow => ({
  move_alert_percent: "5",
  baseline_value: "100000",
  baseline_currency: "USD",
  baseline_captured_on: FRIDAY,
  ...over,
});

/** One row of the external-flow subtotal query, in the shape the SQL returns. */
interface FlowRow {
  date: string | null;
  currency: string;
  total: string;
}

interface Scenario {
  summary?: PortfolioSummary;
  state?: StateRow | null;
  flows?: FlowRow[];
  /** `currency@date` -> rate into the reporting currency, or null for none. */
  rates?: Record<string, number | null>;
  /** securityId -> the date of the observation that priced it. */
  priceDates?: Record<string, string>;
  currency?: string;
}

function setup(scenario: Scenario = {}) {
  const currency = scenario.currency ?? "USD";
  const { dataSource, manager } = createScopedDbMocks([
    [UserPreference, { findOne: jest.fn().mockResolvedValue(null) }],
  ]);

  const baselineWrites: Array<{ value: number; currency: string; on: string }> =
    [];
  const flowStatements: string[] = [];

  manager.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT user_id FROM notification_portfolio_state")) {
      return [{ user_id: USER }];
    }
    if (sql.includes("default_currency")) {
      return [{ default_currency: currency }];
    }
    if (sql.includes("TO_CHAR(baseline_captured_on")) {
      const state = scenario.state === undefined ? stateOf() : scenario.state;
      return state === null ? [] : [state];
    }
    if (sql.includes("FROM transactions t")) {
      flowStatements.push(sql);
      return scenario.flows ?? [];
    }
    if (sql.includes("INSERT INTO notification_portfolio_state")) {
      const [, value, ccy, on] = params as [string, number, string, string];
      baselineWrites.push({ value, currency: ccy, on });
      return [];
    }
    throw new Error(`unexpected statement: ${sql}`);
  });

  const getPortfolioSummary = jest
    .fn<Promise<PortfolioSummary>, [string, string[]?]>()
    .mockResolvedValue(scenario.summary ?? summaryOf());
  const getLatestPriceObservations = jest
    .fn<Promise<Map<string, { close: number; date: string }>>, [string[]]>()
    .mockImplementation(async (ids) => {
      const dates = scenario.priceDates ?? { [SECURITY]: TODAY };
      return new Map(
        ids
          .filter((id) => dates[id] !== undefined)
          .map((id) => [id, { close: 250, date: dates[id] }]),
      );
    });
  const getRateForDate = jest
    .fn<Promise<number | null>, [string, string, string | Date]>()
    .mockImplementation(async (from, _to, on) => {
      const rates = scenario.rates ?? {};
      const key = `${from}@${String(on)}`;
      return key in rates ? rates[key] : null;
    });
  const notify = jest.fn().mockResolvedValue({ id: "written" });

  const service = new PortfolioMovementAlertService(
    dataSource as never,
    { getPortfolioSummary, getLatestPriceObservations } as Pick<
      PortfolioService,
      "getPortfolioSummary" | "getLatestPriceObservations"
    > as PortfolioService,
    { getRateForDate } as Pick<
      ExchangeRateService,
      "getRateForDate"
    > as ExchangeRateService,
    { notify } as Pick<
      NotificationDispatchService,
      "notify"
    > as NotificationDispatchService,
  );

  return {
    service,
    notify,
    baselineWrites,
    flowStatements,
    getRateForDate,
    getLatestPriceObservations,
  };
}

describe("PortfolioMovementAlertService", () => {
  it("converts a weekend deposit at its own day's rate, not the run day's", async () => {
    // INV-PORTMOVE-007. A 1,000 CAD deposit landed on Saturday at 0.70; by
    // Monday the pair is 0.80. At Saturday's rate the deposit is 700 USD and the
    // portfolio moved nothing; at Monday's it is 800 and the producer would
    // report a -100 "market loss" that is purely the weekend's FX move.
    const { service, notify, baselineWrites, getRateForDate, flowStatements } =
      setup({
        summary: summaryOf({ totalPortfolioValue: 100_700 }),
        flows: [{ date: SATURDAY, currency: "CAD", total: "1000" }],
        rates: { [`CAD@${SATURDAY}`]: 0.7, [`CAD@${TODAY}`]: 0.8 },
      });

    await service.run();

    expect(getRateForDate).toHaveBeenCalledWith("CAD", "USD", SATURDAY);
    expect(getRateForDate).not.toHaveBeenCalledWith("CAD", "USD", TODAY);
    // movement = 100,700 - 100,000 - 700 = 0 -> nothing to report, rebaseline.
    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([
      { value: 100_700, currency: "USD", on: TODAY },
    ]);
    // The subtotals have to arrive dated, or there is no day to price at.
    expect(flowStatements[0]).toContain("t.transaction_date::TEXT AS date");
    expect(flowStatements[0]).toContain(
      "GROUP BY t.transaction_date, t.currency_code",
    );
  });

  it("withholds and does not advance the baseline when one flow day has no rate", async () => {
    // INV-PORTMOVE-001/002: an unconvertible contribution makes the movement
    // unknown. Not 0, not the unconverted amount, and not a new baseline -- a
    // baseline taken on an unknown run makes the NEXT comparison wrong too.
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({ totalPortfolioValue: 120_000 }),
      flows: [
        { date: SATURDAY, currency: "CAD", total: "1000" },
        { date: TODAY, currency: "CAD", total: "1000" },
      ],
      rates: { [`CAD@${TODAY}`]: 0.8, [`CAD@${SATURDAY}`]: null },
    });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([]);
  });

  it("withholds when a held position's latest close predates the baseline", async () => {
    // INV-PORTMOVE-008, the 94% component of the issue: the position's value is
    // carried from June, so today's total is not evidence about this period, and
    // the run in which its price lands would book the catch-up as a market move.
    const { service, notify, baselineWrites, getLatestPriceObservations } =
      setup({
        summary: summaryOf({ totalPortfolioValue: 194_000 }),
        priceDates: { [SECURITY]: "2026-06-30" },
      });

    await service.run();

    expect(getLatestPriceObservations).toHaveBeenCalledWith([SECURITY]);
    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([]);
  });

  it("fires once and re-baselines on a complete run over the threshold", async () => {
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({ totalPortfolioValue: 92_000 }),
    });

    await service.run();

    expect(notify).toHaveBeenCalledTimes(1);
    const [recipient, written] = notify.mock.calls[0];
    expect(recipient).toBe(USER);
    expect(written).toMatchObject({
      type: NotificationType.PORTFOLIO_MOVEMENT,
      target: "/investments",
      dedupeKey: `portmove:USD:${TODAY}`,
    });
    // The payload identifies what was measured and over which period, so a
    // reader can reproduce the figure rather than take it on trust.
    expect(written.data).toEqual({
      changePercent: -8,
      direction: "down",
      movementValue: -8_000,
      baselineValue: 100_000,
      currentValue: 92_000,
      externalFlow: 0,
      baselineDate: FRIDAY,
      valuationDate: TODAY,
      currencyCode: "USD",
    });
    expect(written.message).toContain(FRIDAY);
    expect(written.message).toContain(TODAY);
    expect(baselineWrites).toEqual([
      { value: 92_000, currency: "USD", on: TODAY },
    ]);
  });

  it("does not fire on a deposit-only day, and still re-baselines", async () => {
    // The requester's actual requirement (INV-PORTMOVE-006): a 20,000 deposit
    // raised the total by 20,000 and the market did nothing.
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({ totalPortfolioValue: 120_000 }),
      flows: [{ date: TODAY, currency: "USD", total: "20000" }],
    });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([
      { value: 120_000, currency: "USD", on: TODAY },
    ]);
  });

  it("captures a first baseline without asking for a flow or a price date", async () => {
    const { service, notify, baselineWrites, flowStatements } = setup({
      state: stateOf({ baseline_value: null, baseline_captured_on: null }),
    });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(flowStatements).toEqual([]);
    expect(baselineWrites).toEqual([
      { value: 100_000, currency: "USD", on: TODAY },
    ]);
  });

  it("withholds everything, including the baseline, on an incomplete valuation", async () => {
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({
        totalPortfolioValue: 110_000,
        pricesComplete: false,
        valuationComplete: false,
        unpricedSecurityIds: [SECURITY],
      }),
    });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([]);
  });
});
