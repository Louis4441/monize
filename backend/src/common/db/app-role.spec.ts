import { Logger } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import {
  APP_ROLE_ATTRIBUTES,
  APP_ROLE_GRANTS_SQL,
  RUNTIME_READ_ONLY_TABLES,
  APP_ROLE_NAME_GUC,
  APP_ROLE_PASSWORD_GUC,
  APP_ROLE_UPSERT_SQL,
  assertRuntimeRoleIsSafe,
  provisionAppRole,
  SqlClient,
} from "./app-role";
import { DEFAULT_APP_USER } from "./rls-config";
import { FORBIDDEN_RUNTIME_ATTRIBUTES } from "./runtime-role-check";

function makeClient() {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client: SqlClient = {
    query: jest.fn((text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return Promise.resolve({ rows: [] });
    }),
  };
  return { client, calls };
}

function makeLogger() {
  return { log: jest.fn(), warn: jest.fn() };
}

describe("provisionAppRole", () => {
  it("sets the role name and password via parameterized set_config, then upserts and grants", async () => {
    const { client, calls } = makeClient();
    const logger = makeLogger();

    await provisionAppRole(client, {
      appUser: "monize_app",
      appPassword: "s3cret",
      logger,
    });

    // Role name carried via a parameterized session GUC (no interpolation).
    expect(calls[0]).toEqual({
      text: "SELECT set_config($1, $2, false)",
      params: [APP_ROLE_NAME_GUC, "monize_app"],
    });
    // Password carried via a parameterized session GUC (never in SQL text).
    expect(calls[1]).toEqual({
      text: "SELECT set_config($1, $2, false)",
      params: [APP_ROLE_PASSWORD_GUC, "s3cret"],
    });
    expect(calls[2].text).toBe(APP_ROLE_UPSERT_SQL);
    expect(calls[3].text).toBe(APP_ROLE_GRANTS_SQL);
    expect(calls).toHaveLength(4);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("defaults the role name to monize_app when appUser is unset", async () => {
    const { client, calls } = makeClient();
    await provisionAppRole(client, {
      appUser: undefined,
      appPassword: "pw",
      logger: makeLogger(),
    });
    expect(calls[0].params).toEqual([APP_ROLE_NAME_GUC, DEFAULT_APP_USER]);
  });

  it("skips role creation but still applies grants when the password is unset", async () => {
    const { client, calls } = makeClient();
    const logger = makeLogger();

    await provisionAppRole(client, {
      appUser: "monize_app",
      appPassword: undefined,
      logger,
    });

    // Only the role-name GUC + grants run; no password GUC, no upsert.
    expect(calls.map((c) => c.text)).toEqual([
      "SELECT set_config($1, $2, false)",
      APP_ROLE_GRANTS_SQL,
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/DATABASE_APP_PASSWORD/);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("defaults to the Nest Logger when none is provided, so the line is formatted like the rest of startup", async () => {
    const { client } = makeClient();
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => {});
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    try {
      await provisionAppRole(client, {
        appUser: "monize_app",
        appPassword: "pw",
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("never emits the password as a literal in any SQL statement text", async () => {
    const { client, calls } = makeClient();
    await provisionAppRole(client, {
      appUser: "monize_app",
      appPassword: "super-secret-value",
      logger: makeLogger(),
    });
    for (const call of calls) {
      expect(call.text).not.toContain("super-secret-value");
    }
  });
});

describe("app-role SQL", () => {
  it("has a runtime check for every forbidden attribute it provisions (RR5-001)", () => {
    // The parity guard. `APP_ROLE_ATTRIBUTES` strips a set of NO<x> attributes,
    // and the startup verifier must reject each of them -- provisioning can be
    // skipped (declarative CNPG), fail soft (no CREATEROLE), or drift, so the
    // verifier is the real control. REPLICATION was provisioned off and never
    // checked, so a REPLICATION role passed startup and could hold WAL.
    //
    // Derived from the two sources rather than hand-listed, so a new NO<x> in
    // provisioning without a runtime fact fails here.
    const provisionedOff = (
      APP_ROLE_ATTRIBUTES.match(/\bNO[A-Z]+\b/g) ?? []
    ).map((token) => token.slice(2));

    // NOINHERIT is defence in depth for inherited ownership, not a forbidden
    // attribute in its own right (a role may legitimately hold INHERIT), so it is
    // handled by the ownership arms rather than the forbidden-attribute list.
    const shouldBeChecked = provisionedOff.filter((a) => a !== "INHERIT");
    const checked = FORBIDDEN_RUNTIME_ATTRIBUTES.map((a) => a.label);

    for (const attr of shouldBeChecked) {
      expect(checked).toContain(attr);
    }
    // ...and nothing checked that provisioning does not also strip, so the two
    // stay a matched pair.
    for (const label of checked) {
      expect(provisionedOff).toContain(label);
    }
  });

  it("names every stripped attribute in the insufficient-privilege warning (RR7-002)", () => {
    // The fallback path for declarative CNPG provisioning: when the owner lacks
    // CREATEROLE, the ALTER fails soft and this warning is the only instruction
    // the operator gets. It hand-listed four of the six NO<x> attributes and
    // dropped NOREPLICATION and NOINHERIT, so an operator following it into
    // managed.roles rebuilt a role that later failed enforce-mode startup.
    //
    // Derived from APP_ROLE_ATTRIBUTES, so the warning cannot drift behind it.
    const warning = APP_ROLE_UPSERT_SQL.slice(
      APP_ROLE_UPSERT_SQL.indexOf("RAISE WARNING"),
    );
    const stripped = APP_ROLE_ATTRIBUTES.match(/\bNO[A-Z]+\b/g) ?? [];
    expect(stripped.length).toBeGreaterThan(0);
    for (const token of stripped) {
      expect(warning).toContain(token);
    }
  });

  it("provisions the role NOINHERIT, so it does not inherit an owner by default", () => {
    // Defence in depth for RR3-001: an inherited owner bypasses RLS with no SET
    // ROLE at all. Not the fix -- a per-membership `WITH INHERIT TRUE` overrides
    // the role default, and declarative provisioning skips this SQL entirely --
    // which is why the startup check tests reachability rather than trusting it.
    expect(APP_ROLE_ATTRIBUTES).toContain("NOINHERIT");
    expect(APP_ROLE_UPSERT_SQL).toContain("NOINHERIT");
  });

  it("uses %I / %L formatting and no FOR ROLE clause", () => {
    expect(APP_ROLE_UPSERT_SQL).toContain(
      `format('CREATE ROLE %I ${APP_ROLE_ATTRIBUTES} PASSWORD %L'`,
    );
    expect(APP_ROLE_UPSERT_SQL).toContain("insufficient_privilege");
    expect(APP_ROLE_GRANTS_SQL).toContain(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public",
    );
    expect(APP_ROLE_GRANTS_SQL).not.toMatch(/FOR ROLE/i);
  });

  it("creates the role without any RLS-exempting attribute", () => {
    // Already PostgreSQL's defaults; named so that a future edit adding
    // SUPERUSER or BYPASSRLS has to delete an explicit NO.
    for (const attribute of [
      "NOSUPERUSER",
      "NOBYPASSRLS",
      "NOCREATEDB",
      "NOCREATEROLE",
      "NOREPLICATION",
    ]) {
      expect(APP_ROLE_UPSERT_SQL).toContain(attribute);
    }
  });

  it("revokes the runtime role's access to migration bookkeeping", () => {
    // The blanket "ALL TABLES IN SCHEMA public" grant includes
    // schema_migrations, so runtime credentials could insert a filename (the next
    // deployment then skips required DDL) or delete one (a migration body
    // re-runs). No application code touches the table.
    //
    // Write privileges only: #1063 landed the revoke keeping SELECT, and this
    // test used to assert REVOKE ALL because that is what the audit-03 branch
    // wrote. The difference is read access to a ledger of filenames, which is not
    // the thing being protected -- forging or deleting a row is -- so the merged
    // narrower revoke stands and the assertion follows it.
    expect(APP_ROLE_GRANTS_SQL).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.%I FROM %I/,
    );
    // Guarded on the table's existence: the grants run on every startup,
    // including before the table has been created.
    expect(APP_ROLE_GRANTS_SQL).toContain("relname = infra_table");
  });

  it("orders the revoke after the blanket grant", () => {
    // A revoke that ran first would be undone by the grant that followed it.
    const grantAt = APP_ROLE_GRANTS_SQL.indexOf(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES",
    );
    const revokeAt = APP_ROLE_GRANTS_SQL.indexOf(
      "REVOKE INSERT, UPDATE, DELETE ON public.%I",
    );
    expect(grantAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(grantAt);
  });
});

describe("assertRuntimeRoleIsSafe", () => {
  const safeRow = {
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    owns_tables: false,
    owns_database: false,
    inherits_bypass: false,
  };

  function clientReturning(row: Record<string, boolean> | undefined) {
    return {
      query: jest.fn().mockResolvedValue({ rows: row ? [row] : [] }),
    };
  }

  const logger = { log: jest.fn(), warn: jest.fn() };

  beforeEach(() => {
    logger.log.mockClear();
    logger.warn.mockClear();
  });

  it("accepts an unprivileged non-owner role", async () => {
    await expect(
      assertRuntimeRoleIsSafe(clientReturning(safeRow), {
        appUser: "monize_app",
        databaseName: "monize",
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("verified as non-owner"),
    );
  });

  /**
   * The reachability predicate, asserted on the SQL text because no unit-level
   * double can tell `USAGE` from `MEMBER` -- only PostgreSQL can, and the
   * difference is a whole class of unsafe role.
   *
   * `USAGE` asks whether another role's privileges are *immediately* available
   * through `INHERIT`. Role membership permits `SET ROLE` by default, so
   * `GRANT owner TO app WITH INHERIT FALSE, SET TRUE` made `USAGE` false while
   * `SET ROLE owner` still succeeded: the check passed a login that could become
   * the database owner on request. `MEMBER` is "direct or indirect membership",
   * i.e. exactly the right to `SET ROLE`, and `USAGE` implies it.
   */
  describe("the reachability predicate", () => {
    const sql = readFileSync(join(__dirname, "app-role.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    it("asks about membership, not only inheritance", () => {
      const safetyQuery =
        /RUNTIME_ROLE_SAFETY_SQL = `([\s\S]*?)`\.trim\(\)/.exec(sql);
      expect(safetyQuery).not.toBeNull();
      const body = safetyQuery![1];

      // Three reachability questions: table owner, database owner, powerful role.
      const calls = body.match(/pg_has_role\([^)]*\)/g) ?? [];
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call).toContain("'MEMBER'");
        expect(call).not.toContain("'USAGE'");
      }
    });
  });

  /**
   * Each of these exempts a role from its own policies, and startup used to
   * validate only the configured name and password -- so enforcement reported
   * itself as on while every policy was bypassed. That is worse than `off`, which
   * is at least a state somebody chose.
   */
  it.each([
    ["rolsuper", "SUPERUSER"],
    ["rolbypassrls", "BYPASSRLS"],
    ["owns_database", "owns the database"],
    ["owns_tables", "owns tables in schema public"],
    ["inherits_bypass", "member of a SUPERUSER or BYPASSRLS role"],
  ])("refuses to start when %s", async (flag, expectedReason) => {
    await expect(
      assertRuntimeRoleIsSafe(clientReturning({ ...safeRow, [flag]: true }), {
        appUser: "monize_app",
        databaseName: "monize",
        logger,
      }),
    ).rejects.toThrow(new RegExp(expectedReason, "i"));
  });

  it("names every problem at once rather than one per restart", async () => {
    await expect(
      assertRuntimeRoleIsSafe(
        clientReturning({
          ...safeRow,
          rolsuper: true,
          rolbypassrls: true,
          owns_tables: true,
        }),
        { appUser: "monize_app", databaseName: "monize", logger },
      ),
    ).rejects.toThrow(/SUPERUSER.*BYPASSRLS.*owns tables/s);
  });

  it("refuses to start when the role does not exist", async () => {
    await expect(
      assertRuntimeRoleIsSafe(clientReturning(undefined), {
        appUser: "monize_app",
        databaseName: "monize",
        logger,
      }),
    ).rejects.toThrow(/requires the runtime role 'monize_app' to exist/);
  });

  it("warns but starts on attributes that do not bypass RLS", async () => {
    await expect(
      assertRuntimeRoleIsSafe(
        clientReturning({
          ...safeRow,
          rolcreatedb: true,
          rolreplication: true,
        }),
        { appUser: "monize_app", databaseName: "monize", logger },
      ),
    ).resolves.toBeUndefined();
    // Refusing here would block a boot over something that grants no exemption;
    // saying nothing would hide that the role was provisioned as something else.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("CREATEDB, REPLICATION"),
    );
  });

  it("falls back to the default role name", async () => {
    const client = clientReturning(safeRow);
    await assertRuntimeRoleIsSafe(client, {
      appUser: undefined,
      databaseName: "monize",
      logger,
    });
    expect(client.query.mock.calls[0][1]).toEqual([DEFAULT_APP_USER, "monize"]);
  });
});

/**
 * DR-02. The blanket "all tables in schema public" grant is deliberate -- a new
 * user-owned table must be reachable the moment a migration creates it -- but it
 * also handed the runtime role write access to the migration ledger, which no
 * request touches and no policy protects.
 */
describe("runtime grant surface", () => {
  it("revokes writes on every read-only infrastructure table", () => {
    for (const table of RUNTIME_READ_ONLY_TABLES) {
      expect(APP_ROLE_GRANTS_SQL).toContain(`'${table}'`);
    }
    expect(APP_ROLE_GRANTS_SQL).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.%I",
    );
  });

  it("keeps SELECT, so nothing that reads the ledger breaks", () => {
    expect(APP_ROLE_GRANTS_SQL).not.toContain("REVOKE ALL");
    expect(APP_ROLE_GRANTS_SQL).not.toMatch(/REVOKE[^;]*SELECT/);
  });

  it("guards the revoke on the table existing", () => {
    // The grants block runs on every startup, including before schema.sql has
    // created anything. A REVOKE on a missing table aborts the whole DO block
    // and would take the grants with it.
    expect(APP_ROLE_GRANTS_SQL).toMatch(/IF EXISTS \(\s*SELECT FROM pg_class/);
  });

  it("revokes after granting, not before", () => {
    // "GRANT ON ALL TABLES" would re-add what an earlier revoke took away.
    expect(APP_ROLE_GRANTS_SQL.indexOf("GRANT SELECT, INSERT")).toBeLessThan(
      APP_ROLE_GRANTS_SQL.indexOf("REVOKE"),
    );
  });
});
