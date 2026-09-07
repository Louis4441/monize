import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSecurityDto } from "../securities/dto/create-security.dto";
import {
  SecurityPriceAlertService,
  priceMovement,
} from "./security-price-alert.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  NotificationType,
  NotificationCategory,
  notificationCategoryOf,
} from "./entities/notification.entity";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
const today = "2026-09-07";
const prices = (
  latest: string | number = 110,
  previous: string | number = 100,
) => [
  { price_date: today, close_price: latest },
  { price_date: "2026-09-04", close_price: previous },
];
describe("security price movement", () => {
  it.each([
    [110, 10],
    [90, -10],
  ])("fires at the exact threshold in either direction", (price, expected) => {
    expect(priceMovement(prices(price), 10, today)).toBe(expected);
  });
  it("includes a decimal threshold boundary without admitting a meaningful shortfall", () => {
    expect(priceMovement(prices("100.1"), 0.1, today)).toBeCloseTo(0.1, 10);
    expect(priceMovement(prices("100.09999"), 0.1, today)).toBeNull();
  });
  it("compares stored decimal strings and skips a non-trading weekend", () => {
    expect(priceMovement(prices("110.00", "100.00"), 5, today)).toBe(10);
  });
  it.each([0, -1, Infinity, NaN])(
    "withholds invalid latest prices %s",
    (value) => {
      expect(priceMovement(prices(value), 5, today)).toBeNull();
      expect(priceMovement(prices(110, value), 5, today)).toBeNull();
    },
  );
  it.each([0, 0.01, 1001, NaN, Infinity])(
    "rejects invalid threshold %s",
    (value) => {
      expect(priceMovement(prices(), value, today)).toBeNull();
    },
  );
  it("withholds insufficient, stale, future and same-day comparisons", () => {
    expect(priceMovement([], 5, today)).toBeNull();
    expect(priceMovement(prices().slice(0, 1), 5, today)).toBeNull();
    expect(priceMovement(prices(), 5, "2026-09-08")).toBeNull();
    expect(priceMovement(prices(), 5, "2026-09-06")).toBeNull();
    expect(priceMovement([prices()[0], prices()[0]], 5, today)).toBeNull();
    expect(priceMovement(prices(101), 5, today)).toBeNull();
  });
  it("belongs to the existing Investments channel matrix", () => {
    expect(
      notificationCategoryOf(NotificationType.SECURITY_PRICE_MOVEMENT),
    ).toBe(NotificationCategory.INVESTMENTS);
  });
  it.each([null, undefined, 0.1, 1000, 5.5])(
    "accepts an opt-out or valid threshold %s",
    async (priceAlertPercent) => {
      const dto = plainToInstance(CreateSecurityDto, {
        symbol: "AAPL",
        name: "Apple",
        currencyCode: "USD",
        priceAlertPercent,
      });
      expect(
        (await validate(dto)).filter((e) => e.property === "priceAlertPercent"),
      ).toEqual([]);
    },
  );
  it.each(["5", 0, -5, 1001, NaN, Infinity])(
    "rejects invalid API configuration %s",
    async (priceAlertPercent) => {
      const dto = plainToInstance(CreateSecurityDto, { priceAlertPercent });
      expect(
        (await validate(dto)).some((e) => e.property === "priceAlertPercent"),
      ).toBe(true);
    },
  );
});

describe("security price alert producer", () => {
  const user = "11111111-1111-4111-8111-111111111111";
  const security = "22222222-2222-4222-8222-222222222222";
  const setup = () => {
    const { dataSource, manager } = createScopedDbMocks([]);
    const notify = jest.fn().mockResolvedValue({ id: "written" });
    const service = new SecurityPriceAlertService(
      dataSource as any,
      { notify } as any,
    );
    return { manager, notify, service };
  };
  it("addresses the owner, persists facts and a security deep link, and uses stable per-day dedupe", async () => {
    const { manager, notify, service } = setup();
    manager.query
      .mockResolvedValueOnce([
        { symbol: "AAPL", currency_code: "USD", price_alert_percent: 5 },
      ])
      .mockResolvedValueOnce(prices());
    await service.evaluate(user, security, today);
    expect(manager.query.mock.calls[0][0]).toContain("user_id = $2");
    expect(manager.query.mock.calls[0][1]).toEqual([security, user]);
    expect(notify).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        type: NotificationType.SECURITY_PRICE_MOVEMENT,
        target: `/securities/${security}`,
        dedupeKey: `security-price:${security}:${today}`,
        data: expect.objectContaining({
          securityId: security,
          symbol: "AAPL",
          changePercent: 10,
          price: 110,
          previousPrice: 100,
        }),
      }),
      { collapseKey: `security-price:${security}` },
    );
  });
  it("does nothing when the owner's active opt-in no longer exists", async () => {
    const { manager, notify, service } = setup();
    manager.query.mockResolvedValueOnce([]);
    await service.evaluate(user, security, today);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
  it("does not send for an incomplete price pair", async () => {
    const { manager, notify, service } = setup();
    manager.query
      .mockResolvedValueOnce([{ price_alert_percent: 5 }])
      .mockResolvedValueOnce([]);
    await service.evaluate(user, security, today);
    expect(notify).not.toHaveBeenCalled();
  });
  it("scans with keyset pagination and evaluates each security in its owner's context", async () => {
    const { manager, service } = setup();
    manager.query
      .mockResolvedValueOnce([{ id: security, user_id: user }])
      .mockResolvedValueOnce([]);
    const evaluate = jest.spyOn(service, "evaluate").mockResolvedValue();
    await service.run();
    expect(evaluate).toHaveBeenCalledWith(
      user,
      security,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    expect(manager.query.mock.calls[1][1]).toEqual([security]);
  });
});
