import * as fs from "fs";
import * as path from "path";
import {
  MISSING_DB_FUNCTIONS_SQL,
  REQUIRED_DB_FUNCTIONS,
  assertRequiredDbFunctions,
  formatMissingDbFunctions,
  missingDbFunctions,
} from "./required-db-functions";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "database", "schema.sql");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "database", "migrations");
const BACKEND_SRC = path.resolve(__dirname, "..", "..");

/** Every `CREATE [OR REPLACE] FUNCTION <name>` in a SQL file. */
function functionsDefinedIn(sql: string): Set<string> {
  const defined = new Set<string>();
  for (const match of sql.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)/gi,
  )) {
    defined.add(match[1]);
  }
  return defined;
}

function backendSources(): [string, string][] {
  const found: [string, string][] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".spec.ts") &&
        // The declaration file names every function by definition; counting it
        // as a caller would make the offender message list it beside the real
        // ones and read as though registering a function created a new use.
        full !== path.join(__dirname, "required-db-functions.ts")
      ) {
        found.push([full, fs.readFileSync(full, "utf8")]);
      }
    }
  };
  walk(BACKEND_SRC);
  return found;
}

describe("REQUIRED_DB_FUNCTIONS", () => {
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  const schemaFunctions = functionsDefinedIn(schema);

  it("finds the schema it checks against", () => {
    // Were schema.sql moved or renamed, every check below would pass over an
    // empty set. Fail here instead, with the path to update.
    expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
    expect(schemaFunctions.size).toBeGreaterThan(0);
  });

  it("names a function database/schema.sql actually creates", () => {
    const undefinedInSchema = REQUIRED_DB_FUNCTIONS.filter(
      (fn) => !schemaFunctions.has(fn.name),
    ).map((fn) => fn.name);

    // A fresh install gets its schema from schema.sql alone (db-init applies it
    // when the `users` table is absent). A required function missing from it is
    // a first boot that refuses to start.
    expect(undefinedInSchema).toEqual([]);
  });

  it("names a migration that exists and creates the function", () => {
    const wrong: string[] = [];
    for (const fn of REQUIRED_DB_FUNCTIONS) {
      const file = path.join(MIGRATIONS_DIR, fn.migration);
      if (!fs.existsSync(file)) {
        wrong.push(`${fn.name}: no such migration ${fn.migration}`);
        continue;
      }
      if (!functionsDefinedIn(fs.readFileSync(file, "utf8")).has(fn.name)) {
        wrong.push(`${fn.name}: ${fn.migration} does not create it`);
      }
    }

    // The migration name is what the failure message tells an operator to look
    // for. A stale one sends them to a file that will not explain anything.
    expect(wrong).toEqual([]);
  });

  it("registers every schema function the backend calls by name", () => {
    const registered = new Set(REQUIRED_DB_FUNCTIONS.map((fn) => fn.name));
    const sources = backendSources();
    const unregistered: string[] = [];

    for (const name of schemaFunctions) {
      if (registered.has(name)) continue;
      const callers = sources
        .filter(([, content]) => content.includes(name))
        .map(([file]) => path.relative(REPO_ROOT, file));
      if (callers.length > 0) {
        unregistered.push(`${name} (called from ${callers.join(", ")})`);
      }
    }

    // This is the direction that matters. A new SQL function reached from
    // TypeScript is exactly the shape that produced the restore failure this
    // file exists for: the code shipped, the migration did not reach every
    // database, and nothing checked before the first write went out. Add the
    // function to REQUIRED_DB_FUNCTIONS in the same change.
    expect(unregistered).toEqual([]);
  });

  it("finds the callers, so the scan cannot pass over an empty tree", () => {
    expect(backendSources().length).toBeGreaterThan(100);
  });

  it("lists each identity once", () => {
    const identities = REQUIRED_DB_FUNCTIONS.map((fn) => fn.identity);
    expect(new Set(identities).size).toBe(identities.length);
  });
});

describe("missingDbFunctions", () => {
  const sample = REQUIRED_DB_FUNCTIONS.slice(0, 2);

  it("asks for every identity in one parameterised statement", async () => {
    const query = jest.fn().mockResolvedValue([]);

    await missingDbFunctions({ query });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toBe(MISSING_DB_FUNCTIONS_SQL);
    expect(params).toEqual([REQUIRED_DB_FUNCTIONS.map((fn) => fn.identity)]);
    // The identities reach SQL as a bound array, never spliced into the text.
    expect(sql).not.toContain("currency_code_in_use_globally");
  });

  it("returns the declared entries the database did not resolve", async () => {
    const query = jest.fn().mockResolvedValue([{ ident: sample[1].identity }]);

    await expect(missingDbFunctions({ query }, sample)).resolves.toEqual([
      sample[1],
    ]);
  });

  it("reads the pg driver's result object as well as TypeORM's array", async () => {
    const query = jest
      .fn()
      .mockResolvedValue({ rows: [{ ident: sample[0].identity }] });

    // db-migrate passes a `pg.Client`, main.ts a `DataSource`. One reader, or
    // the migrate-side check silently reports a healthy database every time.
    await expect(missingDbFunctions({ query }, sample)).resolves.toEqual([
      sample[0],
    ]);
  });

  it("treats an empty result as nothing missing", async () => {
    const query = jest.fn().mockResolvedValue([]);
    await expect(missingDbFunctions({ query }, sample)).resolves.toEqual([]);
  });

  it("makes no round trip for an empty list", async () => {
    const query = jest.fn();
    await expect(missingDbFunctions({ query }, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("assertRequiredDbFunctions", () => {
  it("resolves when the database has them all", async () => {
    const query = jest.fn().mockResolvedValue([]);
    await expect(assertRequiredDbFunctions({ query })).resolves.toBeUndefined();
  });

  it("throws a message naming the object, its migration and the remedy", async () => {
    const target = REQUIRED_DB_FUNCTIONS.find(
      (fn) => fn.name === "currency_code_in_use_globally",
    );
    expect(target).toBeDefined();
    const query = jest.fn().mockResolvedValue([{ ident: target!.identity }]);

    await expect(assertRequiredDbFunctions({ query })).rejects.toThrow(
      /currency_code_in_use_globally/,
    );
    await expect(assertRequiredDbFunctions({ query })).rejects.toThrow(
      /136_currency_global_liveness\.sql/,
    );
    await expect(assertRequiredDbFunctions({ query })).rejects.toThrow(
      /db-migrate/,
    );
  });
});

describe("formatMissingDbFunctions", () => {
  it("reports every missing entry, not just the first", () => {
    const text = formatMissingDbFunctions(REQUIRED_DB_FUNCTIONS);
    for (const fn of REQUIRED_DB_FUNCTIONS) {
      expect(text).toContain(fn.identity);
      expect(text).toContain(fn.migration);
    }
  });
});
