import * as fs from "fs";
import * as path from "path";

/**
 * Startup output is part of the log, so it follows the same format as
 * everything else: `[Nest] pid - date LEVEL [Context] message`, produced by the
 * NestJS `Logger` (which works outside an application context, so the
 * pre-boot scripts can use it too).
 *
 * The two ways that convention gets broken are a shell `echo` in the entrypoint
 * and a `console.*` call in a script that runs before Nest starts. Both are
 * mechanical, so both are scanned for here rather than left to review; the
 * `console` half is also an ESLint ban (`no-console`), which this test backs up
 * for the pre-boot entry points specifically.
 */

const BACKEND_ROOT = path.resolve(__dirname, "..");
const ENTRYPOINT = path.join(BACKEND_ROOT, "docker-entrypoint.sh");

/** Scripts the entrypoint runs before (or instead of) the Nest app. */
const PRE_BOOT_SCRIPTS = [
  "src/db-init.ts",
  "src/db-migrate.ts",
  "src/db-demo-check.ts",
  "src/database/seed.ts",
  "src/common/db/app-role.ts",
];

function sourceLines(file: string): string[] {
  return fs.readFileSync(path.join(BACKEND_ROOT, file), "utf8").split("\n");
}

describe("startup logging conventions", () => {
  describe("docker-entrypoint.sh", () => {
    const lines = fs.readFileSync(ENTRYPOINT, "utf8").split("\n");
    const code = lines.filter((line) => !line.trim().startsWith("#"));

    it("prints nothing itself -- a shell echo has no timestamp, level or context", () => {
      const echoes = code.filter((line) => /(^|[;&|]\s*)echo\s/.test(line));
      expect(echoes).toEqual([]);
    });

    it("runs compiled scripts rather than inline node -e blobs", () => {
      // `node -e` output cannot reach the Nest Logger without duplicating it in
      // a string, so the demo-user probe lives in src/db-demo-check.ts.
      const inline = code.filter((line) => /node\s+-e/.test(line));
      expect(inline).toEqual([]);
    });
  });

  describe.each(PRE_BOOT_SCRIPTS)("%s", (file) => {
    it("logs through the Nest Logger, not console", () => {
      const offenders = sourceLines(file).filter(
        (line) =>
          /\bconsole\.(log|info|warn|error|debug)\s*\(/.test(line) &&
          !line.trim().startsWith("*") &&
          !line.trim().startsWith("//"),
      );
      expect(offenders).toEqual([]);
    });

    it("instantiates a Logger with a context", () => {
      const source = sourceLines(file).join("\n");
      expect(source).toMatch(/new Logger\("[A-Za-z]+"\)/);
    });
  });
});
