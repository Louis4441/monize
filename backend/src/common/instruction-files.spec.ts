import { readFileSync, statSync } from "fs";
import { basename, join } from "path";

import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * The instruction files are read on every task, so their size is a cost every
 * task pays. `frontend/CLAUDE.md` was compacted once (PR 1245) and grew back to
 * 188 KB, because each rule brought the defect it came from, the reasoning and
 * the guard along with it; the fix was to make the layer files indexes over
 * `docs/frontend/` and `docs/backend/`, where a rule is read only when the work
 * touches its subject. The root `CLAUDE.md` says how the files are organised.
 * Prose about file size is exactly the kind of rule that gets read, agreed with
 * and violated one paragraph at a time, so this is the version the machine
 * checks:
 *
 *  - a layer file stays under `LAYER_FILE_MAX_BYTES`;
 *  - the root file stays under a shrink-only ceiling -- it is over the layer
 *    limit today and still carries defect histories, and the ceiling is what
 *    stops it growing while that is paid down. Lower it as it shrinks; never
 *    raise it;
 *  - every document under `docs/frontend/` and `docs/backend/` is named in its
 *    layer index, so a rule cannot be filed where no reader is sent;
 *  - a layer index carries no issue or PR number: that is the marker of a
 *    defect history, which belongs in the `docs/<layer>/` entry.
 *
 * The inventory comes from `git ls-files`, so a new document under either
 * directory is covered once it is staged.
 */

export const LAYER_FILE_MAX_BYTES = 16 * 1024;

/**
 * Shrink-only. 60,135 bytes when this guard was written; the allowance above
 * that is for wording, not for a new paragraph.
 */
export const ROOT_FILE_CEILING_BYTES = 61 * 1024;

const LAYER_FILES = [
  "frontend/CLAUDE.md",
  "backend/CLAUDE.md",
  "database/CLAUDE.md",
];

/** The layers whose CLAUDE.md is an index over `docs/<layer>/`. */
const INDEXED_LAYERS = ["frontend", "backend"];

const ISSUE_NUMBER = /(?:^|[^\w`/])#\d{3,}\b/;

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree(
  "instruction files keep the shape the root CLAUDE.md describes",
  () => {
    const root = () => requireRepoRoot(REPO_ROOT);
    const read = (relative: string) =>
      readFileSync(join(root(), relative), "utf8");
    const size = (relative: string) => statSync(join(root(), relative)).size;

    it.each(LAYER_FILES)("%s stays under the layer ceiling", (relative) => {
      expect(size(relative)).toBeLessThanOrEqual(LAYER_FILE_MAX_BYTES);
    });

    it("the root CLAUDE.md stays under its shrink-only ceiling", () => {
      expect(size("CLAUDE.md")).toBeLessThanOrEqual(ROOT_FILE_CEILING_BYTES);
    });

    it.each(INDEXED_LAYERS)(
      "every docs/%s document is reachable from its layer index",
      (layer) => {
        const docs = gitListFiles(root(), `-- docs/${layer}`).filter(
          (f) => f.endsWith(".md") && basename(f) !== "README.md",
        );
        // A guard over an empty directory would prove nothing.
        expect(docs.length).toBeGreaterThan(3);
        const index = read(`${layer}/CLAUDE.md`);
        const unreachable = docs.filter((doc) => !index.includes(`\`${doc}\``));
        expect(unreachable).toEqual([]);
      },
    );

    it.each(INDEXED_LAYERS)(
      "%s/CLAUDE.md carries no issue or PR number",
      (layer) => {
        const offending = read(`${layer}/CLAUDE.md`)
          .split("\n")
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => ISSUE_NUMBER.test(line))
          .map(({ line, n }) => `${layer}/CLAUDE.md:${n}: ${line.trim()}`);
        expect(offending).toEqual([]);
      },
    );
  },
);

describe("the issue-number marker", () => {
  it("matches a defect citation and not a colour or an anchor", () => {
    expect(ISSUE_NUMBER.test("the panel is issue #1229")).toBe(true);
    expect(ISSUE_NUMBER.test("(#1247, INV-OCCURRENCE-003)")).toBe(true);
    expect(ISSUE_NUMBER.test("colour `#ffffff` on the card")).toBe(false);
    expect(ISSUE_NUMBER.test("a `#12` heading")).toBe(false);
    expect(ISSUE_NUMBER.test("/reports#1234-section")).toBe(false);
  });
});
