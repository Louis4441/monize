import { execSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";

/**
 * Shared plumbing for the source-scanning guard suites (`doc-paths.spec.ts`,
 * `cron-doc.spec.ts`), which check repository-wide claims and therefore need
 * the repository, not just `backend/`.
 *
 * The repo root is found by marker, not by counting `..` segments: inside the
 * dev container (docker-compose.dev.yml mounts `./backend:/app`) a fixed
 * traversal lands on `/`, and a filesystem walk from there recurses the whole
 * container before failing. A `null` root means the checkout genuinely lacks
 * the rest of the repository; the suites skip visibly in that case and hard-fail
 * when it happens on CI, where the full checkout is guaranteed and a missing
 * root is a broken guard.
 */
export function findRepoRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (
      ["CLAUDE.md", "docs", "backend", "database"].every((marker) =>
        existsSync(join(dir, marker)),
      )
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `git ls-files`, so a guard sees exactly the tree CI sees and needs no
 * hand-maintained skip list: `node_modules`, build output and local agent
 * scratch are simply not tracked.
 */
export function gitListFiles(repoRoot: string, args = ""): string[] {
  return execSync(`git ls-files -z ${args}`, {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

/**
 * Thrown by a suite whose data cannot be built without the full checkout; on
 * CI the corresponding `describe` is not skipped, so this surfaces as a loud
 * failure instead of a silent green.
 */
export function requireRepoRoot(repoRoot: string | null): string {
  if (!repoRoot) {
    throw new Error(
      "repository root not found: this suite needs the full checkout, and on CI that absence is a failure, not a skip",
    );
  }
  return repoRoot;
}
