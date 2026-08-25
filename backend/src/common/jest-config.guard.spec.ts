import { readFileSync } from "fs";
import { join, posix } from "path";

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
 * Five claims, because excluding the integration specs from the parallel config
 * is only correct if they still run somewhere, still run serially, and no other
 * entry point walks back in:
 *
 *  1. no tracked spec under `test/` is discoverable by the root config, and
 *     every tracked spec under `src/` still is (an exclusion that also drops
 *     unit coverage would otherwise pass claim 1 trivially);
 *  2. every tracked spec under `test/integration/` is discoverable by
 *     `test/jest-e2e.json`, which pins `maxWorkers: 1`;
 *  3. `npm test` chains the two suites sequentially rather than running a
 *     bare `jest`;
 *  4. `test:watch`, `test:debug`, `test:unit` and `test:cov` stay on the root
 *     config -- a watcher aimed at `jest-e2e.json` is the same defect through a
 *     different door;
 *  5. the scripts survive both shells npm uses and carry no
 *     `--passWithNoTests`, so a discovery failure cannot report as green.
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
 * A guard that models a runner is only as good as the model, so the separator
 * handling is the model's, not the host's: every path is compared in POSIX form
 * and the configured patterns are used as authored.
 *
 * Jest does the mirror image of this -- it rewrites the configured separators
 * to the platform's (`replacePathSepForRegex`) and matches native paths -- and
 * the two agree for any pattern whose separators are plain `/` literals, which
 * is all this repository has. A pattern that put a separator inside a character
 * class or a quantifier would be the case where they diverge; there is none,
 * and a comparison against `jest --listTests` would be the way to settle it if
 * one appeared. Normalizing the path rather than the pattern keeps the guard
 * itself host-independent: `git ls-files` reports POSIX paths on every platform,
 * so a Windows checkout answers exactly as CI does.
 */
const toPosix = (value: string): string => value.replace(/\\/g, "/");

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
  const path = toPosix(absolutePath);
  const rootDir = posix.normalize(
    `${toPosix(configDir)}/${config.rootDir ?? "."}`,
  );
  const roots = (config.roots ?? ["<rootDir>"]).map((root) =>
    posix.normalize(toPosix(root).replace("<rootDir>", rootDir)),
  );
  const ignore = config.testPathIgnorePatterns ?? ["/node_modules/"];
  const regexes =
    typeof config.testRegex === "string"
      ? [config.testRegex]
      : (config.testRegex ?? []);

  const underRoots = roots.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
  if (!underRoots) return false;
  if (ignore.some((pattern) => new RegExp(pattern).test(path))) {
    return false;
  }
  return regexes.some((pattern) => new RegExp(pattern).test(path));
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
});

/**
 * The separator case the inventory tests above cannot reach: they read a real
 * checkout, so on Linux they only ever see POSIX paths and would keep passing
 * while the model was wrong for a Windows one. These pin both shapes against
 * the same two configs.
 */
describe("the discovery model", () => {
  const posixPath = "/repo/backend/test/integration/foo.integration.spec.ts";
  const windowsPath =
    "C:\\repo\\backend\\test\\integration\\foo.integration.spec.ts";

  it("answers the same for a native Windows path as for a POSIX one", () => {
    expect(discovers(e2eConfig, "/repo/backend/test", posixPath)).toBe(true);
    expect(discovers(e2eConfig, "C:\\repo\\backend\\test", windowsPath)).toBe(
      true,
    );

    expect(discovers(packageJson.jest, "/repo/backend", posixPath)).toBe(false);
    expect(discovers(packageJson.jest, "C:\\repo\\backend", windowsPath)).toBe(
      false,
    );
  });

  it("keeps a unit spec discoverable in either shape", () => {
    const unit = "/repo/backend/src/common/thing.spec.ts";
    expect(discovers(packageJson.jest, "/repo/backend", unit)).toBe(true);
    expect(
      discovers(
        packageJson.jest,
        "C:\\repo\\backend",
        "C:\\repo\\backend\\src\\common\\thing.spec.ts",
      ),
    ).toBe(true);
  });
});

describe("test scripts", () => {
  /**
   * The scripts that invoke Jest. Listed rather than scanned because
   * `pretest:integration` embeds a JavaScript program whose string literals
   * legitimately use single quotes; a blanket scan would read those as shell
   * quoting and be wrong about the one script that is not a Jest invocation.
   */
  const JEST_SCRIPTS = [
    "test",
    "test:unit",
    "test:integration",
    "test:cov",
    "test:watch",
    "test:debug",
    "test:e2e",
  ];

  it("runs the unit suite and then the integration suite by default", () => {
    const stages = packageJson.scripts.test.split("&&").map((s) => s.trim());
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatch(/^npm run test:unit\b/);
    expect(stages[1]).toMatch(/^npm run test:integration\b/);
    expect(packageJson.scripts["test:integration"]).toContain(
      "--config ./test/jest-e2e.json",
    );
  });

  it("leaves every database-backed entry point to the integration config", () => {
    // Watch and debug inherit the root config, which `roots` has already made
    // unit-only. Pointing either at `jest-e2e.json` would put a file watcher on
    // suites that drop the schema out from under each other -- the original
    // defect, re-entered through a different door.
    for (const script of [
      "test:unit",
      "test:cov",
      "test:watch",
      "test:debug",
    ]) {
      expect(packageJson.scripts[script]).not.toContain("jest-e2e.json");
      expect(packageJson.scripts[script]).not.toContain("--config");
    }
  });

  it("quotes nothing the way only one of the two script shells understands", () => {
    // npm runs scripts through `/bin/sh` on POSIX and `cmd.exe` on Windows,
    // where a single quote is an ordinary character rather than a delimiter. A
    // single-quoted `--testPathPatterns` therefore reaches Jest with the quotes
    // inside the pattern and matches nothing -- a discovery failure dressed up
    // as an empty run. Double quotes are a delimiter in both shells.
    for (const script of JEST_SCRIPTS) {
      expect(packageJson.scripts[script]).not.toContain("'");
    }
  });

  it("never lets an empty match pass for a green run", () => {
    // REL-001 (docs/release-integrity.md): a blanket `--passWithNoTests` turns a
    // discovery failure into a green check across every test kind the job owns.
    for (const script of JEST_SCRIPTS) {
      expect(packageJson.scripts[script]).not.toContain("--passWithNoTests");
    }
  });
});
