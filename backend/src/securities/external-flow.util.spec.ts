import {
  externalFlowSubtotalsSql,
  loadExternalFlowSubtotals,
} from "./external-flow.util";

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("external-flow.util", () => {
  describe("externalFlowSubtotalsSql", () => {
    /**
     * The statement `PortfolioMovementAlertService.externalFlow` issued before
     * this module existed, copied verbatim from its last commit with the two
     * shared exclusions expanded. `PortfolioMovementAlertService` has no unit
     * spec of its own, so this literal IS the proof that the extraction changed
     * no row: if the generated predicate ever stops matching it, the daily
     * movement notification has silently started measuring something else.
     */
    const ORIGINAL_UNSCOPED = `
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND a.account_type = 'INVESTMENT'
        AND t.parent_transaction_id IS NULL
        AND t.transaction_date > $2
        AND t.transaction_date <= $3
        AND t.status IS DISTINCT FROM 'VOID'
        AND NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = t.id)
        AND NOT EXISTS (
          SELECT 1 FROM transaction_splits s
           WHERE s.transaction_id = t.id
             AND NOT (s.kind IS DISTINCT FROM 'investment'
        AND NOT EXISTS (SELECT 1 FROM investment_transactions its WHERE its.transaction_split_id = s.id))
        )
        AND NOT (
          t.is_transfer = true
          AND EXISTS (
            SELECT 1 FROM transactions lt
             JOIN accounts la ON la.id = lt.account_id
             WHERE lt.id = t.linked_transaction_id
               AND la.account_type = 'INVESTMENT'
          )
        )
      GROUP BY t.currency_code`;

    it("reproduces the notification's original statement exactly", () => {
      const sql = externalFlowSubtotalsSql({ scoped: false, perDay: false });
      // The only addition is a NULL date column, so one shape serves both
      // callers; every row-selecting clause is the original.
      expect(squash(sql)).toContain(squash(ORIGINAL_UNSCOPED));
      expect(squash(sql)).toContain(
        "SELECT NULL::TEXT AS date, t.currency_code AS currency, SUM(t.amount) AS total",
      );
    });

    it("draws the boundary around an explicit account set on both sides of a transfer", () => {
      const sql = squash(
        externalFlowSubtotalsSql({ scoped: true, perDay: false }),
      );
      // Both sides, or the predicate is not a boundary: scoping only the row's
      // own account would count a transfer between two scoped accounts.
      expect(sql).toContain("AND a.id = ANY($4::UUID[])");
      expect(sql).toContain("AND la.id = ANY($4::UUID[])");
      expect(sql).not.toContain("a.account_type = 'INVESTMENT'");
    });

    it("subtotals per day only when asked", () => {
      const perDay = squash(
        externalFlowSubtotalsSql({ scoped: true, perDay: true }),
      );
      expect(perDay).toContain("t.transaction_date::TEXT AS date");
      expect(perDay).toContain("GROUP BY t.transaction_date, t.currency_code");

      const whole = squash(
        externalFlowSubtotalsSql({ scoped: true, perDay: false }),
      );
      expect(whole).toContain("NULL::TEXT AS date");
      expect(whole).toContain("GROUP BY t.currency_code");
    });

    it("excludes a split child, a VOID row and an investment-linked row in every form", () => {
      for (const scoped of [true, false]) {
        for (const perDay of [true, false]) {
          const sql = squash(externalFlowSubtotalsSql({ scoped, perDay }));
          expect(sql).toContain("t.parent_transaction_id IS NULL");
          expect(sql).toContain("t.status IS DISTINCT FROM 'VOID'");
          expect(sql).toContain(
            "NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = t.id)",
          );
          expect(sql).toContain("s.kind IS DISTINCT FROM 'investment'");
          expect(sql).toContain("its.transaction_split_id = s.id");
        }
      }
    });
  });

  describe("loadExternalFlowSubtotals", () => {
    it("coerces the numeric column and carries the day through", async () => {
      const query = jest.fn().mockResolvedValue([
        { date: "2026-09-11", currency: "CAD", total: "1000.0000" },
        { date: "2026-09-11", currency: "USD", total: "-250.5000" },
      ]);

      const rows = await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
        perDay: true,
      });

      expect(rows).toEqual([
        { date: "2026-09-11", currency: "CAD", amount: 1000 },
        { date: "2026-09-11", currency: "USD", amount: -250.5 },
      ]);
    });

    it("reads the [rows, count] shape a driver may hand back", async () => {
      const query = jest
        .fn()
        .mockResolvedValue([[{ date: null, currency: "CAD", total: "5" }], 1]);

      const rows = await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
      });

      expect(rows).toEqual([{ date: null, currency: "CAD", amount: 5 }]);
    });

    it("passes the account ids as the fourth parameter when scoped", async () => {
      const query = jest.fn().mockResolvedValue([]);

      await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
        accountIds: ["acc-1"],
      });

      expect(query.mock.calls[0][1]).toEqual([
        "u1",
        "2026-09-10",
        "2026-09-11",
        ["acc-1"],
      ]);
    });

    it("omits the fourth parameter when the scope is every investment account", async () => {
      const query = jest.fn().mockResolvedValue([]);

      await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
      });

      expect(query.mock.calls[0][1]).toEqual([
        "u1",
        "2026-09-10",
        "2026-09-11",
      ]);
    });

    it("totals nothing for an explicit but empty scope, and asks the database nothing", async () => {
      const query = jest.fn();

      const rows = await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
        accountIds: [],
      });

      // An empty scope is a scope nothing is in -- NOT "every investment
      // account", which is what falling through to the unscoped form would mean.
      expect(rows).toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });
  });
});
