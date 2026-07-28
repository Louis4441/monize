import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { SecurityDetailService } from "./security-detail.service";
import { SecuritiesService } from "./securities.service";
import { PortfolioService } from "./portfolio.service";
import { PortfolioCalculationService } from "./portfolio-calculation.service";
import { InvestmentTransactionsService } from "./investment-transactions.service";
import { InvestmentAction } from "./entities/investment-transaction.entity";
import { withUserContext } from "../common/db/with-context";

const SECURITY_ID = "sec-1";
/** `withUserContext` insists on a real UUID, so the fixture uses one. */
const USER_ID = "11111111-1111-4111-8111-111111111111";

/** A holding row as `PortfolioService` produces it, with test overrides. */
function holding(overrides: Record<string, unknown> = {}) {
  return {
    id: "holding-1",
    accountId: "acct-1",
    securityId: SECURITY_ID,
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    currencyCode: "USD",
    quantity: 60,
    averageCost: 100,
    costBasis: 6000,
    costBasisAccountCurrency: 24000,
    currentPrice: 120,
    marketValue: 7200,
    gainLoss: 1200,
    gainLossPercent: 20,
    ...overrides,
  };
}

function historyTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "tx-1",
    transactionDate: "2024-01-15",
    accountId: "acct-1",
    accountName: "Brokerage",
    action: InvestmentAction.BUY,
    quantity: 60,
    price: 100,
    commission: 5,
    totalAmount: 6005,
    description: null,
    runningQuantityAccount: 60,
    runningQuantityAll: 60,
    ...overrides,
  };
}

describe("SecurityDetailService", () => {
  let service: SecurityDetailService;
  let securitiesService: Record<string, jest.Mock>;
  let portfolioService: Record<string, jest.Mock>;
  let calculationService: Record<string, jest.Mock>;
  let investmentTransactionsService: Record<string, jest.Mock>;
  let prefRepository: Record<string, jest.Mock>;

  const security = {
    id: SECURITY_ID,
    userId: USER_ID,
    symbol: "AAPL",
    name: "Apple Inc.",
    currencyCode: "USD",
    isActive: true,
  };

  /** Every call runs inside a user context, as an authenticated request would. */
  const getDetail = () =>
    withUserContext(USER_ID, () => service.getDetail(USER_ID, SECURITY_ID));

  beforeEach(async () => {
    securitiesService = { findOne: jest.fn().mockResolvedValue(security) };

    portfolioService = {
      getPortfolioSummary: jest.fn().mockResolvedValue({
        holdings: [holding()],
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            currencyCode: "PLN",
            holdings: [holding()],
          },
        ],
      }),
    };

    // A flat 4 PLN per USD, so converted figures are easy to assert.
    calculationService = {
      convertToDefault: jest
        .fn()
        .mockImplementation(async (amount: number, from: string, to: string) =>
          from === to ? amount : amount * 4,
        ),
    };

    investmentTransactionsService = {
      getSecurityTransactionHistory: jest.fn().mockResolvedValue({
        securityId: SECURITY_ID,
        symbol: "AAPL",
        name: "Apple Inc.",
        currencyCode: "USD",
        isActive: true,
        accounts: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            isClosed: false,
            currentQuantity: 60,
          },
        ],
        transactions: [historyTransaction()],
        currentQuantityAll: 60,
      }),
      getRealizedGains: jest.fn().mockResolvedValue([]),
    };

    prefRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "PLN" }),
    };

    const dataSource = {
      transaction: (fn: (manager: unknown) => unknown) =>
        fn({ getRepository: () => prefRepository }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityDetailService,
        { provide: DataSource, useValue: dataSource },
        { provide: SecuritiesService, useValue: securitiesService },
        { provide: PortfolioService, useValue: portfolioService },
        {
          provide: PortfolioCalculationService,
          useValue: calculationService,
        },
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactionsService,
        },
      ],
    }).compile();

    service = module.get<SecurityDetailService>(SecurityDetailService);
  });

  it("validates ownership through SecuritiesService", async () => {
    await getDetail();
    expect(securitiesService.findOne).toHaveBeenCalledWith(
      USER_ID,
      SECURITY_ID,
    );
  });

  it("propagates a not-found security instead of returning an empty detail", async () => {
    securitiesService.findOne.mockRejectedValue(new Error("not found"));
    await expect(getDetail()).rejects.toThrow("not found");
  });

  describe("per-account positions", () => {
    it("reuses the portfolio's cost basis and market value verbatim", async () => {
      const detail = await getDetail();

      expect(detail.accounts).toHaveLength(1);
      expect(detail.accounts[0]).toMatchObject({
        accountId: "acct-1",
        accountName: "Brokerage",
        accountCurrencyCode: "PLN",
        isClosed: false,
        quantity: 60,
        averageCost: 100,
        costBasis: 6000,
        costBasisAccountCurrency: 24000,
        marketValue: 7200,
        gainLoss: 1200,
        gainLossPercent: 20,
      });
    });

    it("converts market value into the account's currency", async () => {
      const detail = await getDetail();

      // 7200 USD at 4 PLN/USD.
      expect(detail.accounts[0].marketValueAccountCurrency).toBe(28800);
      // 28800 PLN market value less the 24000 PLN historical cost basis.
      expect(detail.accounts[0].gainLossAccountCurrency).toBe(4800);
    });

    it("carries the closed flag over from the transaction history", async () => {
      investmentTransactionsService.getSecurityTransactionHistory.mockResolvedValue(
        {
          accounts: [
            {
              accountId: "acct-1",
              accountName: "Brokerage",
              isClosed: true,
              currentQuantity: 60,
            },
          ],
          transactions: [historyTransaction()],
        },
      );

      const detail = await getDetail();
      expect(detail.accounts[0].isClosed).toBe(true);
    });

    it("leaves account money null when the security has no price", async () => {
      const priceless = holding({
        currentPrice: null,
        marketValue: null,
        gainLoss: null,
        gainLossPercent: null,
      });
      portfolioService.getPortfolioSummary.mockResolvedValue({
        holdings: [priceless],
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            currencyCode: "PLN",
            holdings: [priceless],
          },
        ],
      });

      const detail = await getDetail();
      expect(detail.accounts[0].marketValue).toBeNull();
      expect(detail.accounts[0].marketValueAccountCurrency).toBeNull();
      expect(detail.accounts[0].gainLossAccountCurrency).toBeNull();
    });

    it("ignores accounts that hold other securities", async () => {
      portfolioService.getPortfolioSummary.mockResolvedValue({
        holdings: [holding()],
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            currencyCode: "PLN",
            holdings: [holding()],
          },
          {
            accountId: "acct-9",
            accountName: "Other",
            currencyCode: "PLN",
            holdings: [holding({ securityId: "sec-other" })],
          },
        ],
      });

      const detail = await getDetail();
      expect(detail.accounts.map((a) => a.accountId)).toEqual(["acct-1"]);
    });
  });

  describe("aggregate position", () => {
    beforeEach(() => {
      // Same security in two accounts: 60 units at 100, 40 units at 150.
      const first = holding();
      const second = holding({
        id: "holding-2",
        accountId: "acct-2",
        quantity: 40,
        averageCost: 150,
        costBasis: 6000,
        costBasisAccountCurrency: 25000,
        marketValue: 4800,
        gainLoss: -1200,
        gainLossPercent: -20,
      });

      portfolioService.getPortfolioSummary.mockResolvedValue({
        holdings: [first, second],
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            currencyCode: "PLN",
            holdings: [first],
          },
          {
            accountId: "acct-2",
            accountName: "IKE",
            currencyCode: "PLN",
            holdings: [second],
          },
        ],
      });
    });

    it("sums quantity and cost basis across accounts", async () => {
      const { position } = await getDetail();
      expect(position.quantity).toBe(100);
      expect(position.costBasis).toBe(12000);
      expect(position.marketValue).toBe(12000);
    });

    it("weights average cost by units rather than averaging the averages", async () => {
      const { position } = await getDetail();
      // 12000 total cost / 100 units = 120, not the (100 + 150) / 2 = 125 that
      // averaging the two per-account averages would give.
      expect(position.averageCost).toBe(120);
    });

    it("converts the aggregate into the reporting currency", async () => {
      const { position, defaultCurrency } = await getDetail();
      expect(defaultCurrency).toBe("PLN");
      // Both accounts are already in PLN, so the historical basis passes through.
      expect(position.costBasisDefaultCurrency).toBe(49000);
      // 7200 + 4800 USD converted at 4 PLN/USD.
      expect(position.marketValueDefaultCurrency).toBe(48000);
      expect(position.gainLossDefaultCurrency).toBe(-1000);
    });

    it("reports gain against the security-currency basis", async () => {
      const { position } = await getDetail();
      expect(position.gainLoss).toBe(0);
      expect(position.gainLossPercent).toBe(0);
    });

    it("keeps fractional quantities that money rounding would erase", async () => {
      const first = holding({
        quantity: 0.00000001,
        costBasis: 1,
        averageCost: 1,
      });
      const second = holding({
        id: "holding-2",
        accountId: "acct-2",
        quantity: 0.00000002,
        costBasis: 2,
        averageCost: 1,
      });
      portfolioService.getPortfolioSummary.mockResolvedValue({
        holdings: [first, second],
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            currencyCode: "PLN",
            holdings: [first],
          },
          {
            accountId: "acct-2",
            accountName: "IKE",
            currencyCode: "PLN",
            holdings: [second],
          },
        ],
      });

      const { position } = await getDetail();
      // Summed at the 8dp quantity precision, not the 4dp money one.
      expect(position.quantity).toBe(0.00000003);
    });

    it("nulls the aggregate when any account is missing a price", async () => {
      const priced = holding();
      const unpriced = holding({
        id: "holding-2",
        accountId: "acct-2",
        currentPrice: null,
        marketValue: null,
        gainLoss: null,
      });
      portfolioService.getPortfolioSummary.mockResolvedValue({
        holdings: [priced, unpriced],
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            currencyCode: "PLN",
            holdings: [priced],
          },
          {
            accountId: "acct-2",
            accountName: "IKE",
            currencyCode: "PLN",
            holdings: [unpriced],
          },
        ],
      });

      const { position } = await getDetail();
      // A partial total would read as a real (and wrong) portfolio value.
      expect(position.marketValue).toBeNull();
      expect(position.marketValueDefaultCurrency).toBeNull();
      expect(position.gainLoss).toBeNull();
      expect(position.gainLossPercent).toBeNull();
    });
  });

  describe("activity totals", () => {
    beforeEach(() => {
      investmentTransactionsService.getSecurityTransactionHistory.mockResolvedValue(
        {
          accounts: [
            {
              accountId: "acct-1",
              accountName: "Brokerage",
              isClosed: false,
              currentQuantity: 60,
            },
          ],
          transactions: [
            historyTransaction({
              id: "tx-1",
              transactionDate: "2022-03-12",
              action: InvestmentAction.BUY,
              commission: 5,
              totalAmount: 6005,
            }),
            historyTransaction({
              id: "tx-2",
              transactionDate: "2023-06-01",
              action: InvestmentAction.DIVIDEND,
              commission: 0,
              totalAmount: 120.5,
            }),
            historyTransaction({
              id: "tx-3",
              transactionDate: "2024-02-02",
              action: InvestmentAction.SELL,
              commission: 3,
              totalAmount: 2497,
            }),
            historyTransaction({
              id: "tx-4",
              transactionDate: "2026-06-20",
              action: InvestmentAction.INTEREST,
              commission: 0,
              totalAmount: 10.25,
            }),
          ],
        },
      );
    });

    it("separates invested, sold, income and fees by action", async () => {
      const { activity } = await getDetail();

      expect(activity.totalInvested).toBe(6005);
      expect(activity.totalSold).toBe(2497);
      // Dividend plus interest; both are income, not a change of position.
      expect(activity.dividends).toBe(130.75);
      expect(activity.fees).toBe(8);
      expect(activity.transactionCount).toBe(4);
    });

    it("takes the first and last dates from the ordered history", async () => {
      const { activity } = await getDetail();
      expect(activity.firstTransactionDate).toBe("2022-03-12");
      expect(activity.lastTransactionDate).toBe("2026-06-20");
    });

    it("keeps only this security's realized gains", async () => {
      investmentTransactionsService.getRealizedGains.mockResolvedValue([
        { securityId: SECURITY_ID, realizedGain: 1000 },
        { securityId: "sec-other", realizedGain: 9999 },
        { securityId: SECURITY_ID, realizedGain: -250.5 },
      ]);

      const { activity } = await getDetail();
      expect(activity.realizedGain).toBe(749.5);
    });

    it("scopes the realized-gain replay to the accounts that traded it", async () => {
      await getDetail();
      expect(
        investmentTransactionsService.getRealizedGains,
      ).toHaveBeenCalledWith(USER_ID, { accountIds: ["acct-1"] });
    });

    it("sums money in integer units so repeated decimals do not drift", async () => {
      investmentTransactionsService.getSecurityTransactionHistory.mockResolvedValue(
        {
          accounts: [],
          transactions: [
            historyTransaction({
              action: InvestmentAction.DIVIDEND,
              totalAmount: 0.1,
              commission: 0,
            }),
            historyTransaction({
              action: InvestmentAction.DIVIDEND,
              totalAmount: 0.2,
              commission: 0,
            }),
          ],
        },
      );

      const { activity } = await getDetail();
      expect(activity.dividends).toBe(0.3);
    });
  });

  describe("position state", () => {
    it("marks a held position as neither closed nor empty", async () => {
      const detail = await getDetail();
      expect(detail.hasTransactions).toBe(true);
      expect(detail.isPositionClosed).toBe(false);
    });

    it("marks a fully sold position as closed", async () => {
      portfolioService.getPortfolioSummary.mockResolvedValue({
        holdings: [],
        holdingsByAccount: [],
      });

      const detail = await getDetail();
      expect(detail.hasTransactions).toBe(true);
      expect(detail.isPositionClosed).toBe(true);
      expect(detail.position.quantity).toBe(0);
      expect(detail.position.averageCost).toBe(0);
      // No holdings at all is "unknown", not "worth zero".
      expect(detail.position.marketValue).toBeNull();
    });

    it("does not call a never-traded security a closed position", async () => {
      investmentTransactionsService.getSecurityTransactionHistory.mockResolvedValue(
        { accounts: [], transactions: [] },
      );
      portfolioService.getPortfolioSummary.mockResolvedValue({
        holdings: [],
        holdingsByAccount: [],
      });

      const detail = await getDetail();
      expect(detail.hasTransactions).toBe(false);
      expect(detail.isPositionClosed).toBe(false);
      expect(detail.activity.firstTransactionDate).toBeNull();
      expect(detail.activity.realizedGain).toBe(0);
      // With no accounts to scope to, the replay is skipped entirely.
      expect(
        investmentTransactionsService.getRealizedGains,
      ).not.toHaveBeenCalled();
    });
  });

  it("falls back to CAD when the user has no currency preference", async () => {
    prefRepository.findOne.mockResolvedValue(null);
    const detail = await getDetail();
    expect(detail.defaultCurrency).toBe("CAD");
  });
});
