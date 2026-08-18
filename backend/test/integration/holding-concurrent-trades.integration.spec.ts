import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// The securities module graph is circular: InvestmentTransactionsService depends
// on HoldingsService directly, which reaches AccountsService via forwardRef.
// InvestmentTransactionsService must be evaluated (and with it the securities
// graph) before HoldingsService is imported, or Nest cannot resolve
// InvestmentTransactionsService's HoldingsService constructor argument
// ("argument at index [3] is undefined"). Keeping this import first -- the order
// the passing investment-transactions integration spec uses -- and importing
// HoldingsService last is what makes the graph build.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { Holding } from "@/securities/entities/holding.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { HoldingsService } from "@/securities/holdings.service";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";
import { createTestAccount } from "../helpers/test-factories";

/**
 * INV-HOLDING-001 -- two-connection proof (audit P4-006).
 *
 * Mechanism under test: `lockHoldingScope` (`backend/src/common/db/locks.ts`),
 * an advisory lock keyed by account (`pg_advisory_xact_lock`) that every
 * holdings mutation path takes before reading the quantity it will write back.
 * `HoldingsService.createOrUpdate` computes `new = old + delta` in application
 * code -- a read-modify-write. The unique key on (account_id, security_id)
 * blocks a second *insert* and the row lock during an UPDATE serializes the
 * physical writes, but neither stops the second request from writing a quantity
 * it derived from the value it read *before* waiting. 10 shares, concurrent buys
 * of 1 and 2, and the holding ends at 12 instead of 13 -- one purchase and its
 * cost basis gone, with both trades committed.
 *
 * The invariant: two concurrent trades on one (account, security) holding must
 * not lose an update -- the stored quantity/average_cost equals a deterministic
 * replay of both trades over the starting position.
 *
 * ---------------------------------------------------------------------------
 * The interleaving is forced, not hoped for. A plain `Promise.all` of two trades
 * loses an update only on the unlucky scheduling, so with the lock removed the
 * test would be flaky-green rather than reliably red. Instead a test-held row
 * lock on the holding pins the ordering so both arrangements are deterministic:
 *
 *   - A barrier transaction takes `SELECT ... FOR UPDATE` on the holding row and
 *     is held open. Every trade's `save` (an UPDATE of that row) then blocks on
 *     it, while `findByAccountAndSecurity` (a plain SELECT) is free to read.
 *   - WITHOUT the lock: both trades read the *same* starting quantity (their
 *     reads are not serialized against each other), compute their own totals,
 *     and park on the barrier at their writes. Releasing the barrier lets one
 *     commit and the other overwrite it with a total derived from the stale
 *     read -- a lost update.
 *   - WITH the lock: the first trade takes the advisory lock, reads, and parks
 *     on the barrier at its write; the second trade blocks at `lockHoldingScope`
 *     *before it can read*. Releasing the barrier lets the first commit and
 *     release the advisory lock; only then does the second read -- now the fresh
 *     post-first quantity -- and add its delta. Both trades survive.
 */
describe("concurrent trades on one holding (integration, INV-HOLDING-001)", () => {
  let module: TestingModule;
  let investments: InvestmentTransactionsService;
  let holdings: HoldingsService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageAccountId: string;
  let fundingAccountId: string;
  let securityId: string;
  let holdingId: string;

  // Starting position (seeded through a real BUY), then two concurrent BUYs at
  // distinct prices driven through the holdings mutation path directly.
  const SEED_QTY = 10;
  const SEED_PRICE = 100;
  const TRADE_1 = { qty: 1, price: 120 };
  const TRADE_2 = { qty: 2, price: 150 };

  // Filled from the real seeded holding so the expected values are a faithful
  // replay of what the seed BUY actually stored, not an assumption about it.
  let seededQty: number;
  let seededAvgCost: number;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    holdings = module.get(HoldingsService);
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
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    // A brokerage account funded from an ordinary cash account, so a real BUY can
    // establish the starting holding.
    const brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    brokerageAccountId = brokerage.id;

    const funding = await createTestAccount(dataSource, userId, {
      name: "Funding",
      openingBalance: 100000,
      currentBalance: 100000,
    });
    fundingAccountId = funding.id;

    const securitiesService = module.get(SecuritiesService);
    const security = await withUserContext(userId, () =>
      securitiesService.create(userId, {
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;

    // Seed the starting position (10 shares) through a real BUY, so the holding
    // row the barrier locks exists before the race.
    await withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerageAccountId,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityId,
        fundingAccountId,
        quantity: SEED_QTY,
        price: SEED_PRICE,
        commission: 0,
      }),
    );

    const seeded = await withUserContext(userId, () =>
      holdings.findByAccountAndSecurity(brokerageAccountId, securityId),
    );
    if (!seeded) throw new Error("seed BUY did not create a holding");
    holdingId = seeded.id;
    seededQty = Number(seeded.quantity);
    seededAvgCost = Number(seeded.averageCost);
  });

  /**
   * Poll until at least `expected` backends in this database are blocked waiting
   * on a lock. Condition-driven: both trades are guaranteed to park (on the
   * barrier row lock without the mechanism, or one on the barrier and one on the
   * advisory lock with it), so this resolves once they have. The attempt cap is a
   * safety net against a wiring mistake, never the timing source.
   */
  async function waitForBlockedBackends(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows: { c: number }[] = await dataSource.query(
        `SELECT count(*)::int AS c
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'`,
      );
      if (rows[0].c >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Timed out waiting for ${expected} lock-blocked backend(s); the race was ` +
        "never set up, so the test would prove nothing.",
    );
  }

  it("does not lose an update: stored holding reflects BOTH concurrent trades", async () => {
    // Deterministic replay of both buys over the actual seeded position. Both are
    // buys, so the blended average cost -- total cost / total quantity -- is
    // order-independent, which is why the assertion holds whichever trade the
    // scheduler runs first.
    const expectedQty = seededQty + TRADE_1.qty + TRADE_2.qty; // 13
    const expectedAvgCost =
      (seededQty * seededAvgCost +
        TRADE_1.qty * TRADE_1.price +
        TRADE_2.qty * TRADE_2.price) /
      expectedQty;

    let releaseBarrier!: () => void;
    const barrierCanRelease = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let signalBarrierHeld!: () => void;
    const barrierHeld = new Promise<void>((resolve) => {
      signalBarrierHeld = resolve;
    });

    // Hold a row lock on the holding so both trades block at their write, after
    // reading. This is the barrier that makes the interleaving deterministic; it
    // is not the mechanism under test.
    const barrierDone = withUserContext(userId, () =>
      withScopedDb(dataSource, async (m) => {
        await m.query(`SELECT id FROM holdings WHERE id = $1 FOR UPDATE`, [
          holdingId,
        ]);
        signalBarrierHeld();
        await barrierCanRelease;
      }),
    );

    await barrierHeld;

    // Two concurrent trades, each on its own connection/transaction, through the
    // real holdings mutation path (createOrUpdate -> lockHoldingScope -> RMW).
    const trade1 = withUserContext(userId, () =>
      holdings.createOrUpdate(
        userId,
        brokerageAccountId,
        securityId,
        TRADE_1.qty,
        TRADE_1.price,
      ),
    );
    const trade2 = withUserContext(userId, () =>
      holdings.createOrUpdate(
        userId,
        brokerageAccountId,
        securityId,
        TRADE_2.qty,
        TRADE_2.price,
      ),
    );

    // Wait until both trades have parked (both on the barrier without the lock;
    // one on the barrier and one on the advisory lock with it), then release.
    await waitForBlockedBackends(2);
    releaseBarrier();

    await Promise.all([barrierDone, trade1, trade2]);

    const holding = await dataSource.manager.findOneOrFail(Holding, {
      where: { id: holdingId },
    });
    expect(Number(holding.quantity)).toBe(expectedQty);
    expect(Number(holding.averageCost)).toBeCloseTo(expectedAvgCost, 6);

    // Sanity: the seed really was the classic 10-share starting position, so the
    // 13-vs-12 lost-update gap is exactly the one the invariant is about.
    expect(seededQty).toBe(SEED_QTY);
    expect(expectedQty).toBe(13);
  });
});
