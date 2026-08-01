import { Security } from "../securities/entities/security.entity";
import { GemBackfillService } from "./gem-backfill.service";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: () => "2025-08-14",
}));

const userId = "user-1";

describe("GemBackfillService", () => {
  let service: GemBackfillService;
  let manager: ManagerMock;
  let securityRepo: Record<string, jest.Mock>;
  let priceService: { earliestPriceDates: jest.Mock };
  let securityPrices: { backfillSecurityRange: jest.Mock };

  const security = (id: string, overrides: Partial<Security> = {}) =>
    ({
      id,
      userId,
      symbol: id.toUpperCase(),
      historicalBackfillAttemptedAt: null,
      ...overrides,
    }) as Security;

  beforeEach(() => {
    securityRepo = {
      find: jest.fn().mockResolvedValue([security("spy")]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const mocks = createScopedDbMocks([[Security, securityRepo]]);
    manager = mocks.manager;
    priceService = {
      earliestPriceDates: jest.fn().mockResolvedValue(new Map()),
    };
    securityPrices = {
      backfillSecurityRange: jest.fn().mockResolvedValue(500),
    };
    service = new GemBackfillService(
      mocks.dataSource as never,
      priceService as never,
      securityPrices as never,
    );
  });

  it("fetches history for a security that has never been priced", async () => {
    const fetched = await service.ensureHistory(userId, ["spy"], 12, "MONTHLY");

    expect(fetched).toEqual(["spy"]);
    // 12 months of momentum plus the 24 periods the history table shows.
    expect(securityPrices.backfillSecurityRange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "spy" }),
      "5y",
    );
    // The attempt is stamped so a save moments later does not refetch, and the
    // write is scoped to the owner like every other one in this module.
    expect(securityRepo.update).toHaveBeenCalledWith(
      { id: expect.anything(), userId },
      { historicalBackfillAttemptedAt: expect.any(Date) },
    );
  });

  it("fetches deeper history for a long momentum window", async () => {
    await service.ensureHistory(userId, ["spy"], 60, "MONTHLY");
    expect(securityPrices.backfillSecurityRange).toHaveBeenCalledWith(
      expect.anything(),
      "10y",
    );
  });

  it("reaches back three times as far for a quarterly strategy", async () => {
    // 24 history periods are 24 months monthly but 72 quarterly, so the
    // quarterly strategy needs a deeper provider range or its oldest periods
    // never get prices.
    await service.ensureHistory(userId, ["spy"], 12, "QUARTERLY");
    expect(securityPrices.backfillSecurityRange).toHaveBeenCalledWith(
      expect.anything(),
      "10y",
    );
  });

  it("counts a monthly strategy's history in single months", async () => {
    await service.ensureHistory(userId, ["spy"], 12, "MONTHLY");
    expect(securityPrices.backfillSecurityRange).toHaveBeenCalledWith(
      expect.anything(),
      "5y",
    );
  });

  it("leaves a security whose history already reaches back far enough", async () => {
    priceService.earliestPriceDates.mockResolvedValue(
      new Map([["spy", "2015-01-02"]]),
    );
    const fetched = await service.ensureHistory(userId, ["spy"], 12, "MONTHLY");

    expect(fetched).toEqual([]);
    expect(securityPrices.backfillSecurityRange).not.toHaveBeenCalled();
    expect(manager.getRepository).not.toHaveBeenCalled();
  });

  it("fetches for a security priced only since last month", async () => {
    priceService.earliestPriceDates.mockResolvedValue(
      new Map([["spy", "2025-07-01"]]),
    );
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      ["spy"],
    );
  });

  it("respects the provider cooldown", async () => {
    securityRepo.find.mockResolvedValue([
      security("spy", { historicalBackfillAttemptedAt: new Date() }),
    ]);
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      [],
    );
    expect(securityPrices.backfillSecurityRange).not.toHaveBeenCalled();
  });

  it("retries once the cooldown has passed", async () => {
    securityRepo.find.mockResolvedValue([
      security("spy", {
        historicalBackfillAttemptedAt: new Date(Date.now() - 24 * 3600 * 1000),
      }),
    ]);
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      ["spy"],
    );
  });

  it("survives a provider failure so the save still completes", async () => {
    securityPrices.backfillSecurityRange.mockRejectedValue(
      new Error("provider unavailable"),
    );
    // The report warns about the incomplete history; the save does not fail.
    await expect(
      service.ensureHistory(userId, ["spy"], 12, "MONTHLY"),
    ).resolves.toEqual(["spy"]);
    expect(securityRepo.update).toHaveBeenCalled();
  });

  it("does nothing without securities", async () => {
    expect(await service.ensureHistory(userId, [], 12, "MONTHLY")).toEqual([]);
    expect(priceService.earliestPriceDates).not.toHaveBeenCalled();
  });

  it("only touches the caller's own securities", async () => {
    await service.ensureHistory(userId, ["spy", "spy"], 12, "MONTHLY");
    expect(securityRepo.find).toHaveBeenCalledWith({
      where: { id: expect.anything(), userId },
    });
  });
});
