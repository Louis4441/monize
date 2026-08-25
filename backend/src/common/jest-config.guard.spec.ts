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
 *  4. no script selecting a config that reaches the database-backed suites
 *     runs them unserialized or under a watcher -- a watcher aimed at
 *     `jest-e2e.json` is the same defect through a different door;
 *  5. every Jest entry point survives both shells npm uses, and nothing in the
 *     tree that can start a runner carries a zero-discovery success flag
 *     (REL-001), so a discovery failure cannot report as green.
 *
 * Claims 4 and 5 derive their subjects -- the scripts, the configs they select
 * and the files that can launch a runner -- from the manifests and the tracked
 * tree rather than naming them, because a guard whose inventory has to be
 * updated by hand fails exactly when someone adds an entry point without
 * thinking of it.
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
  // `<rootDir>` is expanded in every path-bearing pattern, not just in `roots`:
  // excluding the database-backed tree with
  // `testPathIgnorePatterns: ["<rootDir>/test/"]` is a correct configuration,
  // and a model that left the token unexpanded would fail it for the wrong
  // reason -- a guard that rejects a right answer teaches people to delete it.
  const expand = (pattern: string): string =>
    pattern.replace("<rootDir>", rootDir);
  const ignore = (config.testPathIgnorePatterns ?? ["/node_modules/"]).map(
    expand,
  );
  const regexes = (
    typeof config.testRegex === "string"
      ? [config.testRegex]
      : (config.testRegex ?? [])
  ).map(expand);

  const underRoots = roots.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
  if (!underRoots) return false;
  if (ignore.some((pattern) => new RegExp(pattern).test(path))) {
    return false;
  }
  return regexes.some((pattern) => new RegExp(pattern).test(path));
}

/**
 * Every inventory below is repository-relative, and the configs are evaluated
 * against a fixed virtual root rather than this machine's checkout path. A
 * failure therefore names the offending spec by its path from the repository
 * root rather than by someone's home directory, and reads the same on CI, in
 * the dev container and on a Windows checkout.
 */
const VIRTUAL_ROOT = "/repo";
const virtual = (repoRelative: string): string =>
  `${VIRTUAL_ROOT}/${repoRelative}`;

/**
 * A suite file ends in either .spec.ts or .e2e-spec.ts, and only the first
 * spelling matches the root config's `testRegex` -- which is exactly why the
 * inventory must not filter on it. The five e2e-spec suites directly under
 * `backend/test/` build their schema the same way the integration ones do, so
 * an inventory that quietly skipped them would leave claim 1 unchecked for the
 * files it most needs to cover.
 */
const SPEC_SUFFIX = /[.-]spec\.ts$/;

const specs = (prefix: string): string[] => {
  const root = requireRepoRoot(REPO_ROOT);
  return gitListFiles(root, `-- "backend/${prefix}"`).filter((file) =>
    SPEC_SUFFIX.test(file),
  );
};

describeTree("jest configuration", () => {
  it("keeps every database-backed spec out of the parallel config", () => {
    const testTreeSpecs = specs("test");
    // Guards the guard: an empty inventory would make the assertion vacuous.
    expect(testTreeSpecs.length).toBeGreaterThan(30);

    const discovered = testTreeSpecs.filter((file) =>
      discovers(packageJson.jest, virtual("backend"), virtual(file)),
    );
    expect(discovered).toEqual([]);
  });

  it("still discovers every unit spec in the parallel config", () => {
    const srcSpecs = specs("src");
    expect(srcSpecs.length).toBeGreaterThan(100);

    const missed = srcSpecs.filter(
      (file) => !discovers(packageJson.jest, virtual("backend"), virtual(file)),
    );
    expect(missed).toEqual([]);
  });

  it("leaves the integration specs owned by a single-worker config", () => {
    const integrationSpecs = specs("test/integration");
    expect(integrationSpecs.length).toBeGreaterThan(30);

    const missed = integrationSpecs.filter(
      (file) => !discovers(e2eConfig, virtual("backend/test"), virtual(file)),
    );
    expect(missed).toEqual([]);
    // `dropSchema` against one shared database: a second worker is a race, not
    // a speedup. Pinned in the config so every entry point inherits it rather
    // than each call site remembering `--runInBand`. It stays until the suites
    // get a database per worker; nothing else makes them safe to parallelize.
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

  it("honours <rootDir> in an ignore pattern", () => {
    // The other correct way to write this exclusion. A model that left the
    // token unexpanded would call this config broken and send its author
    // looking for a defect that is in the guard.
    const byIgnorePattern = {
      rootDir: ".",
      testRegex: ".*\\.spec\\.ts$",
      testPathIgnorePatterns: ["<rootDir>/test/"],
    };
    expect(discovers(byIgnorePattern, "/repo/backend", posixPath)).toBe(false);
    expect(
      discovers(byIgnorePattern, "/repo/backend", "/repo/backend/a.spec.ts"),
    ).toBe(true);
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

describeTree("test scripts", () => {
  /**
   * Derived, not listed. A second hand-maintained inventory of test scripts is
   * a rule that holds until someone adds `test:smoke` and does not think to
   * come here -- which is the failure mode this whole file exists to remove.
   * The token match picks up `jest` and `node_modules/.bin/jest` alike, and
   * leaves out `pretest:integration`, which runs a `node -e` program whose
   * string literals legitimately use single quotes, and `test`, which only
   * delegates to the two scripts below.
   */
  const jestScripts = Object.entries(packageJson.scripts)
    .filter(([, command]) => /(^|[\s/\\])jest(\s|$)/.test(command))
    .map(([name]) => name);

  it("derives a non-empty set of Jest entry points", () => {
    // If the token match ever stops finding anything, every assertion below
    // would pass over an empty list.
    expect(jestScripts).toEqual(
      expect.arrayContaining([
        "test:unit",
        "test:integration",
        "test:cov",
        "test:watch",
        "test:debug",
        "test:e2e",
      ]),
    );
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

  it("never runs a database-backed config in parallel or under a watcher", () => {
    // Derived from the property, not from the script names: a script that does
    // not pass `--config` runs the root config, which `roots` has already made
    // unit-only, so only the ones that select another config can reach the
    // shared database. Those must pin one worker and must not be watchers --
    // `test:watch:integration` is the original defect through a different door,
    // and naming today's four safe scripts would not have caught it.
    const root = requireRepoRoot(REPO_ROOT);
    const offenders = jestScripts.flatMap((script) => {
      const command = packageJson.scripts[script];
      const selected = /--config[= ]+(\S+)/.exec(command)?.[1];
      if (!selected) return [];
      if (!selected.endsWith(".json")) {
        throw new Error(
          `${script} selects ${selected}, which this guard cannot read; extend it rather than trusting the script`,
        );
      }
      const configPath = posix.normalize(`backend/${selected}`);
      const config = JSON.parse(
        readFileSync(join(root, configPath), "utf8"),
      ) as JestConfig;
      const configDir = virtual(posix.dirname(configPath));
      const reachesDatabaseSuites = specs("test").some((file) =>
        discovers(config, configDir, virtual(file)),
      );
      if (!reachesDatabaseSuites) return [];
      const problems: string[] = [];
      if (config.maxWorkers !== 1) {
        problems.push(`${script} -> ${selected} does not pin maxWorkers: 1`);
      }
      if (/(^|\s)--watch\b/.test(command)) {
        problems.push(`${script} watches ${selected}`);
      }
      return problems;
    });
    expect(offenders).toEqual([]);
  });

  it("quotes nothing the way only one of the two script shells understands", () => {
    // npm runs scripts through `/bin/sh` on POSIX and `cmd.exe` on Windows,
    // where a single quote is an ordinary character rather than a delimiter. A
    // single-quoted `--testPathPatterns` therefore reaches Jest with the quotes
    // inside the pattern and matches nothing -- a discovery failure dressed up
    // as an empty run. Double quotes are a delimiter in both shells.
    const quoted = jestScripts.filter((script) =>
      packageJson.scripts[script].includes("'"),
    );
    expect(quoted).toEqual([]);
  });
});

/**
 * REL-001 (`docs/release-integrity.md`) is a repository rule, not a backend
 * one: a blanket "succeed if nothing was discovered" turns a discovery failure
 * into a green check for whichever runner carries it. So the subjects are every
 * tracked surface that can *start a runner* -- manifests (scripts and the
 * inline `jest` block alike), runner configs, workflows, shell scripts and
 * Dockerfiles -- listed from the tree rather than named here, because the whole
 * point is to cover the entry point nobody thought to add.
 *
 * Prose is deliberately out of scope: `docs/release-integrity.md` quotes the
 * flag while forbidding it, and a scan that read documents would fail on the
 * document that states the rule.
 *
 * Both spellings of both forms count. Jest and Vitest take `--passWithNoTests`,
 * Playwright `--pass-with-no-tests`, and the config field is `passWithNoTests:
 * true` in a JS config and `"passWithNoTests": true` in a JSON one -- the
 * quoted spelling being the likelier of the two here, since the config this
 * rule names (`test/jest-e2e.json`) is JSON.
 */
describeTree("zero-discovery flags", () => {
  const CLI_FLAG = /--pass-?with-?no-?tests/i;
  const CONFIG_FIELD = /"?passWithNoTests"?\s*:\s*true/;

  it("are absent from every surface that can start a runner", () => {
    const root = requireRepoRoot(REPO_ROOT);

    const subjects = gitListFiles(
      root,
      [
        "--",
        '"*package.json"',
        '"*jest.config.*"',
        '"*jest-e2e.json"',
        '"*vitest.config.*"',
        '"*playwright.config.*"',
        '".github/workflows/*"',
        '"*.sh"',
        '"*Dockerfile*"',
      ].join(" "),
    );
    // Guards the guard twice over: an empty or narrowed pathspec would make the
    // scan vacuous, and these four are the surfaces the rule exists for.
    expect(subjects).toEqual(
      expect.arrayContaining([
        "backend/package.json",
        "backend/test/jest-e2e.json",
        "frontend/vitest.config.ts",
        ".github/workflows/ci.yml",
      ]),
    );

    const offenders = subjects.filter((subject) => {
      const source = readFileSync(join(root, subject), "utf8");
      return CLI_FLAG.test(source) || CONFIG_FIELD.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
