import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { applyRlsPolicies, TEST_APP_ROLE } from "../helpers/rls-setup";
import { rlsExemptTableNames } from "@/common/db/rls-exempt-tables";

/**
 * Acceptance coverage for RLS task M3 -- `database/migrations/123_rls_enable.sql`,
 * the migration that makes the policies live. This file is flip B: it ships to
 * production only after flip A (the privilege drop) has soaked.
 *
 * Two properties matter and are asserted separately, because confusing them is
 * how this migration would go wrong:
 *
 * 1. It enforces exactly what is policied -- no policied table left out (which
 *    would be a silent hole under enforcement), and no unpolicied table enabled
 *    (which is a deny-all outage, not a safe default).
 * 2. It changes nothing for the table owner. At `RLS_MODE=off` the app connects
 *    as the owner, so the enable has to be observably inert there -- which is
 *    what makes it safe for schema.sql to apply it on every fresh install.
 */
describe("RLS enable migration (M3, migration 123)", () => {
  let dataSource: DataSource;

  const MIGRATION = path.join(
    __dirname,
    "../../../database/migrations/123_rls_enable.sql",
  );

  /**
   * The exemption list lives in `backend/src/common/db/rls-exempt-tables.ts`,
   * not here. It used to be spelled out in this file and three others, and they
   * had already drifted -- see that module's header.
   */
  const EXEMPT = rlsExemptTableNames();

  /**
   * Exempt tables this harness never creates.
   *
   * `rls-setup` builds the schema with TypeORM `synchronize: true` from entity
   * metadata and then applies only the RLS-carrying migrations -- it does not
   * run `database/schema.sql` wholesale. A table with no entity behind it
   * therefore does not exist here. `schema_migrations` is created by
   * `db-migrate`'s own bootstrap and is mapped by no entity, so it is absent by
   * construction rather than missing.
   *
   * Named rather than tolerated: the assertion below is exact, so an exempt
   * table that stops existing for any *other* reason still fails. This list may
   * only shrink.
   */
  const NOT_CREATED_BY_HARNESS = ["schema_migrations"];
  const EXPECTED_PRESENT = EXEMPT.filter(
    (table) => !NOT_CREATED_BY_HARNESS.includes(table),
  );

  const USER_A = "11111111-1111-4111-8111-111111111111";
  const USER_B = "22222222-2222-4222-8222-222222222222";

  /** Runs `fn` as the unprivileged runtime role, with optional identity GUCs. */
  async function asAppRole<T>(
    gucs: Record<string, string>,
    fn: (m: {
      query: (sql: string, params?: unknown[]) => Promise<any>;
    }) => Promise<T>,
  ): Promise<T> {
    return dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL ROLE ${TEST_APP_ROLE}`);
      for (const [key, value] of Object.entries(gucs)) {
        await m.query("SELECT set_config($1, $2, true)", [key, value]);
      }
      return fn(m);
    });
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      ...INTEGRATION_TYPEORM_OPTIONS,
      synchronize: true,
      dropSchema: true,
    } as never);
    await dataSource.initialize();

    if (!fs.existsSync(MIGRATION)) {
      throw new Error(`Enable migration not found at ${MIGRATION}`);
    }

    // Policies plus the enable, applied in filename order (T1's harness with
    // the M3 opt-in).
    await applyRlsPolicies(dataSource, { includeEnable: true });

    await dataSource.query(
      "INSERT INTO currencies (code, name, symbol) VALUES ('USD', 'US Dollar', '$') ON CONFLICT DO NOTHING",
    );
    for (const [id, email] of [
      [USER_A, "m3-a@example.com"],
      [USER_B, "m3-b@example.com"],
    ]) {
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, auth_provider, role, is_active, email_verified)
         VALUES ($1, $2, 'x', 'M', 'Three', 'local', 'user', true, true)`,
        [id, email],
      );
    }
    const accounts = await dataSource.query(
      `INSERT INTO accounts (user_id, name, account_type, currency_code)
       VALUES ($1, 'A acct', 'CHEQUING', 'USD'), ($2, 'B acct', 'CHEQUING', 'USD')
       RETURNING id, user_id`,
      [USER_A, USER_B],
    );

    // One transaction + split per user, so the indirect (EXISTS-to-parent)
    // policies have rows to filter. Without data on both sides, "the runtime
    // role sees zero splits" is true whether the policy works or not.
    for (const account of accounts) {
      const [txn] = await dataSource.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, description)
         VALUES ($1, $2, '2026-01-01', -10, 'USD', 'seed') RETURNING id`,
        [account.user_id, account.id],
      );
      await dataSource.query(
        `INSERT INTO transaction_splits (transaction_id, kind, amount, memo)
         VALUES ($1, 'category', -10, $2)`,
        [txn.id, account.user_id === USER_A ? "A split" : "B split"],
      );
    }
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  describe("migration hygiene", () => {
    it("contains no role or grant statements", () => {
      // Same rule as every other RLS migration: a GRANT naming the runtime role
      // crash-loops any deployment where that role does not exist.
      const sql = fs.readFileSync(MIGRATION, "utf8").replace(/^\s*--.*$/gm, "");

      expect(sql).not.toMatch(/\bGRANT\b/i);
      expect(sql).not.toMatch(/\bREVOKE\b/i);
      expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP)\s+ROLE\b/i);
      expect(sql).not.toMatch(/monize_app/i);
    });

    it("derives its target list from pg_policies rather than hard-coding tables", () => {
      const sql = fs.readFileSync(MIGRATION, "utf8");
      expect(sql).toMatch(/FROM\s+pg_policies/i);
    });

    it("never forces RLS on the owner", async () => {
      // FORCE would apply policies to the table owner too, breaking db-init,
      // db-migrate and backup restore -- and turning this migration into a
      // behaviour change at RLS_MODE=off instead of a no-op.
      const sql = fs.readFileSync(MIGRATION, "utf8");
      expect(sql).not.toMatch(/FORCE\s+ROW\s+LEVEL\s+SECURITY/i);

      const [row] = await dataSource.query(
        `SELECT count(*)::int AS n FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = 'public' AND c.relforcerowsecurity`,
      );
      expect(row.n).toBe(0);
    });
  });

  describe("enforces exactly what is policied", () => {
    it("enables RLS on every policied table", async () => {
      const rows = await dataSource.query(
        `SELECT DISTINCT p.tablename
           FROM pg_policies p
           JOIN pg_class c ON c.relname = p.tablename
           JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
          WHERE p.schemaname = 'public' AND NOT c.relrowsecurity`,
      );
      // Also the guard for the convention a post-M3 migration has to follow: a
      // new user-owned table ships its policy AND its enable. M3 has already
      // run by then, so a policy added later without an enable is inert on
      // exactly the deployed databases that matter -- and shows up here,
      // because the harness applies the enable in its filename position rather
      // than last.
      expect(rows.map((r: { tablename: string }) => r.tablename)).toEqual([]);
    });

    it("enables RLS on no table that lacks a policy", async () => {
      // A table with RLS enabled and no policy denies everything to every
      // non-owner -- an outage, and the failure mode a hard-coded table list
      // invites.
      const rows = await dataSource.query(
        `SELECT c.relname FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
            AND c.relname NOT IN (
              SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public')`,
      );
      expect(rows.map((r: { relname: string }) => r.relname)).toEqual([]);
    });

    it("leaves every exempt table untouched", async () => {
      const rows = await dataSource.query(
        `SELECT c.relname, c.relrowsecurity FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = 'public' AND c.relname = ANY($1)`,
        [EXEMPT],
      );
      // Exactly the list the harness creates, not merely a non-empty subset of
      // it: derived from RLS_EXEMPT_TABLES so it cannot go stale the way the
      // old hardcoded "four" did while the list held six, and an exempt table
      // that stops existing fails here instead of quietly dropping out of the
      // check -- which is what the old `toBeGreaterThan(0)` allowed.
      expect(rows.map((r: { relname: string }) => r.relname).sort()).toEqual(
        EXPECTED_PRESENT,
      );
      for (const row of rows) {
        expect(row.relrowsecurity).toBe(false);
      }
    });

    it("keeps the harness-absence list honest", () => {
      // Two ways this list rots, both of which would weaken the assertion above
      // without failing it: an entry that is no longer exempt at all, and an
      // entry the harness has since learned to create. Neither is a table this
      // suite may quietly stop checking.
      expect(
        NOT_CREATED_BY_HARNESS.filter((table) => !EXEMPT.includes(table)),
      ).toEqual([]);
      expect(EXPECTED_PRESENT.length).toBe(
        EXEMPT.length - NOT_CREATED_BY_HARNESS.length,
      );
    });

    it("is idempotent -- re-applying enables nothing new and errors on nothing", async () => {
      const before = await dataSource.query(
        `SELECT count(*)::int AS n FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = 'public' AND c.relrowsecurity`,
      );
      await dataSource.query(fs.readFileSync(MIGRATION, "utf8"));
      const after = await dataSource.query(
        `SELECT count(*)::int AS n FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = 'public' AND c.relrowsecurity`,
      );
      expect(after[0].n).toBe(before[0].n);
      expect(before[0].n).toBeGreaterThan(50);
    });

    it("flags a policy added after the enable, which is what the D1 convention prevents", async () => {
      // Negative control for the guard above: without it, the assertion that
      // "every policied table is enabled" could hold trivially. Here a table is
      // policied *after* M3 has run -- precisely what a future feature
      // migration does if it forgets its enable -- and the guard query must
      // report it.
      await dataSource.query(
        "CREATE TABLE IF NOT EXISTS m3_late_table (id int, user_id uuid)",
      );
      await dataSource.query(
        `CREATE POLICY m3_late_table_isolation ON m3_late_table
           USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))`,
      );

      const rows = await dataSource.query(
        `SELECT DISTINCT p.tablename
           FROM pg_policies p
           JOIN pg_class c ON c.relname = p.tablename
           JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
          WHERE p.schemaname = 'public' AND NOT c.relrowsecurity`,
      );
      expect(rows.map((r: { tablename: string }) => r.tablename)).toEqual([
        "m3_late_table",
      ]);

      await dataSource.query("DROP TABLE m3_late_table");
    });
  });

  describe("inert for the table owner -- RLS_MODE=off is unaffected", () => {
    it("lets the owner read every user's rows", async () => {
      // The app connects as the owner at RLS_MODE=off, which is the only mode
      // a deployment starts in. If this ever returns a filtered count, shipping
      // the enable in schema.sql would be a live behaviour change on fresh
      // installs.
      const [row] = await dataSource.query(
        "SELECT count(*)::int AS n FROM accounts",
      );
      expect(row.n).toBe(2);
    });

    it("lets the owner write another user's row", async () => {
      const [row] = await dataSource.query(
        `INSERT INTO accounts (user_id, name, account_type, currency_code)
         VALUES ($1, 'owner-written', 'CHEQUING', 'USD') RETURNING id`,
        [USER_B],
      );
      expect(row.id).toBeDefined();
      await dataSource.query("DELETE FROM accounts WHERE id = $1", [row.id]);
    });
  });

  describe("enforced for the runtime role -- what flip B turns on", () => {
    it("returns zero rows with no identity GUC", async () => {
      // Fail-closed: an unwrapped call path sees nothing rather than everything.
      const rows = await asAppRole({}, (m) =>
        m.query("SELECT count(*)::int AS n FROM accounts"),
      );
      expect(rows[0].n).toBe(0);
    });

    it("returns only the current user's rows", async () => {
      const rows = await asAppRole({ "app.current_user_id": USER_A }, (m) =>
        m.query("SELECT name FROM accounts"),
      );
      expect(rows.map((r: { name: string }) => r.name)).toEqual(["A acct"]);
    });

    it("returns every row under the bypass GUC", async () => {
      const rows = await asAppRole({ "app.bypass_rls": "on" }, (m) =>
        m.query("SELECT count(*)::int AS n FROM accounts"),
      );
      expect(rows[0].n).toBe(2);
    });

    it("rejects a cross-user insert via WITH CHECK", async () => {
      await expect(
        asAppRole({ "app.current_user_id": USER_A }, (m) =>
          m.query(
            `INSERT INTO accounts (user_id, name, account_type, currency_code)
             VALUES ($1, 'smuggled', 'CHEQUING', 'USD')`,
            [USER_B],
          ),
        ),
      ).rejects.toThrow(/violates row-level security policy/i);
    });

    it("filters an indirectly-owned table through its parent", async () => {
      // transaction_splits carries no user_id -- its policy is an EXISTS back to
      // transactions. Both users own one split, so this fails if the EXISTS arm
      // is wrong in either direction.
      const owner = await dataSource.query(
        "SELECT count(*)::int AS n FROM transaction_splits",
      );
      expect(owner[0].n).toBe(2);

      const unscoped = await asAppRole({}, (m) =>
        m.query("SELECT count(*)::int AS n FROM transaction_splits"),
      );
      expect(unscoped[0].n).toBe(0);

      const scoped = await asAppRole({ "app.current_user_id": USER_A }, (m) =>
        m.query("SELECT memo FROM transaction_splits"),
      );
      expect(scoped.map((r: { memo: string }) => r.memo)).toEqual(["A split"]);
    });

    it("cannot turn RLS off for itself", async () => {
      // The whole scheme rests on the runtime role not owning the tables.
      await expect(
        asAppRole({}, (m) =>
          m.query("ALTER TABLE accounts DISABLE ROW LEVEL SECURITY"),
        ),
      ).rejects.toThrow(/must be owner of table/i);
    });
  });
});
