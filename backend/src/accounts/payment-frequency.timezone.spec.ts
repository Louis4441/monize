import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * A payoff date is the same calendar day in every deployment.
 *
 * CI runs `TZ=UTC` and so does every other spec in this directory, which is
 * exactly why this class of defect survives review: `advancePaymentDates` read
 * LOCAL date components off a `Date` its callers build from a date-only string
 * (`new Date("2026-01-15")` is UTC midnight) and returned a LOCAL-midnight
 * `Date` that `formatDateYMD` then read back in UTC. Every payoff date came out
 * one day early outside UTC, by two different routes -- west of Greenwich the
 * input read landed on the previous day, east of it the output did -- so the
 * linked scheduled transaction's `endDate` fell a day before its own final
 * occurrence and the last payment never posted.
 *
 * The rule the code follows: a `Date` carrying a calendar date is UTC-midnight
 * here, the convention `ensureYMD` and `formatDateYMD` already share.
 *
 * **A same-offset test cannot demonstrate an offset property.** Setting
 * `process.env.TZ` inside a Jest worker does not move `Date` -- the sandbox's
 * `process.env` write never reaches V8's timezone cache, so the whole matrix
 * passes against deliberately broken code (verified). The offsets are therefore
 * walked in child processes, which is the only place `TZ` is read: same family
 * as "a mocked filesystem cannot demonstrate a filesystem property".
 *
 * The source scan below is the cheap generalisation -- it fails for a local
 * getter anywhere in these modules, including at a call site this spec does not
 * exercise.
 */

/** UTC is the control; the other two are the halves of the original defect. */
const OFFSETS = ["UTC", "Europe/Warsaw", "America/New_York"];

/**
 * What each child computes: label -> expected `YYYY-MM-DD`. Every value is a
 * date the recurrence engine itself reaches, so the expectation is the schedule
 * the borrower is actually posted.
 */
const CASES: Record<string, string> = {
  // Payment 1 on the 15th, twelve monthly payments: the twelfth is 2026-12-15.
  "loan monthly": "2026-12-15",
  // The clamping cadence, where a day's drift also changes which month the
  // clamp lands in on the next step.
  "loan month-end": "2027-01-28",
  "mortgage accelerated biweekly": "2026-12-31",
  // The 15th and the last day of the month: two anchors a day's drift moves
  // between, so a shifted input picks the other branch rather than the same
  // branch a day out.
  "semi-monthly": "2027-01-15",
  // A sentinel is still a date somebody screenshots.
  "never pays off": "2126-01-15",
  // The degenerate case still crosses both conversions -- the cheapest proof
  // that the round trip itself is offset-free.
  "zero steps": "2026-01-15",
};

const CHILD_SCRIPT = `
const { calculateEndDate } = require("./src/accounts/loan-amortization.util");
const { calculateMortgageEndDate } = require("./src/accounts/mortgage-amortization.util");
const { advancePaymentDates } = require("./src/accounts/payment-frequency.util");
const { formatDateYMD } = require("./src/common/date-utils");
const f = formatDateYMD;
process.stdout.write(JSON.stringify({
  "loan monthly": f(calculateEndDate(new Date("2026-01-15"), "MONTHLY", 12)),
  "loan month-end": f(calculateEndDate(new Date("2026-01-31"), "MONTHLY", 13)),
  "mortgage accelerated biweekly": f(
    calculateMortgageEndDate(new Date("2026-01-15"), "ACCELERATED_BIWEEKLY", 26),
  ),
  "semi-monthly": f(advancePaymentDates(new Date("2026-01-15"), "SEMIMONTHLY", 24)),
  "never pays off": f(calculateEndDate(new Date("2026-01-15"), "MONTHLY", Infinity)),
  "zero steps": f(advancePaymentDates(new Date("2026-01-15"), "MONTHLY", 0)),
}));
`;

const BACKEND_ROOT = join(__dirname, "..", "..");

function datesUnder(timezone: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-r", "ts-node/register/transpile-only", "-e", CHILD_SCRIPT],
      {
        cwd: BACKEND_ROOT,
        env: { ...process.env, TZ: timezone, TS_NODE_TRANSPILE_ONLY: "true" },
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`TZ=${timezone} child exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(
          new Error(`TZ=${timezone} child printed non-JSON: ${out}${err}`),
        );
      }
    });
  });
}

describe("payment dating is independent of the container timezone", () => {
  // Three ts-node startups; run together rather than in series.
  it("dates every cadence the same in UTC, east of it and west of it", async () => {
    const answers = await Promise.all(OFFSETS.map(datesUnder));
    const byOffset = Object.fromEntries(
      OFFSETS.map((tz, i) => [tz, answers[i]]),
    );
    expect(byOffset).toEqual(
      Object.fromEntries(OFFSETS.map((tz) => [tz, CASES])),
    );
  }, 60_000);
});

/**
 * The generalisation: in these three modules a `Date` is a calendar date, so
 * only the UTC accessors may touch one. A local getter here is the defect above
 * however it is spelled, and it is mechanical enough to scan for.
 */
describe("the amortization date helpers read UTC components only", () => {
  const SUBJECTS = [
    "payment-frequency.util.ts",
    "loan-amortization.util.ts",
    "mortgage-amortization.util.ts",
  ];

  /** `getMonth(`, `setFullYear(` and friends -- the local half of each pair. */
  const LOCAL_ACCESSOR =
    /\.(get|set)(FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)\s*\(/g;

  /** Comment lines only, so prose naming the mistake does not count as it. */
  function code(source: string): string {
    return source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
  }

  it.each(SUBJECTS)("%s uses no local date accessor", (file) => {
    // `readFileSync` throws when the file moves, which is the failure we want:
    // a scan whose subject vanished must not report "no offenders".
    const source = readFileSync(join(__dirname, file), "utf8");
    expect(code(source).match(LOCAL_ACCESSOR) ?? []).toEqual([]);
  });

  it("would catch a local accessor, so the scan cannot pass by accident", () => {
    const offending = code(
      ["export function f(d: Date) {", "  return d.getFullYear();", "}"].join(
        "\n",
      ),
    );
    expect(offending.match(LOCAL_ACCESSOR)).toHaveLength(1);
    // And the UTC spelling is not reported.
    const fine = code(
      [
        "export function f(d: Date) {",
        "  return d.getUTCFullYear();",
        "}",
      ].join("\n"),
    );
    expect(fine.match(LOCAL_ACCESSOR)).toBeNull();
  });
});
