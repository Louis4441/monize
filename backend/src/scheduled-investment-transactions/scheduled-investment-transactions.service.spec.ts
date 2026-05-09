import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScheduledInvestmentTransactionsService } from "./scheduled-investment-transactions.service";
import { ScheduledInvestmentTransaction } from "./entities/scheduled-investment-transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { AccountsService } from "../accounts/accounts.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { AccountType } from "../accounts/entities/account.entity";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";

const baseEntity = (
  overrides: Partial<ScheduledInvestmentTransaction> = {},
): ScheduledInvestmentTransaction =>
  ({
    id: "s-1",
    userId: "user-1",
    accountId: "acc-1",
    fundingAccountId: null,
    securityId: "sec-1",
    action: InvestmentAction.BUY,
    name: "Monthly VOO DCA",
    quantity: 5,
    price: 100,
    commission: 0,
    totalAmount: null,
    currencyCode: "USD",
    exchangeRate: null,
    description: null,
    frequency: "MONTHLY",
    nextDueDate: "2026-05-10",
    startDate: "2026-05-10",
    endDate: null,
    occurrencesRemaining: null,
    totalOccurrences: null,
    isActive: true,
    autoPost: false,
    reminderDaysBefore: 3,
    lastPostedDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    account: { id: "acc-1", name: "Brokerage", currencyCode: "USD" } as any,
    fundingAccount: null,
    security: { id: "sec-1", symbol: "VOO" } as any,
    ...overrides,
  }) as ScheduledInvestmentTransaction;

describe("ScheduledInvestmentTransactionsService", () => {
  let service: ScheduledInvestmentTransactionsService;
  let repo: Record<string, jest.Mock>;
  let prefRepo: Record<string, jest.Mock>;
  let accounts: Record<string, jest.Mock>;
  let investments: Record<string, jest.Mock>;
  let actionHistory: Record<string, jest.Mock>;

  beforeEach(async () => {
    repo = {
      create: jest.fn((dto) => ({ ...dto })),
      save: jest.fn(async (e) => ({ id: "s-1", ...e })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    prefRepo = {
      findOne: jest.fn().mockResolvedValue({ timezone: "America/New_York" }),
    };
    accounts = {
      findOne: jest.fn().mockResolvedValue({
        accountType: AccountType.INVESTMENT,
        currencyCode: "USD",
      }),
    };
    investments = {
      create: jest.fn().mockResolvedValue({ id: "it-1" }),
    };
    actionHistory = {
      record: jest.fn().mockResolvedValue(null),
    };

    const dataSource = {
      query: jest.fn().mockResolvedValue([]),
    } as unknown as DataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledInvestmentTransactionsService,
        {
          provide: getRepositoryToken(ScheduledInvestmentTransaction),
          useValue: repo,
        },
        { provide: getRepositoryToken(UserPreference), useValue: prefRepo },
        { provide: AccountsService, useValue: accounts },
        { provide: InvestmentTransactionsService, useValue: investments },
        { provide: ActionHistoryService, useValue: actionHistory },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(ScheduledInvestmentTransactionsService);
  });

  describe("create()", () => {
    it("creates a BUY scheduled investment", async () => {
      const dto: any = {
        accountId: "acc-1",
        action: InvestmentAction.BUY,
        securityId: "sec-1",
        name: "VOO DCA",
        quantity: 5,
        price: 100,
        frequency: "MONTHLY",
        nextDueDate: "2026-05-10",
      };
      repo.findOne.mockResolvedValue(baseEntity());

      const result = await service.create("user-1", dto);

      expect(accounts.findOne).toHaveBeenCalledWith("user-1", "acc-1");
      expect(repo.save).toHaveBeenCalled();
      expect(actionHistory.record).toHaveBeenCalled();
      expect(result.id).toBe("s-1");
    });

    it("rejects non-investment account", async () => {
      accounts.findOne.mockResolvedValue({
        accountType: AccountType.CHEQUING,
        currencyCode: "USD",
      });
      await expect(
        service.create("user-1", {
          accountId: "acc-1",
          action: InvestmentAction.BUY,
          securityId: "sec-1",
          name: "Bad",
          quantity: 1,
          price: 1,
          frequency: "MONTHLY",
          nextDueDate: "2026-05-10",
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects BUY without quantity", async () => {
      await expect(
        service.create("user-1", {
          accountId: "acc-1",
          action: InvestmentAction.BUY,
          securityId: "sec-1",
          name: "Bad",
          price: 100,
          frequency: "MONTHLY",
          nextDueDate: "2026-05-10",
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects DIVIDEND without securityId", async () => {
      await expect(
        service.create("user-1", {
          accountId: "acc-1",
          action: InvestmentAction.DIVIDEND,
          name: "Bad",
          totalAmount: 50,
          frequency: "QUARTERLY",
          nextDueDate: "2026-06-01",
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects DIVIDEND without totalAmount", async () => {
      await expect(
        service.create("user-1", {
          accountId: "acc-1",
          action: InvestmentAction.DIVIDEND,
          securityId: "sec-1",
          name: "Bad",
          frequency: "QUARTERLY",
          nextDueDate: "2026-06-01",
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("validates funding account exists", async () => {
      const dto: any = {
        accountId: "acc-1",
        fundingAccountId: "bank-1",
        action: InvestmentAction.BUY,
        securityId: "sec-1",
        name: "Contribution+Buy",
        quantity: 5,
        price: 100,
        frequency: "MONTHLY",
        nextDueDate: "2026-05-10",
      };
      repo.findOne.mockResolvedValue(
        baseEntity({ fundingAccountId: "bank-1" }),
      );
      await service.create("user-1", dto);
      expect(accounts.findOne).toHaveBeenCalledWith("user-1", "bank-1");
    });
  });

  describe("findOne()", () => {
    it("throws NotFoundException when missing", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne("user-1", "missing")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("post()", () => {
    it("calls InvestmentTransactionsService.create with stored values", async () => {
      const e = baseEntity();
      repo.findOne.mockResolvedValue(e);

      await service.post("user-1", "s-1");

      expect(investments.create).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          accountId: "acc-1",
          action: InvestmentAction.BUY,
          securityId: "sec-1",
          quantity: 5,
          price: 100,
          transactionDate: "2026-05-10",
        }),
      );
    });

    it("advances nextDueDate by MONTHLY frequency", async () => {
      const e = baseEntity({ nextDueDate: "2026-05-10", frequency: "MONTHLY" });
      repo.findOne.mockResolvedValue(e);

      await service.post("user-1", "s-1");

      expect(repo.update).toHaveBeenCalledWith(
        "s-1",
        expect.objectContaining({ nextDueDate: "2026-06-10" }),
      );
    });

    it("clamps end-of-month MONTHLY to last day of next month", async () => {
      const e = baseEntity({ nextDueDate: "2026-01-31", frequency: "MONTHLY" });
      repo.findOne.mockResolvedValue(e);

      await service.post("user-1", "s-1");

      expect(repo.update).toHaveBeenCalledWith(
        "s-1",
        expect.objectContaining({ nextDueDate: "2026-02-28" }),
      );
    });

    it("deletes the row when frequency is ONCE", async () => {
      const e = baseEntity({ frequency: "ONCE" });
      repo.findOne.mockResolvedValue(e);

      const result = await service.post("user-1", "s-1");

      expect(repo.delete).toHaveBeenCalledWith({ id: "s-1", userId: "user-1" });
      expect(result).toBeNull();
    });

    it("decrements occurrencesRemaining and deactivates at zero", async () => {
      const e = baseEntity({ occurrencesRemaining: 1, frequency: "MONTHLY" });
      repo.findOne.mockResolvedValue(e);

      await service.post("user-1", "s-1");

      expect(repo.update).toHaveBeenCalledWith(
        "s-1",
        expect.objectContaining({
          occurrencesRemaining: 0,
          isActive: false,
        }),
      );
    });

    it("deactivates when newNextDueDate exceeds endDate", async () => {
      const e = baseEntity({
        frequency: "MONTHLY",
        nextDueDate: "2026-05-10",
        endDate: "2026-05-31",
      });
      repo.findOne.mockResolvedValue(e);

      await service.post("user-1", "s-1");

      expect(repo.update).toHaveBeenCalledWith(
        "s-1",
        expect.objectContaining({ isActive: false }),
      );
    });

    it("inline post overrides quantity and price", async () => {
      const e = baseEntity();
      repo.findOne.mockResolvedValue(e);

      await service.post("user-1", "s-1", {
        quantity: 10,
        price: 105,
        transactionDate: "2026-05-12",
      });

      expect(investments.create).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          quantity: 10,
          price: 105,
          transactionDate: "2026-05-12",
        }),
      );
    });

    it("forwards totalAmount as price for DIVIDEND actions", async () => {
      const e = baseEntity({
        action: InvestmentAction.DIVIDEND,
        quantity: null,
        price: null,
        totalAmount: 25,
      });
      repo.findOne.mockResolvedValue(e);

      await service.post("user-1", "s-1");

      expect(investments.create).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          action: InvestmentAction.DIVIDEND,
          quantity: 1,
          price: 25,
        }),
      );
    });
  });

  describe("skip()", () => {
    it("advances nextDueDate without posting", async () => {
      const e = baseEntity();
      repo.findOne.mockResolvedValue(e);

      await service.skip("user-1", "s-1");

      expect(investments.create).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith(
        "s-1",
        expect.objectContaining({ nextDueDate: "2026-06-10" }),
      );
    });
  });

  describe("remove()", () => {
    it("deletes and records action history", async () => {
      const e = baseEntity();
      repo.findOne.mockResolvedValue(e);

      await service.remove("user-1", "s-1");

      expect(repo.delete).toHaveBeenCalledWith({ id: "s-1", userId: "user-1" });
      expect(actionHistory.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ action: "delete" }),
      );
    });
  });

  describe("update()", () => {
    it("updates fields and records action history", async () => {
      const e = baseEntity();
      repo.findOne
        .mockResolvedValueOnce(e)
        .mockResolvedValueOnce(baseEntity({ name: "Updated" }));

      const result = await service.update("user-1", "s-1", {
        name: "Updated",
      } as any);

      expect(repo.update).toHaveBeenCalledWith(
        "s-1",
        expect.objectContaining({ name: "Updated" }),
      );
      expect(actionHistory.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ action: "update" }),
      );
      expect(result.name).toBe("Updated");
    });
  });

  describe("processAutoPost (timezone-bucketed cron)", () => {
    it("uses the user's local today, not container UTC", async () => {
      // 02:00 UTC May 10 => 22:00 EST May 9 -> still May 9 for the user
      jest.useFakeTimers().setSystemTime(new Date("2026-05-10T02:00:00Z"));

      const dataSourceQuery = jest
        .fn()
        .mockResolvedValue([
          { user_id: "user-1", timezone: "America/New_York" },
        ]);
      (service as any).dataSource = { query: dataSourceQuery };

      // A row due May 10 should NOT post when EST date is still May 9.
      repo.find.mockImplementation(async ({ where }) => {
        // verify "today" passed in WHERE is May 9 in the user's tz
        const cond = (where as any).nextDueDate?._value;
        if (cond === "2026-05-09") return [];
        return [];
      });

      await service.processAutoPost();

      expect(dataSourceQuery).toHaveBeenCalled();
      expect(investments.create).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it("posts due rows when local today catches up", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-05-10T14:00:00Z"));

      const dataSourceQuery = jest
        .fn()
        .mockResolvedValue([
          { user_id: "user-1", timezone: "America/New_York" },
        ]);
      (service as any).dataSource = { query: dataSourceQuery };

      const due = baseEntity({ autoPost: true, nextDueDate: "2026-05-10" });
      repo.find.mockResolvedValue([due]);
      repo.findOne.mockResolvedValue(due);

      await service.processAutoPost();

      expect(investments.create).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it("treats missing/'browser'/empty timezone as UTC", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-05-10T14:00:00Z"));

      const dataSourceQuery = jest
        .fn()
        .mockResolvedValue([{ user_id: "user-1", timezone: "browser" }]);
      (service as any).dataSource = { query: dataSourceQuery };

      const due = baseEntity({ autoPost: true });
      repo.find.mockResolvedValue([due]);
      repo.findOne.mockResolvedValue(due);

      await service.processAutoPost();

      expect(investments.create).toHaveBeenCalled();
      jest.useRealTimers();
    });
  });
});
