import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ScheduledOccurrenceService } from "./scheduled-occurrence.service";
import { ScheduledEffectiveAmountService } from "./scheduled-effective-amount.service";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import {
  createInvestmentFxMock,
  InvestmentFxMock,
} from "../test-helpers/investment-fx-testing";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * The issue's worked example, as a schedule: 10 units at 100, pinned at 1.50
 * while the security was priced in EUR, so the persisted amount is -1,500 CAD.
 * With the security now in USD at 1.35 the occurrence posts -1,350 CAD.
 */
const investmentSchedule = (
  overrides: Partial<ScheduledTransaction> = {},
): ScheduledTransaction =>
  ({
    id: "st-inv",
    userId: "user-1",
    accountId: "brokerage-1",
    name: "Monthly ETF buy",
    amount: -1000,
    currencyCode: "CAD",
    frequency: "MONTHLY",
    nextDueDate: "2026-03-15",
    endDate: null,
    occurrencesRemaining: null,
    isActive: true,
    isSplit: false,
    isTransfer: false,
    transferAccountId: null,
    isInvestment: true,
    investmentAction: "BUY",
    investmentSecurityId: "SEC-1",
    investmentQuantity: 10,
    investmentPrice: 100,
    investmentCommission: 0,
    investmentExchangeRate: 1.5,
    investmentExchangeRateFromCurrency: "EUR",
    investmentExchangeRateToCurrency: "CAD",
    splits: [],
    ...overrides,
  }) as unknown as ScheduledTransaction;

describe("ScheduledOccurrenceService", () => {
  let service: ScheduledOccurrenceService;
  let scheduledRepo: Record<string, jest.Mock>;
  let overridesRepo: Record<string, jest.Mock>;
  let dataSource: DataSourceMock;
  let fx: InvestmentFxMock;

  const userId = "user-1";

  /** The 5-unit re-price of one occurrence: half the shares, so -675 CAD. */
  const halfSizeOverride = (
    originalDate: string,
    overrideDate = originalDate,
  ) =>
    ({
      id: "ovr-1",
      scheduledTransactionId: "st-inv",
      originalDate,
      overrideDate,
      amount: null,
      investmentQuantity: 5,
      investmentPrice: 100,
      investmentCommission: 0,
    }) as unknown as ScheduledTransactionOverride;

  beforeEach(async () => {
    scheduledRepo = { createQueryBuilder: jest.fn() };
    overridesRepo = { find: jest.fn().mockResolvedValue([]) };
    ({ dataSource } = createScopedDbMocks([
      [ScheduledTransaction, scheduledRepo as never],
      [ScheduledTransactionOverride, overridesRepo as never],
    ]));
    // The security is USD now, and USD -> CAD is 1.35 -- the state that makes the
    // persisted 1.50 snapshot wrong.
    fx = createInvestmentFxMock();
    fx.resolveSettlementCurrencyPair.mockResolvedValue({
      from: "USD",
      to: "CAD",
    });
    fx.resolveCashExchangeRateOrNull.mockResolvedValue(1.35);
    fx.resolveSettlementAccountId.mockResolvedValue("cash-1");

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledOccurrenceService,
        // The real resolver over a stubbed FX source: the amounts asserted here
        // ARE its output, so a double of it would test nothing.
        ScheduledEffectiveAmountService,
        { provide: InvestmentTransactionsService, useValue: fx },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(ScheduledOccurrenceService);
  });

  it("prices every occurrence at the current rate, never the persisted snapshot", async () => {
    const occurrences = await service.expand(userId, [investmentSchedule()], {
      through: "2026-04-30",
    });

    expect(occurrences.map((o) => o.dueDate)).toEqual([
      "2026-03-15",
      "2026-04-15",
    ]);
    expect(occurrences.every((o) => o.amount === -1350)).toBe(true);
    expect(occurrences.every((o) => o.amount !== -1500)).toBe(true);
    expect(occurrences.every((o) => o.complete)).toBe(true);
    expect(occurrences[0].currencyCode).toBe("CAD");
    // The cash settles in the linked cash account, not the brokerage.
    expect(occurrences[0].settlementAccountId).toBe("cash-1");
  });

  it("gives the overridden occurrence the override's amount and the rest the base", async () => {
    overridesRepo.find.mockResolvedValue([halfSizeOverride("2026-03-15")]);

    const occurrences = await service.expand(userId, [investmentSchedule()], {
      through: "2026-04-30",
    });

    expect(occurrences[0]).toMatchObject({
      originalDate: "2026-03-15",
      dueDate: "2026-03-15",
      amount: -675,
      overrideId: "ovr-1",
      moved: false,
      complete: true,
    });
    expect(occurrences[1]).toMatchObject({
      dueDate: "2026-04-15",
      amount: -1350,
      overrideId: null,
    });
  });

  /**
   * The identity is `originalDate`, so a moved occurrence must still be priced
   * from its override -- and reported on the date it actually falls on. Keying
   * the lookup on `overrideDate` (the budget alert path's mistake) silently
   * returns the base amount here.
   */
  it("keeps the override when it also moved the occurrence", async () => {
    overridesRepo.find.mockResolvedValue([
      halfSizeOverride("2026-03-15", "2026-03-28"),
    ]);

    const occurrences = await service.expand(userId, [investmentSchedule()], {
      through: "2026-03-31",
    });

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      originalDate: "2026-03-15",
      dueDate: "2026-03-28",
      amount: -675,
      moved: true,
    });
  });

  /**
   * An override the resolver could not price reads as `null`, which is NOT the
   * same as "this occurrence has no override" -- and substituting the base amount
   * for it is the defect issue #1247 exists to prevent.
   */
  it("leaves an unpriceable override unknown instead of falling back to the base", async () => {
    overridesRepo.find.mockResolvedValue([halfSizeOverride("2026-03-15")]);
    fx.resolveCashExchangeRateOrNull.mockResolvedValue(null);

    const occurrences = await service.expand(userId, [investmentSchedule()], {
      through: "2026-03-31",
    });

    expect(occurrences[0].amount).toBeNull();
    expect(occurrences[0].complete).toBe(false);
    expect(occurrences[0].settlementPair).toEqual({ from: "USD", to: "CAD" });
  });

  it("reports an unknown base amount as unknown, with the pair that failed", async () => {
    fx.resolveCashExchangeRateOrNull.mockResolvedValue(null);

    const occurrences = await service.expand(userId, [investmentSchedule()], {
      through: "2026-03-31",
    });

    expect(occurrences[0]).toMatchObject({
      amount: null,
      complete: false,
      settlementPair: { from: "USD", to: "CAD" },
    });
  });

  it("returns the ordinary schedule's own amount unchanged", async () => {
    const occurrences = await service.expand(
      userId,
      [
        investmentSchedule({
          id: "st-rent",
          name: "Rent",
          amount: -1200,
          isInvestment: false,
          investmentAction: null,
          investmentSecurityId: null,
        } as Partial<ScheduledTransaction>),
      ],
      { through: "2026-03-31" },
    );

    expect(occurrences[0].amount).toBe(-1200);
    expect(occurrences[0].complete).toBe(true);
  });

  it("asks for nothing when there are no rows", async () => {
    await expect(
      service.expand(userId, [], { through: "2026-03-31" }),
    ).resolves.toEqual([]);
    expect(overridesRepo.find).not.toHaveBeenCalled();
  });

  it("loads candidates whose occurrence an override moved into the window", async () => {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    scheduledRepo.createQueryBuilder.mockReturnValue(qb);

    await service.findOccurrences(userId, { through: "2026-04-30" });

    // The candidate predicate has to reach past `next_due_date`, or a schedule
    // whose next slot sits beyond the window loses the occurrence an override
    // pulled into it.
    const predicates = qb.andWhere.mock.calls.map((c) => String(c[0]));
    expect(
      predicates.some((p) => p.includes("scheduled_transaction_overrides")),
    ).toBe(true);
    expect(
      predicates.some((p) => p.includes("override_date <= :through")),
    ).toBe(true);
  });
});
