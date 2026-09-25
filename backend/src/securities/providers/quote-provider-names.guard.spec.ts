import { readFileSync } from "fs";
import { join } from "path";
import { QUOTE_PROVIDER_NAMES } from "./quote-provider.interface";

/**
 * `quote-provider.interface.ts` documents `QUOTE_PROVIDER_NAMES` as the single
 * source of truth for the provider set, including the database CHECK on
 * `quote_provider` / `default_quote_provider`. Nothing in TypeScript can read a
 * SQL CHECK, so this guard is what actually binds the two: it fails if the list
 * in `database/schema.sql` drifts from the constant in either direction. Without
 * it, adding a provider to the const while forgetting the paired migration
 * passes the `@IsIn` DTO validators and then fails every INSERT at runtime.
 */
const SCHEMA = readFileSync(
  join(__dirname, "../../../../database/schema.sql"),
  "utf8",
);

/** The quoted values of the `<column> IN ('a','b',...)` CHECK in schema.sql. */
function checkInList(column: string): string[] {
  const match = new RegExp(`\\b${column}\\b\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(
    SCHEMA,
  );
  if (!match) throw new Error(`no CHECK IN (...) found for ${column}`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^'|'$/g, ""))
    .filter((entry) => entry.length > 0);
}

describe("QUOTE_PROVIDER_NAMES matches the database CHECK constraints", () => {
  const expected = [...QUOTE_PROVIDER_NAMES].sort();

  it.each(["quote_provider", "default_quote_provider"])(
    "the %s CHECK lists exactly QUOTE_PROVIDER_NAMES",
    (column) => {
      expect(checkInList(column).sort()).toEqual(expected);
    },
  );
});
