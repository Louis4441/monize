import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { PortfolioCalculationService } from "@/securities/portfolio-calculation.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { HoldingsService } from "@/securities/holdings.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "@/securities/entities/investment-transaction.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * End-to-end coverage for transferring a security between two brokerage
 * accounts. The original cost basis (1.67/share) must follow the shares to
 * the destination so gain/profit reporting stays correct, and the two legs
 * are linked so editing or deleting one cascades to the other.
 */
describe("Security transfer between accounts (integration)", () => {
  let module: TestingModule;
  let service: InvestmentTransactionsService;
  let holdingsService: HoldingsService;
  let portfolioCalculation: PortfolioCalculationService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageA: string;
  let brokerageB: string;
  let securityId: string;

  const qty = (h: { quantity: number } | null) => Number(h?.quantity ?? 0);

  /**
   * Read a holding the way a request would -- inside the owner's context.
   * `HoldingsService` goes through `withScopedDb`, which refuses to run
   * without one (RLS task R3).
   */
  const holdingOf = (accountId: string) =>
    withUserContext(userId, () =>
      holdingsService.findByAccountAndSecurity(accountId, securityId),
    );

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    service = module.get(InvestmentTransactionsService);
    holdingsService = module.get(HoldingsService);
    portfolioCalculation = module.get(PortfolioCalculationService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "securities",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "investment_transactions",
      "monthly_account_balances",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('PLN', 'Polish Zloty', 'zl', 2) ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    const a = await createTestAccount(dataSource, userId, {
      name: "Brokerage A",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, a.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    brokerageA = a.id;

    const b = await createTestAccount(dataSource, userId, {
      name: "Brokerage B",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, b.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    brokerageB = b.id;

    const securitiesService = module.get(SecuritiesService);
    const security = await withUserContext(userId, () =>
      securitiesService.create(userId, {
        symbol: "ACME",
        name: "Acme Corp",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;
  });

  // Buy 100 shares in Brokerage A at a discounted 1.67/share.
  async function buy100At167() {
    await withUserContext(userId, () =>
      service.create(userId, {
        accountId: brokerageA,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-10",
        securityId,
        quantity: 100,
        price: 1.67,
        commission: 0,
      } as any),
    );
  }

  it("carries cost basis to the destination and links the two legs", async () => {
    await buy100At167();
    const cashBefore = await dataSource.manager.count(Transaction, {
      where: { userId },
    });

    const { transferOut, transferIn } = await withUserContext(userId, () =>
      service.transferSecurity(userId, {
        fromAccountId: brokerageA,
        toAccountId: brokerageB,
        securityId,
        transactionDate: "2026-02-01",
        quantity: 100,
        costPerShare: 1.67,
      }),
    );

    // Source emptied, destination holds the shares at the original cost.
    const aHolding = await holdingOf(brokerageA);
    const bHolding = await holdingOf(brokerageB);
    expect(qty(aHolding)).toBe(0);
    expect(qty(bHolding)).toBe(100);
    expect(Number(bHolding?.averageCost)).toBeCloseTo(1.67, 6);

    // Legs reference each other and create no cash transactions.
    expect(transferOut.linkedTransactionId).toBe(transferIn.id);
    expect(transferIn.linkedTransactionId).toBe(transferOut.id);
    expect(transferOut.transactionId).toBeNull();
    expect(transferIn.transactionId).toBeNull();
    // The transfer itself moves shares only -- no new cash transaction.
    const cashAfter = await dataSource.manager.count(Transaction, {
      where: { userId },
    });
    expect(cashAfter).toBe(cashBefore);
  });

  it("deleting one leg removes both and restores the source holding", async () => {
    await buy100At167();
    const { transferOut, transferIn } = await withUserContext(userId, () =>
      service.transferSecurity(userId, {
        fromAccountId: brokerageA,
        toAccountId: brokerageB,
        securityId,
        transactionDate: "2026-02-01",
        quantity: 100,
        costPerShare: 1.67,
      }),
    );

    // Delete the destination leg; the source leg must go too.
    await withUserContext(userId, () => service.remove(userId, transferIn.id));

    const remaining = await dataSource.manager.find(InvestmentTransaction, {
      where: { userId, action: InvestmentAction.TRANSFER_OUT },
    });
    expect(remaining).toHaveLength(0);
    const remainingIn = await dataSource.manager.findOne(
      InvestmentTransaction,
      {
        where: { id: transferOut.id },
      },
    );
    expect(remainingIn).toBeNull();

    // Shares are back in A, gone from B.
    const aHolding = await holdingOf(brokerageA);
    const bHolding = await holdingOf(brokerageB);
    expect(qty(aHolding)).toBe(100);
    expect(qty(bHolding)).toBe(0);
  });

  it("editing the quantity on one leg updates both legs and holdings", async () => {
    await buy100At167();
    const { transferOut, transferIn } = await withUserContext(userId, () =>
      service.transferSecurity(userId, {
        fromAccountId: brokerageA,
        toAccountId: brokerageB,
        securityId,
        transactionDate: "2026-02-01",
        quantity: 100,
        costPerShare: 1.67,
      }),
    );

    // Reduce the transferred quantity by editing the OUT leg.
    await withUserContext(userId, () =>
      service.update(userId, transferOut.id, { quantity: 60 }),
    );

    const outAfter = await dataSource.manager.findOneOrFail(
      InvestmentTransaction,
      { where: { id: transferOut.id } },
    );
    const inAfter = await dataSource.manager.findOneOrFail(
      InvestmentTransaction,
      { where: { id: transferIn.id } },
    );
    expect(Number(outAfter.quantity)).toBe(60);
    expect(Number(inAfter.quantity)).toBe(60);

    // 40 stay in A, 60 land in B, cost basis preserved on both sides.
    const aHolding = await holdingOf(brokerageA);
    const bHolding = await holdingOf(brokerageB);
    expect(qty(aHolding)).toBe(40);
    expect(qty(bHolding)).toBe(60);
    expect(Number(bHolding?.averageCost)).toBeCloseTo(1.67, 6);
  });

  it("reroutes the destination account when editing a transfer", async () => {
    await buy100At167();
    const { transferOut } = await withUserContext(userId, () =>
      service.transferSecurity(userId, {
        fromAccountId: brokerageA,
        toAccountId: brokerageB,
        securityId,
        transactionDate: "2026-02-01",
        quantity: 100,
        costPerShare: 1.67,
      }),
    );

    // Add a third brokerage and reroute the destination to it.
    const c = await createTestAccount(dataSource, userId, {
      name: "Brokerage C",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, c.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });

    await withUserContext(userId, () =>
      service.update(userId, transferOut.id, {
        destinationAccountId: c.id,
      }),
    );

    // Shares now sit in C, not B; cost basis preserved.
    const bHolding = await holdingOf(brokerageB);
    const cHolding = await holdingOf(c.id);
    expect(qty(bHolding)).toBe(0);
    expect(qty(cHolding)).toBe(100);
    expect(Number(cHolding?.averageCost)).toBeCloseTo(1.67, 6);
  });

  it("rejects transferring more shares than the source holds", async () => {
    await buy100At167();
    await expect(
      withUserContext(userId, () =>
        service.transferSecurity(userId, {
          fromAccountId: brokerageA,
          toAccountId: brokerageB,
          securityId,
          transactionDate: "2026-02-01",
          quantity: 150,
          costPerShare: 1.67,
        }),
      ),
    ).rejects.toBeDefined();

    // Nothing moved.
    const aHolding = await holdingOf(brokerageA);
    expect(qty(aHolding)).toBe(100);
  });
  /**
   * The historical tax basis, end to end through the real creation and
   * transfer paths and out of the real replay -- not a hand-built entity.
   *
   * `transferSecurity` writes the IN leg at the carried per-share average with
   * `exchangeRate` 1, which is right for the holdings table and useless as a
   * cost: the average is in the security's currency and the rate says nothing.
   * Rebuilding the basis from that row turned PLN 3,000 into PLN 1,000.
   */
  describe("historical basis across a cross-currency transfer", () => {
    /** Both brokerages settle in PLN; the security is quoted in USD. */
    async function makeAccountsSettleInPln() {
      await dataSource.manager.update(Account, brokerageA, {
        currencyCode: "PLN",
      });
      await dataSource.manager.update(Account, brokerageB, {
        currencyCode: "PLN",
      });
    }

    /** 10 shares at USD 100 when USD/PLN was 3.00: PLN 3,000. */
    async function buyTenAtThree() {
      await withUserContext(userId, () =>
        service.create(userId, {
          accountId: brokerageA,
          action: InvestmentAction.BUY,
          transactionDate: "2026-01-10",
          securityId,
          quantity: 10,
          price: 100,
          commission: 0,
          exchangeRate: 3,
        } as any),
      );
    }

    const replay = () =>
      withUserContext(userId, () =>
        portfolioCalculation.calculateCostBasisLotsInAccountCurrency(userId, [
          brokerageA,
          brokerageB,
        ]),
      );

    it("carries PLN 3,000 to the destination, not the IN leg's own numbers", async () => {
      await makeAccountsSettleInPln();
      await buyTenAtThree();

      await withUserContext(userId, () =>
        service.transferSecurity(userId, {
          fromAccountId: brokerageA,
          toAccountId: brokerageB,
          securityId,
          transactionDate: "2026-02-01",
          quantity: 10,
          costPerShare: 100,
        }),
      );

      const lots = await replay();
      const destination = lots.get(`${brokerageB}:${securityId}`);

      // Against a market value of PLN 4,400 (USD 110 at 4.00) this is a gain
      // of PLN 1,400 and, at 19%, a tax of PLN 266. Read off the IN leg the
      // basis was PLN 1,000, the gain PLN 3,400 and the tax PLN 646.
      expect(destination?.costBasis).toBeCloseTo(3000, 4);
      expect(destination?.currencyCode).toBe("PLN");
      expect(destination?.basisKnown).toBe(true);
      expect(Number(destination?.quantity)).toBeCloseTo(10, 6);

      // 4,400 - 3,000, taxed at 19%, is what the report will then show.
      const gain = 4400 - (destination?.costBasis as number);
      expect(gain).toBeCloseTo(1400, 4);
      expect(gain * 0.19).toBeCloseTo(266, 4);
    });

    it("splits the basis proportionally on a partial transfer", async () => {
      await makeAccountsSettleInPln();
      await buyTenAtThree();

      await withUserContext(userId, () =>
        service.transferSecurity(userId, {
          fromAccountId: brokerageA,
          toAccountId: brokerageB,
          securityId,
          transactionDate: "2026-02-01",
          quantity: 4,
          costPerShare: 100,
        }),
      );

      const lots = await replay();
      expect(lots.get(`${brokerageB}:${securityId}`)?.costBasis).toBeCloseTo(
        1200,
        4,
      );
      expect(lots.get(`${brokerageA}:${securityId}`)?.costBasis).toBeCloseTo(
        1800,
        4,
      );
    });

    it("creates no cash, no gain and no new basis of its own", async () => {
      await makeAccountsSettleInPln();
      await buyTenAtThree();
      const cashBefore = await dataSource.manager.count(Transaction, {
        where: { userId },
      });

      await withUserContext(userId, () =>
        service.transferSecurity(userId, {
          fromAccountId: brokerageA,
          toAccountId: brokerageB,
          securityId,
          transactionDate: "2026-02-01",
          quantity: 10,
          costPerShare: 100,
        }),
      );

      const cashAfter = await dataSource.manager.count(Transaction, {
        where: { userId },
      });
      expect(cashAfter).toBe(cashBefore);

      // Conserved, to the cent: a transfer neither creates nor destroys cost.
      const lots = await replay();
      const total =
        (lots.get(`${brokerageA}:${securityId}`)?.costBasis ?? 0) +
        (lots.get(`${brokerageB}:${securityId}`)?.costBasis ?? 0);
      expect(total).toBeCloseTo(3000, 4);
    });

    it("keeps an unpriced source position unknown at the destination", async () => {
      await makeAccountsSettleInPln();
      // ADD_SHARES is the real path for units whose cost is not known.
      await withUserContext(userId, () =>
        service.create(userId, {
          accountId: brokerageA,
          action: InvestmentAction.ADD_SHARES,
          transactionDate: "2026-01-10",
          securityId,
          quantity: 10,
          // ADD_SHARES posts no cash, but the rate is resolved for every row
          // and there is no USD/PLN quote in the test database.
          exchangeRate: 1,
        } as any),
      );

      await withUserContext(userId, () =>
        service.transferSecurity(userId, {
          fromAccountId: brokerageA,
          toAccountId: brokerageB,
          securityId,
          transactionDate: "2026-02-01",
          quantity: 10,
          costPerShare: 0,
        }),
      );

      const lots = await replay();
      expect(lots.get(`${brokerageB}:${securityId}`)?.basisKnown).toBe(false);
    });
  });

  /**
   * The producer half of the missing-price contract, through the real DTO and
   * service rather than a hand-built entity: a unit test that constructs
   * `price: null` itself proves nothing about a path that was writing zero.
   */
  describe("an acquisition with no price", () => {
    it("is refused for a BUY", async () => {
      await expect(
        withUserContext(userId, () =>
          service.create(userId, {
            accountId: brokerageA,
            action: InvestmentAction.BUY,
            transactionDate: "2026-01-10",
            securityId,
            quantity: 10,
          } as any),
        ),
      ).rejects.toBeDefined();

      const stored = await dataSource.manager.count(InvestmentTransaction, {
        where: { userId },
      });
      expect(stored).toBe(0);
    });

    it("is stored as unknown for ADD_SHARES, and stays unknown in the replay", async () => {
      await withUserContext(userId, () =>
        service.create(userId, {
          accountId: brokerageA,
          action: InvestmentAction.ADD_SHARES,
          transactionDate: "2026-01-10",
          securityId,
          quantity: 10,
        } as any),
      );

      const [row] = await dataSource.manager.find(InvestmentTransaction, {
        where: { userId },
      });
      // The column carries the distinction; writing 0 here is what destroyed
      // it before anything downstream could read it.
      expect(row.price).toBeNull();

      const lots = await withUserContext(userId, () =>
        portfolioCalculation.calculateCostBasisLotsInAccountCurrency(userId, [
          brokerageA,
        ]),
      );
      expect(lots.get(`${brokerageA}:${securityId}`)).toMatchObject({
        basisKnown: false,
      });
    });

    it("still records a priced BUY as a known basis", async () => {
      await withUserContext(userId, () =>
        service.create(userId, {
          accountId: brokerageA,
          action: InvestmentAction.BUY,
          transactionDate: "2026-01-10",
          securityId,
          quantity: 10,
          price: 25,
          commission: 5,
        } as any),
      );

      const lots = await withUserContext(userId, () =>
        portfolioCalculation.calculateCostBasisLotsInAccountCurrency(userId, [
          brokerageA,
        ]),
      );
      expect(lots.get(`${brokerageA}:${securityId}`)).toMatchObject({
        costBasis: 255,
        basisKnown: true,
      });
    });
  });
});
