import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * `docs/time-series-contract.md` section 2.2: an exchange rate is a price, so
 * turning a stored rate into "the rate for this date" goes through the shared
 * helper that applies the age bound and refuses look-ahead --
 * `common/time-series/fx-rate-resolver.ts`, reached either directly or through
 * `ExchangeRateService.resolveStoredRate` / `getRateForDate`.
 *
 * Issue #1390 is what this guard exists for: four resolvers answered the same
 * question and disagreed, so one session quoted four different EUR rates. The
 * prose form of that rule cannot see a fifth being added, and each of the four
 * looked perfectly reasonable in its own file.
 *
 * What it looks for: a read of the *newest* stored rate -- `getLatestRate(`,
 * or a `rate_date` ordered descending beside a one-row fetch -- outside the
 * door. `getLatestRates()` (the plural admin listing) is not that and is not
 * flagged.
 *
 * The baseline is **shrink-only**. Every entry is a call site that predates the
 * guard, with the reason it is still there; a new one fails the build, and
 * fixing one means deleting its line here in the same change.
 */

const SRC_ROOT = join(__dirname, "..", "..");

/**
 * The door itself, plus the service that is its database side, plus the one
 * deliberate exception `docs/time-series-contract.md` section 2.1 records as
 * living *inside* the door: `nearest-observation.ts` answers "what is the
 * closest thing anybody ever observed", explicitly approximate, and carries the
 * observation's date to the user rather than presenting it as that date's rate.
 */
const DOOR_FILES = new Set([
  "common/time-series/fx-rate-resolver.ts",
  "common/time-series/rate-index.util.ts",
  "common/time-series/nearest-observation.ts",
  "currencies/exchange-rate.service.ts",
]);

/**
 * Call sites still reading a newest-stored-rate outside the resolver.
 *
 * Not endorsements. Each names why it has not moved yet; removing an entry is
 * how INV-FX-001's look-ahead/age clause gets from `partial` to `enforced`.
 */
const BASELINE: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "common/converting-total.ts",
    reason:
      "Declares the `getLatestRate` shape its rate source must satisfy; the " +
      "implementation it is handed is ExchangeRateService's, and the ladder " +
      "beside it (`getRateForDate`) is what the dated callers use. A type " +
      "declaration, not a lookup.",
  },
  {
    file: "common/fx-entry.util.ts",
    reason:
      "`resolveFxRateOrNull` is the one market-rate ladder and calls " +
      "getLatestRate only on the branch where the caller has no date at all " +
      "(a rate entered against no posting date). Giving that branch a bound " +
      "means deciding what a dateless entry means, which is its own change.",
  },
  {
    file: "securities/investment-transactions.service.ts",
    reason:
      "The fallback when a posting's own `getRateForDate` comes back empty, " +
      "for a rate that is then persisted on the row. Bounding it changes " +
      "whether a trade can be posted at all, which is a posting-policy " +
      "decision rather than a reporting one.",
  },
  {
    file: "scheduled-transactions/scheduled-transactions.service.ts",
    reason:
      "Same shape for a scheduled posting: the last resort before refusing " +
      "to post an occurrence. Same decision to make, and the same reason it " +
      "is not made in a guard.",
  },
  {
    file: "strategies/gem-position.service.ts",
    reason:
      "GEM position valuation converts at the latest rate, direct then " +
      "inverse. The GEM surfaces have their own missing-data contract " +
      "(docs/security-benchmark-comparison.md) and moving them is a separate " +
      "change.",
  },
];

const LATEST_RATE_CALL = /\bgetLatestRate\s*\(/;
const RATE_ORDER_DESC = /(?:rateDate|rate_date)["'\s]*[,:]?\s*["']?DESC/;
const SINGLE_ROW =
  /\bfindOne\b|\.take\(1\)|\.limit\(1\)|LIMIT\s+1|DISTINCT ON|ROW_NUMBER\s*\(/;
/** How many lines either side of an ordering count as the same statement. */
const WINDOW = 12;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "node_modules" || entry === "dist" ? [] : sourceFiles(full);
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) return [];
    return [full];
  });
}

function findOffenders(): string[] {
  const offenders = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
    if (DOOR_FILES.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (LATEST_RATE_CALL.test(line)) {
        offenders.add(rel);
        return;
      }
      if (!RATE_ORDER_DESC.test(line)) return;
      const window = lines
        .slice(Math.max(0, index - WINDOW), index + WINDOW + 1)
        .join("\n");
      if (SINGLE_ROW.test(window)) offenders.add(rel);
    });
  }
  return [...offenders].sort();
}

describe("one door for a rate-for-a-date", () => {
  const offenders = findOffenders();

  it("finds source files to scan", () => {
    expect(sourceFiles(SRC_ROOT).length).toBeGreaterThan(100);
  });

  it("has no newest-rate read outside the resolver and the recorded baseline", () => {
    const allowed = new Set(BASELINE.map((entry) => entry.file));
    expect(offenders.filter((file) => !allowed.has(file))).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const found = new Set(offenders);
    expect(
      BASELINE.map((entry) => entry.file)
        .filter((file) => !found.has(file))
        .sort(),
    ).toEqual([]);
  });

  it("every baseline entry states why it is tolerated", () => {
    for (const entry of BASELINE) {
      expect(entry.reason.length).toBeGreaterThan(30);
    }
  });

  it("recognises the shapes it bans", () => {
    expect(LATEST_RATE_CALL.test("await this.rates.getLatestRate(a, b)")).toBe(
      true,
    );
    // The plural admin listing is a list, not a value-for-a-date.
    expect(LATEST_RATE_CALL.test("await this.rates.getLatestRates()")).toBe(
      false,
    );
    expect(RATE_ORDER_DESC.test('order: { rateDate: "DESC" }')).toBe(true);
    expect(RATE_ORDER_DESC.test("ORDER BY er.rate_date DESC")).toBe(true);
  });
});
