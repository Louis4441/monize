import { readFileSync } from "fs";
import { join, sep } from "path";

import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * The parallel Jest config must not be able to discover a database-backed spec.
 *
 * Every suite under `test/integration/` builds its schema through
 * `INTEGRATION_TYPEORM_OPTIONS` (`test/helpers/integration-setup.ts`) with
 * `synchronize: true` and `dropSchema: true` against the one shared
 * `monize_test` database. Two workers doing that concurrently drop the tables
 * out from under each other, which surfaces as
 * `duplicate key value violates unique constraint pg_type_typname_nsp_index`
 * or a "connection terminated" from a spec unrelated to the one that raced --
 * roughly ten suites failing nondeterministically per run.
 *
 * The rule was written down (`integration-setup.ts` says to keep
 * `maxWorkers: 1` in `test/jest-e2e.json`, and `backend/CLAUDE.md` documents
 * the split) and was violated anyway: the root config in `package.json` used
 * `rootDir: "."` with `testRegex: ".*\\.spec\\.ts$"`, so a bare `jest` -- what
 * `npm test`, `test:watch` and `test:debug` all ran -- swept `src/` and
 * `test/integration/` into the same parallel run. CI was never affected; it
 * calls `test:unit` and `test:integration` separately. Only the default local
 * entry point was broken, which is exactly the kind of thing prose does not
 * fix. This is the version the machine checks.
 *
 * Three claims, because excluding the integration specs from the parallel
 * config is only correct if they still run somewhere and still run serially:
 *
 *  1. no tracked spec under `test/` is discoverable by the root config, and
 *     every tracked spec under `src/` still is (an exclusion that also drops
 *     unit coverage would otherwise pass claim 1 trivially);
 *  2. every tracked spec under `test/integration/` is discoverable by
 *     `test/jest-e2e.json`, which pins `maxWorkers: 1`;
 *  3. `npm test` chains the two suites sequentially rather than running a
 *     bare `jest`.
 *
 * The inventory comes from `git ls-files`, so the guard sees the tree CI sees.
 * A brand-new spec is invisible to it until staged -- `git add -N` is enough.
 */

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

const BACKEND_DIR = join(__dirname, "..", "..");

type JestConfig = {
  rootDir?: string;
  roots?: string[];
  testRegex?: string | string[];
  testMatch?: string[];
  testPathIgnorePatterns?: string[];
  maxWorkers?: number;
};

const packageJson = JSON.parse(
  readFileSync(join(BACKEND_DIR, "package.json"), "utf8"),
) as { scripts: Record<string, string>; jest: JestConfig };

const e2eConfig = JSON.parse(
  readFileSync(join(BACKEND_DIR, "test", "jest-e2e.json"), "utf8"),
) as JestConfig;

/**
 * Jest's discovery rules, modelled closely enough to answer "would this file
 * run under this config": a path is a test when it sits under one of `roots`,
 * matches one of the `testRegex` patterns, and is not excluded by
 * `testPathIgnorePatterns`. All three are matched against the absolute path.
 *
 * `testMatch` (glob) is the alternative to `testRegex` and is not modelled --
 * a config using it would be silently mis-answered here, so its presence is a
 * failure rather than a fallthrough.
 */
function discovers(
  config: JestConfig,
  configDir: string,
  absolutePath: string,
): boolean {
  if (config.testMatch) {
    throw new Error(
      `config at ${configDir} uses testMatch; this guard models testRegex only`,
    );
  }
  const rootDir = join(configDir, config.rootDir ?? ".");
  const roots = (config.roots ?? ["<rootDir>"]).map((root) =>
    root.replace("<rootDir>", rootDir),
  );
  const ignore = config.testPathIgnorePatterns ?? ["/node_modules/"];
  const regexes =
    typeof config.testRegex === "string"
      ? [config.testRegex]
      : (config.testRegex ?? []);

  const underRoots = roots.some(
    (root) => absolutePath === root || absolutePath.startsWith(root + sep),
  );
  if (!underRoots) return false;
  if (ignore.some((pattern) => new RegExp(pattern).test(absolutePath))) {
    return false;
  }
  return regexes.some((pattern) => new RegExp(pattern).test(absolutePath));
}

describeTree("jest configuration", () => {
  const specs = (prefix: string): string[] => {
    const root = requireRepoRoot(REPO_ROOT);
    return gitListFiles(root, `-- "backend/${prefix}"`)
      .filter((file) => file.endsWith(".spec.ts"))
      .map((file) => join(root, file));
  };

  it("keeps every database-backed spec out of the parallel config", () => {
    const testTreeSpecs = specs("test");
    // Guards the guard: an empty inventory would make the assertion vacuous.
    expect(testTreeSpecs.length).toBeGreaterThan(30);

    const discovered = testTreeSpecs.filter((file) =>
      discovers(packageJson.jest, BACKEND_DIR, file),
    );
    expect(discovered).toEqual([]);
  });

  it("still discovers every unit spec in the parallel config", () => {
    const srcSpecs = specs("src");
    expect(srcSpecs.length).toBeGreaterThan(100);

    const missed = srcSpecs.filter(
      (file) => !discovers(packageJson.jest, BACKEND_DIR, file),
    );
    expect(missed).toEqual([]);
  });

  it("leaves the integration specs owned by a single-worker config", () => {
    const testDir = join(BACKEND_DIR, "test");
    const integrationSpecs = specs("test/integration");
    expect(integrationSpecs.length).toBeGreaterThan(30);

    const missed = integrationSpecs.filter(
      (file) => !discovers(e2eConfig, testDir, file),
    );
    expect(missed).toEqual([]);
    // `dropSchema` against one shared database: a second worker is a race, not
    // a speedup. Pinned in the config so every entry point inherits it rather
    // than each call site remembering `--runInBand`.
    expect(e2eConfig.maxWorkers).toBe(1);
  });

  it("runs the unit suite and then the integration suite by default", () => {
    const stages = packageJson.scripts.test.split("&&").map((s) => s.trim());
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatch(/^npm run test:unit\b/);
    expect(stages[1]).toMatch(/^npm run test:integration\b/);
    expect(packageJson.scripts["test:integration"]).toContain(
      "--config ./test/jest-e2e.json",
    );
  });
});
