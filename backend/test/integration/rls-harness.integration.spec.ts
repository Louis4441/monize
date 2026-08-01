import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import {
  applyRlsPolicies,
  findRlsMigrations,
  TEST_APP_ROLE,
} from "../helpers/rls-setup";

/**
 * Acceptance coverage for RLS task T1 -- the integration harness applies the
 * real RLS migrations, the runtime role and its grants, and the `updated_at`
 * triggers.
 *
 * The point of these assertions is that everything downstream (T2's enforcement
 * catalog, C5's restore acceptance) tests something real. A harness that
 * silently applies nothing produces a suite that is green and worthless, so
 * each check here is written to fail on the *absence* of an object rather than
 * on its misbehaviour.
 */
describe("RLS integration harness (T1)", () => {
  let dataSource: DataSource;

  const MIGRATIONS_DIR = path.join(__dirname, "../../../database/migrations");

  beforeAll(async () => {
    dataSource = new DataSource({
      ...INTEGRATION_TYPEORM_OPTIONS,
      // A full synchronize from entity metadata, matching what the module
      // harness gives the other suites, so the trigger and grant assertions run
      // against the same shape they do.
      synchronize: true,
      dropSchema: true,
    } as never);
    await dataSource.initialize();
    await applyRlsPolicies(dataSource);
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  describe("runtime role and grants", () => {
    it("creates the runtime role", async () => {
      const [row] = await dataSource.query(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
        [TEST_APP_ROLE],
      );
      expect(row.exists).toBe(true);
    });

    it("grants the role DML on application tables but not ownership", async () => {
      const [row] = await dataSource.query(
        `SELECT
           has_table_privilege($1, 'accounts', 'SELECT') AS can_select,
           has_table_privilege($1, 'accounts', 'INSERT') AS can_insert,
           has_table_privilege($1, 'accounts', 'UPDATE') AS can_update,
           has_table_privilege($1, 'accounts', 'DELETE') AS can_delete,
           pg_has_role($1, (SELECT tableowner FROM pg_tables WHERE tablename = 'accounts'), 'MEMBER') AS is_owner`,
        [TEST_APP_ROLE],
      );
      expect(row.can_select).toBe(true);
      expect(row.can_insert).toBe(true);
      expect(row.can_update).toBe(true);
      expect(row.can_delete).toBe(true);
      // Ownership is what would let the role turn RLS off for itself, so the
      // enforcement specs are only meaningful while this stays false.
      expect(row.is_owner).toBe(false);
    });
  });

  describe("RLS migrations", () => {
    it("creates the identity helper functions", async () => {
      const rows = await dataSource.query(
        `SELECT proname FROM pg_proc
          WHERE proname IN ('app_current_user_id', 'app_real_user_id', 'app_bypass_rls')`,
      );
      expect(rows.map((r: { proname: string }) => r.proname).sort()).toEqual([
        "app_bypass_rls",
        "app_current_user_id",
        "app_real_user_id",
      ]);
    });

    it("applies a policy to every table the migrations policy", async () => {
      const rows = await dataSource.query(
        "SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'",
      );
      const policied = rows.map((r: { tablename: string }) => r.tablename);

      // The count is deliberately not asserted against a literal: tables keep
      // arriving, and a hard number would make every new table a failing test
      // instead of a passing one. What matters is that the set is substantial
      // and includes a representative of each policy shape.
      expect(policied.length).toBeGreaterThan(50);
      expect(policied).toEqual(expect.arrayContaining(["accounts"])); // direct
      expect(policied).toEqual(expect.arrayContaining(["transaction_splits"])); // indirect
      expect(policied).toEqual(expect.arrayContaining(["users"])); // special
    });

    it("applies policies that live in feature migrations, not just *_rls_* files", async () => {
      // Regression guard for the trap T1 was written to avoid: a `*_rls_*`
      // filename glob picks up 111-114 and 118 but misses these three, whose
      // policies ship inside the migration that creates the table. Two of them
      // (117) would then look unpolicied to T2, and `security_documents` (118)
      // is the case that proves a policy can arrive in any file at all.
      const rows = await dataSource.query(
        `SELECT tablename FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename IN ('import_staged_files', 'import_jobs', 'security_documents')`,
      );
      expect(
        rows.map((r: { tablename: string }) => r.tablename).sort(),
      ).toEqual(["import_jobs", "import_staged_files", "security_documents"]);
    });

    it("leaves row-level security disabled -- policies ship inert until M3", async () => {
      // Applying policies must not change what the other 15 suites observe.
      // The enable is flip B and belongs to a spec that opts into it.
      const [row] = await dataSource.query(
        `SELECT count(*)::int AS enabled
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relrowsecurity`,
      );
      expect(row.enabled).toBe(0);
    });

    it("is idempotent -- re-applying leaves one policy per table", async () => {
      const before = await dataSource.query(
        "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'",
      );
      await applyRlsPolicies(dataSource);
      const after = await dataSource.query(
        "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'",
      );
      expect(after[0].n).toBe(before[0].n);
    });
  });

  describe("updated_at triggers", () => {
    it("creates the triggers synchronize does not", async () => {
      const [row] = await dataSource.query(
        `SELECT count(*)::int AS n
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = 'public'
            AND NOT t.tgisinternal
            AND t.tgname LIKE 'update_%_updated_at'`,
      );
      expect(row.n).toBeGreaterThan(20);
    });

    it("stamps updated_at on a raw UPDATE", async () => {
      // The acceptance test for step 3. `@UpdateDateColumn` stamps app-side, so
      // an ORM write proves nothing about the trigger -- only a raw statement
      // that supplies its own value can tell whether the trigger fired.
      const userId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, auth_provider, role, is_active, email_verified)
         VALUES ($1, $2, 'x', 'T', 'One', 'local', 'user', true, true)`,
        [userId, `t1-trigger-${Date.now()}@example.com`],
      );

      await dataSource.query(
        `UPDATE users SET first_name = 'Two', updated_at = TIMESTAMP '2001-01-01 00:00:00' WHERE id = $1`,
        [userId],
      );

      const [row] = await dataSource.query(
        "SELECT updated_at FROM users WHERE id = $1",
        [userId],
      );
      // The trigger overwrote the supplied value with CURRENT_TIMESTAMP.
      expect(new Date(row.updated_at).getFullYear()).toBeGreaterThan(2001);

      await dataSource.query("DELETE FROM users WHERE id = $1", [userId]);
    });

    it("preserves a supplied updated_at under app.preserve_timestamps", async () => {
      // The other half of M1's trigger, and the mechanism C5 replaces
      // `DISABLE TRIGGER` with. Asserting it here is what makes C5's acceptance
      // meaningful: without the trigger attached to a real table, C5 could pass
      // against a database where nothing would have stamped anything anyway.
      // Assert the trigger is attached *first*. Without it the supplied
      // timestamp survives for the trivial reason that nothing would have
      // overwritten it, and this test would pass against a database with no
      // triggers at all -- which is exactly the pre-T1 state.
      const [trigger] = await dataSource.query(
        `SELECT count(*)::int AS n
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = 'users'
            AND NOT t.tgisinternal
            AND t.tgname = 'update_users_updated_at'`,
      );
      expect(trigger.n).toBe(1);

      const userId = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, auth_provider, role, is_active, email_verified)
         VALUES ($1, $2, 'x', 'T', 'Two', 'local', 'user', true, true)`,
        [userId, `t1-preserve-${Date.now()}@example.com`],
      );

      // The GUC is transaction-local (`set_config(..., true)`), so the UPDATE
      // has to share the transaction that sets it -- which is exactly how
      // withScopedDb emits it.
      await dataSource.transaction(async (m) => {
        await m.query(
          "SELECT set_config('app.preserve_timestamps', 'on', true)",
        );
        await m.query(
          `UPDATE users SET first_name = 'Three', updated_at = TIMESTAMP '2001-01-01 00:00:00' WHERE id = $1`,
          [userId],
        );
      });

      const [row] = await dataSource.query(
        "SELECT updated_at FROM users WHERE id = $1",
        [userId],
      );
      expect(new Date(row.updated_at).getFullYear()).toBe(2001);

      await dataSource.query("DELETE FROM users WHERE id = $1", [userId]);
    });
  });

  describe("fails loudly rather than silently skipping", () => {
    it("throws when a declared policy did not materialize", async () => {
      // Simulates the failure mode the post-condition exists for: a migration
      // that applies without error but leaves a table unpolicied. Dropping a
      // policy after apply is the observable equivalent.
      await dataSource.query(
        "DROP POLICY IF EXISTS accounts_isolation ON accounts",
      );
      const [row] = await dataSource.query(
        `SELECT count(*)::int AS n FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'accounts'`,
      );
      expect(row.n).toBe(0);

      // Re-applying restores it, which is the harness doing its job.
      await applyRlsPolicies(dataSource);
      const [after] = await dataSource.query(
        `SELECT count(*)::int AS n FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'accounts'`,
      );
      expect(after.n).toBe(1);
    });

    it("selects every migration file that declares a policy", () => {
      // Guard test in the style CLAUDE.md asks for: it fails for *any* future
      // migration that declares a policy in a file the harness would not
      // select, wherever that file appears -- not just for today's three. It
      // calls the real selector rather than re-testing a copy of its rule, so
      // narrowing the selector (back to a filename glob, say) fails here.
      const selected = findRlsMigrations().map((f) => path.basename(f));

      const declaresPolicy = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .filter((f) =>
          /CREATE\s+POLICY/i.test(
            fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"),
          ),
        );

      expect(declaresPolicy.length).toBeGreaterThan(0);
      expect(declaresPolicy.filter((f) => !selected.includes(f))).toEqual([]);
    });
  });
});
