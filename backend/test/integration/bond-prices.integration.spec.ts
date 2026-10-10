import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { bondInstrumentId } from "@/bonds/bond-instrument-id";
import { BondPriceService } from "@/bonds/bond-price.service";
import { BondValuationService } from "@/bonds/bond-valuation.service";
import { acquireAdvisoryLock, LockScope } from "@/common/db/locks";
import { withScopedDb } from "@/common/db/scoped-db";
import { withSystemContext, withUserContext } from "@/common/db/with-context";
import { todayYMD } from "@/common/date-utils";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { SecurityPriceService } from "@/securities/security-price.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * Phase 3 (spec 12) against a real PostgreSQL: the conditional upsert, the stale
 * delete and the ownership predicate are properties of SQL that a mocked manager
 * cannot show (docs/verification-contract.md, INV-BOND-005).
 *
 * The expected prices are computed here from the issue letter's own formula with
 * integers -- 100 x (1 + 0.044 a / 365), half-up to the cent, for a days into
 * the first 365-day period -- never read back from the code under test.
 */
describe("bond engine prices (integration, INV-BOND-005)", () => {
  jest.setTimeout(120000);

  let module: TestingModule;
  let dataSource: DataSource;
  let prices: BondPriceService;
  let valuation: BondValuationService;
  let securities: SecuritiesService;
  let priceService: SecurityPriceService;
  let catalog: BondCatalogService;

  let userId: string;
  let otherUserId: string;
  let accountId: string;
  let securityId: string;
  const TOS_ID = bondInstrumentId("PL", "PL_MF", "TOS1029");
  const realFetch = global.fetch;

  /** Per-bond gross value `a` days into a 365-day period, in cents. */
  function grossCents(a: number): bigint {
    const num = 10000n * (365000n + 44n * BigInt(a));
    return (2n * num + 365000n) / (2n * 365000n);
  }
  /** A cent amount as the NUMERIC(24,10) text PostgreSQL returns. */
  const cents = (c: bigint) =>
    `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}00000000`;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    dataSource = module.get(DataSource);
    prices = module.get(BondPriceService);
    valuation = module.get(BondValuationService);
    securities = module.get(SecuritiesService);
    priceService = module.get(SecurityPriceService);
    catalog = module.get(BondCatalogService);
  });

  afterAll(async () => {
    global.fetch = realFetch;
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "security_prices",
      "investment_transactions",
      "securities",
      "accounts",
      "bond_instruments",
      "benchmark_series",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'zl', 2, true), ('USD', 'US Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    await withSystemContext(() => catalog.seed());

    userId = (await createTestUserDirect(dataSource)).id;
    otherUserId = (await createTestUserDirect(dataSource)).id;

    const accounts = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Brokerage', 'PLN', 0, 0)
       RETURNING id`,
      [userId],
    );
    accountId = accounts[0].id;

    securityId = await insertSecurity("TOS1029", TOS_ID);
  });

  async function insertSecurity(
    symbol: string,
    bondId: string | null,
    owner = userId,
  ): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_instrument_id)
       VALUES ($1, $2, $2, 'BOND', 'PLN', $3)
       RETURNING id`,
      [owner, symbol, bondId],
    );
    return rows[0].id;
  }

  async function ledger(
    action: string,
    date: string,
    quantity: number,
    id = securityId,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, 100, $7, 'UNRECONCILED')`,
      [userId, accountId, id, action, date, quantity, quantity * 100],
    );
  }

  const recompute = (today: string, id = securityId) =>
    withUserContext(userId, () =>
      prices.recomputeSecurity(userId, id, { today }),
    );

  async function priceRows(id = securityId) {
    return dataSource.query(
      `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') AS d, close_price::text AS p, source, xmin::text AS x
         FROM security_prices WHERE security_id = $1 ORDER BY price_date`,
      [id],
    );
  }

  it("seeds each instrument under its deterministic id", async () => {
    const rows = await dataSource.query(
      `SELECT id FROM bond_instruments WHERE series_code = 'TOS1029'`,
    );
    expect(rows).toEqual([{ id: TOS_ID }]);
  });

  describe("recompute", () => {
    it("writes one bond_engine row per day, equal to the letter's value per bond", async () => {
      await ledger("BUY", "2026-10-15", 25);

      const result = await recompute("2027-04-15");

      const rows = await priceRows();
      // 2026-10-15 .. 2027-04-15 inclusive: 182 days elapsed, 183 rows.
      expect(rows).toHaveLength(183);
      expect(result).toEqual({ written: 183, deleted: 0 });
      expect(new Set(rows.map((r: { source: string }) => r.source))).toEqual(
        new Set(["bond_engine"]),
      );
      expect(rows[0]).toMatchObject({ d: "2026-10-15", p: "100.0000000000" });
      // The TOS value 182 days in: round(100 x (1 + 0.044 x 182 / 365), 2).
      expect(grossCents(182)).toBe(10219n);
      expect(rows[182]).toMatchObject({ d: "2027-04-15", p: "102.1900000000" });
      for (const a of [1, 17, 90, 181]) {
        expect(rows[a].p).toBe(cents(grossCents(a)));
      }
    });

    it("prices each day on the lots held that day: a sale ends the prices, a purchase restarts them", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await ledger("SELL", "2026-10-20", 10);
      await ledger("BUY", "2026-10-25", 5);

      await recompute("2026-10-26");

      const dates = (await priceRows()).map((r: { d: string }) => r.d);
      expect(dates).toEqual([
        "2026-10-15",
        "2026-10-16",
        "2026-10-17",
        "2026-10-18",
        "2026-10-19",
        "2026-10-25",
        "2026-10-26",
      ]);
    });

    it("never overwrites a manual or a transaction-derived price, and does not count them", async () => {
      await ledger("BUY", "2026-10-15", 25);
      await dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ($1, '2026-10-20', 999, 'manual'),
                ($1, '2026-10-21', 888, 'buy'),
                ($1, '2026-10-22', 777, 'yahoo_finance')`,
        [securityId],
      );

      const result = await recompute("2026-10-25");

      const byDate = new Map(
        (await priceRows()).map((r: { d: string }) => [r.d, r]),
      );
      expect(byDate.get("2026-10-20")).toMatchObject({
        p: "999.0000000000",
        source: "manual",
      });
      expect(byDate.get("2026-10-21")).toMatchObject({
        p: "888.0000000000",
        source: "buy",
      });
      expect(byDate.get("2026-10-22")).toMatchObject({
        p: "777.0000000000",
        source: "yahoo_finance",
      });
      // 11 days, three of them taken by other sources.
      expect(result).toEqual({ written: 8, deleted: 0 });
      expect(byDate.get("2026-10-23")).toMatchObject({ source: "bond_engine" });
    });

    it("does not rewrite a day whose price is unchanged, and corrects one that differs", async () => {
      await ledger("BUY", "2026-10-15", 25);
      await recompute("2026-10-20");
      const before = await priceRows();

      await expect(recompute("2026-10-20")).resolves.toEqual({
        written: 0,
        deleted: 0,
      });
      expect(await priceRows()).toEqual(before);

      // A stale engine row (an old terms version, say) is corrected in place.
      await dataSource.query(
        `UPDATE security_prices SET close_price = 1 WHERE security_id = $1 AND price_date = '2026-10-17'`,
        [securityId],
      );
      await expect(recompute("2026-10-20")).resolves.toEqual({
        written: 1,
        deleted: 0,
      });
      expect((await priceRows())[2]).toMatchObject({
        d: "2026-10-17",
        p: cents(grossCents(2)),
      });
    });

    it("deletes bond_engine rows of days that no longer have a price, and nothing else", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ($1, '2026-10-17', 999, 'manual')`,
        [securityId],
      );
      await recompute("2026-10-20");
      expect(await priceRows()).toHaveLength(6);

      // The purchase is voided: no lots, no price on any day.
      await dataSource.query(
        `UPDATE investment_transactions SET status = 'VOID' WHERE security_id = $1`,
        [securityId],
      );
      const result = await recompute("2026-10-20");

      expect(result).toEqual({ written: 0, deleted: 5 });
      expect(await priceRows()).toEqual([
        expect.objectContaining({ d: "2026-10-17", source: "manual" }),
      ]);
    });

    it("moves the holding account's updated_at marker in the same transaction", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await dataSource.query(
        `UPDATE accounts SET updated_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
        [accountId],
      );
      const before = await dataSource.query(
        `SELECT updated_at FROM accounts WHERE id = $1`,
        [accountId],
      );
      await recompute("2026-10-20");
      const after = await dataSource.query(
        `SELECT updated_at FROM accounts WHERE id = $1`,
        [accountId],
      );
      expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(
        new Date(before[0].updated_at).getTime(),
      );
    });

    it("prices nothing for a lot with no derivable quantity: a split names why, and earlier days stay priced", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await ledger("SPLIT", "2026-10-18", 2);
      await recompute("2026-10-22");
      expect((await priceRows()).map((r: { d: string }) => r.d)).toEqual([
        "2026-10-15",
        "2026-10-16",
        "2026-10-17",
      ]);
      const view = await withUserContext(userId, () =>
        valuation.valueSecurity(userId, securityId, "2026-10-22"),
      );
      expect(view.refusal).toMatchObject({ code: "SPLIT" });
    });
  });

  describe("another user's security", () => {
    it("cannot be valued, recomputed or read by a user who does not own it", async () => {
      await ledger("BUY", "2026-10-15", 25);

      await expect(
        withUserContext(otherUserId, () =>
          valuation.valueSecurity(otherUserId, securityId, "2027-04-15"),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withUserContext(otherUserId, () =>
          prices.recomputeSecurity(otherUserId, securityId, {
            today: "2027-04-15",
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await priceRows()).toEqual([]);

      // The owner reads the same ledger: 25 bonds, 182 days in, 25 x 102.19.
      const owner = await withUserContext(userId, () =>
        valuation.valueSecurity(userId, securityId, "2027-04-15"),
      );
      expect(owner.totals).toMatchObject({
        quantity: 25,
        grossValue: "2554.75",
      });
      expect(owner.lots[0].valuation.earlyRedemptionValue).toBe("2529.75");
    });

    it("answers 404 for an unlinked security, exactly like a foreign one", async () => {
      const plain = await insertSecurity("PLAIN", null);
      await expect(
        withUserContext(userId, () =>
          valuation.valueSecurity(userId, plain, "2027-04-15"),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("quote providers never price a linked security (D)", () => {
    afterEach(() => {
      global.fetch = realFetch;
    });

    it("skips it in every refresh path, while an unlinked security beside it is still asked for", async () => {
      const fetchSpy = jest
        .fn()
        .mockRejectedValue(new Error("network disabled"));
      global.fetch = fetchSpy as never;
      // The strongest opt-in a user can give a provider.
      await dataSource.query(
        `UPDATE securities SET quote_provider = 'yahoo', skip_price_updates = false WHERE id = $1`,
        [securityId],
      );

      const all = await priceService.refreshAllPrices();
      const selected = await withUserContext(userId, () =>
        priceService.refreshPricesForSecurities([securityId]),
      );
      const settled = await priceService.settleDailyBars();
      const filled = await withUserContext(userId, () =>
        priceService.ensurePricesForDate([securityId], "2026-10-01"),
      );
      const backfill = await withSystemContext(() =>
        priceService.backfillHistoricalPrices(),
      );

      expect(all.totalSecurities).toBe(0);
      expect(selected.totalSecurities).toBe(0);
      expect(settled.totalSecurities).toBe(0);
      expect(filled).toBe(0);
      expect(backfill.totalSecurities).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Not vacuous: the same call for an unlinked security does ask.
      const plain = await insertSecurity("PLAIN", null);
      const asked = await withUserContext(userId, () =>
        priceService.refreshPricesForSecurities([plain, securityId]),
      );
      expect(asked.totalSecurities).toBe(1);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("linking through the security API (C)", () => {
    it("refuses a missing instrument and a currency mismatch before writing, then prices the link after commit", async () => {
      const plain = await insertSecurity("LINKME", null);
      await ledger("BUY", "2026-01-05", 10, plain);

      const update = (dto: Parameters<SecuritiesService["update"]>[2]) =>
        withUserContext(userId, () => securities.update(userId, plain, dto));

      await expect(
        update({
          bondInstrumentId: "99999999-9999-5999-8999-999999999999",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await dataSource.query(
        `UPDATE securities SET currency_code = 'USD' WHERE id = $1`,
        [plain],
      );
      await expect(update({ bondInstrumentId: TOS_ID })).rejects.toThrow(
        /recorded in USD.*priced in PLN/,
      );
      expect(await priceRows(plain)).toEqual([]);
      expect(
        (
          await dataSource.query(
            `SELECT bond_instrument_id FROM securities WHERE id = $1`,
            [plain],
          )
        )[0].bond_instrument_id,
      ).toBeNull();

      // Currency and link together, in the instrument's currency: committed,
      // then priced up to today (the request recomputes after its commit).
      const linked = await update({
        currencyCode: "PLN",
        bondInstrumentId: TOS_ID,
      });
      expect(linked.bondInstrumentId).toBe(TOS_ID);
      const rows = await priceRows(plain);
      expect(rows.length).toBeGreaterThan(200);
      expect(rows[0]).toMatchObject({ d: "2026-01-05", source: "bond_engine" });
      expect(rows[rows.length - 1].d).toBe(todayYMD());

      // A currency change of a linked security is refused; unlinking first is the way.
      await expect(update({ currencyCode: "USD" })).rejects.toThrow(
        /stays in the instrument's currency \(PLN\)/,
      );
    });

    it("refuses deleting a catalog instrument that a security points at, by fk_securities_bond_instrument and nothing else (ON DELETE RESTRICT)", async () => {
      // An instrument with no terms version and no period rate, so no other
      // foreign key can be what refuses the delete.
      const bare = await dataSource.query(
        `INSERT INTO bond_instruments (issuer_country_code, issuer_code, program_code, series_code, currency_code, marketability)
         VALUES ('PL', 'PL_MF', 'TOS', 'BARE0000', 'PLN', 'RETAIL_REDEEMABLE') RETURNING id`,
      );
      await insertSecurity("BARE", bare[0].id);
      await expect(
        dataSource.query(`DELETE FROM bond_instruments WHERE id = $1`, [
          bare[0].id,
        ]),
      ).rejects.toThrow(/"fk_securities_bond_instrument"/);

      // Unlinked, the same row deletes: the constraint is the only guard.
      await dataSource.query(
        `UPDATE securities SET bond_instrument_id = NULL WHERE bond_instrument_id = $1`,
        [bare[0].id],
      );
      await dataSource.query(`DELETE FROM bond_instruments WHERE id = $1`, [
        bare[0].id,
      ]);
    });

    it("unlinking deletes the engine's rows in the same transaction and leaves every other source", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ($1, '2026-10-17', 999, 'manual'), ($1, '2026-10-16', 100, 'buy')`,
        [securityId],
      );
      await recompute("2026-10-20");
      expect(
        (await priceRows()).map((r: { source: string }) => r.source),
      ).toContain("bond_engine");

      await withUserContext(userId, () =>
        securities.update(userId, securityId, { bondInstrumentId: null }),
      );

      expect(await priceRows()).toEqual([
        expect.objectContaining({ d: "2026-10-16", source: "buy" }),
        expect.objectContaining({ d: "2026-10-17", source: "manual" }),
      ]);
      // Nothing re-creates them: the security is no longer the engine's, and an
      // explicit recompute refuses it.
      await expect(recompute("2026-10-20")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await priceRows()).toHaveLength(2);
    });

    it("moving the link to another instrument replaces the old instrument's prices with the new one's", async () => {
      await ledger("BUY", "2026-10-01", 10);
      await recompute("2026-10-05");
      const before = await priceRows();
      expect(before).toHaveLength(5);

      await withUserContext(userId, () =>
        securities.update(userId, securityId, {
          bondInstrumentId: bondInstrumentId("PL", "PL_MF", "ROS1032"),
        }),
      );

      const after = await priceRows();
      expect(
        after.every((r: { source: string }) => r.source === "bond_engine"),
      ).toBe(true);
      // Priced from the new instrument, up to today: not the TOS rows left over.
      expect(after[after.length - 1].d).toBe(todayYMD());
      expect(after.slice(0, 5).map((r: { p: string }) => r.p)).not.toEqual(
        before.map((r: { p: string }) => r.p),
      );
    });
  });

  describe("recomputes of one security are serialized and read the link under the lock (#55, #70)", () => {
    it("a recompute that starts while an unlink holds the lock waits, then finds no link and refuses", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-20");
      expect(await priceRows()).toHaveLength(6);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => (locked = resolve));

      // The unlink's transaction: the engine lock first, then the delete and the
      // link change, committed only when the gate opens.
      const unlink = withUserContext(userId, () =>
        withScopedDb(dataSource, async (m) => {
          await prices.clearEnginePrices(m, userId, securityId);
          await m.query(
            `UPDATE securities SET bond_instrument_id = NULL WHERE id = $1`,
            [securityId],
          );
          locked();
          await gate;
        }),
      );
      await lockHeld;

      let settled = false;
      const waiting = recompute("2026-10-25").then(
        () => {
          settled = true;
          return "resolved";
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await new Promise((r) => setTimeout(r, 400));
      // Not finished: it is queued behind the lock, not racing the unlink.
      expect(settled).toBe(false);

      release();
      await unlink;
      const outcome = await waiting;
      expect(outcome).toBeInstanceOf(NotFoundException);
      // It wrote nothing after the unlink deleted the engine's rows.
      expect(await priceRows()).toEqual([]);
    });

    it("two recomputes of the same security queue on the lock; the key is per security", async () => {
      await ledger("BUY", "2026-10-15", 10);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => (locked = resolve));
      const holder = withUserContext(userId, () =>
        withScopedDb(dataSource, async (m) => {
          await acquireAdvisoryLock(
            m,
            LockScope.BondPriceRecompute,
            securityId,
          );
          locked();
          await gate;
        }),
      );
      await lockHeld;

      // A different security's recompute is not held up.
      const other = await insertSecurity("TOS-OTHER", TOS_ID);
      await ledger("BUY", "2026-10-15", 3, other);
      await expect(recompute("2026-10-17", other)).resolves.toEqual({
        written: 3,
        deleted: 0,
      });

      let settled = false;
      const same = recompute("2026-10-17").then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      release();
      await holder;
      await same;
      expect(await priceRows()).toHaveLength(3);
    });
  });

  describe("a transaction price and the engine, in either order of writing (INV-BOND-005)", () => {
    const buyOn20th = () =>
      dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, 'BUY', '2026-10-20', 5, 100.5, 502.5, 'UNRECONCILED')`,
        [userId, accountId, securityId],
      );

    it("a trade recorded after the engine priced the day replaces the engine's row, and the engine does not take it back", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-22");
      expect((await priceRows())[5]).toMatchObject({
        d: "2026-10-20",
        source: "bond_engine",
      });

      await buyOn20th();
      await withUserContext(userId, () =>
        priceService.upsertTransactionPrice(securityId, "2026-10-20"),
      );
      expect((await priceRows())[5]).toMatchObject({
        d: "2026-10-20",
        p: "100.5000000000",
        source: "buy",
      });

      // The next recompute leaves the trade's price alone.
      await recompute("2026-10-22");
      expect((await priceRows())[5]).toMatchObject({
        d: "2026-10-20",
        p: "100.5000000000",
        source: "buy",
      });
    });

    it("a trade recorded before the engine runs keeps its row (the other order ends the same)", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await buyOn20th();
      await withUserContext(userId, () =>
        priceService.upsertTransactionPrice(securityId, "2026-10-20"),
      );
      await recompute("2026-10-22");
      expect((await priceRows())[5]).toMatchObject({
        d: "2026-10-20",
        p: "100.5000000000",
        source: "buy",
      });
    });

    it("the bulk transaction-price backfill replaces an engine row too, and never a manual one", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-22");
      await dataSource.query(
        `UPDATE security_prices SET source = 'manual', close_price = 999 WHERE security_id = $1 AND price_date = '2026-10-16'`,
        [securityId],
      );
      await withSystemContext(() => priceService.backfillTransactionPrices());
      const byDate = new Map(
        (await priceRows()).map((r: { d: string }) => [r.d, r]),
      );
      // The BUY's own day: the trade's price over the engine's row.
      expect(byDate.get("2026-10-15")).toMatchObject({ source: "buy" });
      expect(byDate.get("2026-10-16")).toMatchObject({ source: "manual" });
      expect(byDate.get("2026-10-17")).toMatchObject({ source: "bond_engine" });
    });
  });

  describe("a provider write re-checks the link when it writes (#44)", () => {
    const bars = [
      {
        date: new Date("2026-10-16T00:00:00.000Z"),
        open: null,
        high: null,
        low: null,
        close: 55,
        adjClose: null,
        volume: null,
      },
      {
        date: new Date("2026-10-17T00:00:00.000Z"),
        open: null,
        high: null,
        low: null,
        close: 56,
        adjClose: null,
        volume: null,
      },
    ];
    type Writers = {
      bulkUpsertPrices: (s: unknown, p: unknown, src: string) => Promise<void>;
      savePriceData: (s: unknown, d: string, q: unknown) => Promise<unknown>;
    };
    const writers = () => priceService as unknown as Writers;

    it("a history write for a security linked since its list was loaded writes nothing, and does not replace the engine's rows", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-17");
      const before = await priceRows();
      expect(before).toHaveLength(3);

      // The job loaded this security while it was unlinked; it is linked now.
      await withUserContext(userId, () =>
        writers().bulkUpsertPrices(
          { id: securityId, userId },
          bars,
          "yahoo_finance",
        ),
      );
      expect(await priceRows()).toEqual(before);
    });

    it("a quote write for a linked security writes nothing either", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-17");
      const before = await priceRows();
      await expect(
        withUserContext(userId, () =>
          writers().savePriceData({ id: securityId, userId }, "2026-10-17", {
            symbol: "TOS1029",
            regularMarketPrice: 77,
          }),
        ),
      ).resolves.toMatchObject({ source: "bond_engine" });
      expect(await priceRows()).toEqual(before);
    });

    it("an unlinked security still gets its provider rows, and a manual price is still protected", async () => {
      const plain = await insertSecurity("PLAIN", null);
      await dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ($1, '2026-10-17', 999, 'manual')`,
        [plain],
      );
      await withUserContext(userId, () =>
        writers().bulkUpsertPrices(
          { id: plain, userId },
          bars,
          "yahoo_finance",
        ),
      );
      expect(await priceRows(plain)).toEqual([
        expect.objectContaining({
          d: "2026-10-16",
          p: "55.0000000000",
          source: "yahoo_finance",
        }),
        expect.objectContaining({
          d: "2026-10-17",
          p: "999.0000000000",
          source: "manual",
        }),
      ]);
    });
  });

  describe("transfers keep their lot's purchase date (spec 12.2)", () => {
    let otherAccount: string;

    beforeEach(async () => {
      otherAccount = (
        await dataSource.query(
          `INSERT INTO accounts (user_id, account_type, account_sub_type, name, currency_code, current_balance, opening_balance)
           VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Second', 'PLN', 0, 0) RETURNING id`,
          [userId],
        )
      )[0].id;
      await ledger("BUY", "2026-10-15", 10);
    });

    const leg = async (
      account: string,
      action: string,
      status = "UNRECONCILED",
    ): Promise<string> =>
      (
        await dataSource.query(
          `INSERT INTO investment_transactions
             (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
           VALUES ($1, $2, $3, $4, '2026-11-01', 10, 100, 1000, $5) RETURNING id`,
          [userId, account, securityId, action, status],
        )
      )[0].id;

    const link = (from: string, to: string) =>
      dataSource.query(
        `UPDATE investment_transactions SET linked_transaction_id = $2 WHERE id = $1`,
        [from, to],
      );

    const priceOn = async (date: string) =>
      (await priceRows()).find((r: { d: string }) => r.d === date);

    it("a linked pair, stored on both legs, leaves the original purchase date: accrual continues from 2026-10-15", async () => {
      const out = await leg(accountId, "TRANSFER_OUT");
      const inn = await leg(otherAccount, "TRANSFER_IN");
      await link(out, inn);
      await link(inn, out);
      await recompute("2026-11-05");
      // 21 days since the purchase, not 4 since the transfer.
      expect((await priceOn("2026-11-05"))?.p).toBe(cents(grossCents(21)));
    });

    it("a pair linked from one leg only is the same pair", async () => {
      const out = await leg(accountId, "TRANSFER_OUT");
      const inn = await leg(otherAccount, "TRANSFER_IN");
      await link(inn, out);
      await recompute("2026-11-05");
      expect((await priceOn("2026-11-05"))?.p).toBe(cents(grossCents(21)));
    });

    it("an unlinked pair is not paired, and the lot restarts at the transfer", async () => {
      await leg(accountId, "TRANSFER_OUT");
      await leg(otherAccount, "TRANSFER_IN");
      await recompute("2026-11-05");
      // Not the original lot's accrual: a lot dated the transfer day, 4 days in.
      expect((await priceOn("2026-11-05"))?.p).not.toBe(cents(grossCents(21)));
    });

    it("a leg that is VOID is not a partner: the other leg stands alone", async () => {
      const out = await leg(accountId, "TRANSFER_OUT");
      const inn = await leg(otherAccount, "TRANSFER_IN", "VOID");
      await link(out, inn);
      await recompute("2026-11-05");
      // The remaining TRANSFER_OUT removed the lot: no price after the transfer.
      expect(await priceOn("2026-11-05")).toBeUndefined();
    });
  });

  describe("the daily job", () => {
    it("recomputes every user's linked securities, one failure not stopping the rest", async () => {
      await ledger("BUY", "2026-10-15", 10);
      const otherAccount = await dataSource.query(
        `INSERT INTO accounts (user_id, account_type, account_sub_type, name, currency_code, current_balance, opening_balance)
         VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'B2', 'PLN', 0, 0) RETURNING id`,
        [otherUserId],
      );
      const otherSecurity = await insertSecurity("TOS-B", TOS_ID, otherUserId);
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, 'BUY', '2026-10-16', 4, 100, 400, 'UNRECONCILED')`,
        [otherUserId, otherAccount[0].id, otherSecurity],
      );

      const result = await withSystemContext(() =>
        prices.recomputeAll({ today: "2026-10-20" }),
      );

      expect(result).toEqual({ securities: 2, failed: 0 });
      expect(await priceRows(securityId)).toHaveLength(6);
      expect(await priceRows(otherSecurity)).toHaveLength(5);
    });

    it("one security failing for real leaves the others' prices written", async () => {
      await ledger("BUY", "2026-10-15", 10);
      // An instrument with no terms version: valuing a security linked to it
      // fails inside the transaction, as stored reference data gone wrong would.
      const bare = await dataSource.query(
        `INSERT INTO bond_instruments (issuer_country_code, issuer_code, program_code, series_code, currency_code, marketability)
         VALUES ('PL', 'PL_MF', 'TOS', 'BROKEN00', 'PLN', 'RETAIL_REDEEMABLE') RETURNING id`,
      );
      const broken = await insertSecurity("BROKEN", bare[0].id, otherUserId);
      const otherAccount = await dataSource.query(
        `INSERT INTO accounts (user_id, account_type, account_sub_type, name, currency_code, current_balance, opening_balance)
         VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'B3', 'PLN', 0, 0) RETURNING id`,
        [otherUserId],
      );
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, 'BUY', '2026-10-16', 4, 100, 400, 'UNRECONCILED')`,
        [otherUserId, otherAccount[0].id, broken],
      );

      const result = await withSystemContext(() =>
        prices.recomputeAll({ today: "2026-10-20" }),
      );

      expect(result).toEqual({ securities: 2, failed: 1 });
      expect(await priceRows(securityId)).toHaveLength(6);
      expect(await priceRows(broken)).toEqual([]);
    });
  });

  describe("inflation scenarios (spec 13.3)", () => {
    let edoSecurityId: string;

    beforeEach(async () => {
      await dataSource.query(
        `INSERT INTO benchmark_series (code, kind, publisher, source_url, unit)
         VALUES ('PL_CPI_GUS_YOY', 'MONTHLY', 'GUS', 'https://example.test/cpi', 'FRACTION')
         ON CONFLICT (code) DO NOTHING`,
      );
      await dataSource.query(
        `INSERT INTO benchmark_values (benchmark_code, observation_date, value, source_url, retrieved_at)
         VALUES ('PL_CPI_GUS_YOY', '2027-08-01', 0.0340000000, 'https://example.test/cpi', NOW())
         ON CONFLICT (benchmark_code, observation_date) DO UPDATE SET value = EXCLUDED.value`,
      );
      edoSecurityId = await insertSecurity(
        "EDO1036",
        bondInstrumentId("PL", "PL_MF", "EDO1036"),
      );
      await ledger("BUY", "2026-10-01", 10, edoSecurityId);
    });

    const scenarios = (values: string[], owner = userId) =>
      withUserContext(owner, () =>
        valuation.scenariosOf(
          owner,
          edoSecurityId,
          "PL_CPI_GUS_YOY",
          values,
          "2027-10-16",
        ),
      );

    it("a higher assumption raises the maturity value and the inflation interest, and leaves the known periods alone", async () => {
      const result = await scenarios(["0", "0.05"]);
      const [low, high] = result.scenarios;
      // Computed independently with python fractions (10 bonds).
      expect(low).toEqual({
        value: "0",
        maturityValue: "1301.00",
        totalInterest: "301.00",
        fixedInterest: "53.50",
        benchmarkInterest: "35.82",
        addendInterest: "211.68",
        announcedInterest: "0.00",
      });
      expect(high).toEqual({
        value: "0.05",
        maturityValue: "1907.90",
        totalInterest: "907.86",
        fixedInterest: "53.50",
        benchmarkInterest: "605.44",
        addendInterest: "248.92",
        announcedInterest: "0.00",
      });
    });

    it("the valuation follows the assumption on the same lots", async () => {
      const v = await withUserContext(userId, () =>
        valuation.valueSecurity(
          userId,
          edoSecurityId,
          "2027-10-16",
          new Map([["PL_CPI_GUS_YOY", "0.05"]]),
        ),
      );
      expect(v.lots[0].valuation.maturityValueProjected).toBe("1907.90");
    });

    it("answers 404 for another user's security", async () => {
      await expect(scenarios(["0"], otherUserId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
