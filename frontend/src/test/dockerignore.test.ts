import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.dockerignore` filename patterns must be recursive, guarded because the
 * failure is silent and lands somewhere else entirely.
 *
 * `.dockerignore` looks like `.gitignore` and is not: a pattern with no slash
 * is matched against the path relative to the build context and nothing else,
 * so `*.test.tsx` excludes a test beside the Dockerfile and no test under
 * `src/`. Git would have walked it down the tree; Docker does not.
 *
 * Nothing about that is visible in the image build until something reads the
 * files that were supposed to be gone. `src/test/` -- a directory path, so it
 * did match -- was excluded while all 600-odd tests importing `@/test/render`
 * were copied in, and `next build` type-checks those as of 16.3, so the
 * frontend image failed on helpers that were correctly left behind. The same
 * `*.spec.ts` in `backend/.dockerignore` shipped every backend spec into that
 * image; it stayed quiet only because `nest build` excludes specs itself.
 *
 * So the rule is mechanical: any pattern whose last segment contains a `*`
 * carries an explicit leading globstar (or a directory path that scopes it).
 * A bare one is either a bug or a deliberate root-only exclusion, which should
 * say so with a leading `./`.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..');

const DOCKERIGNORES = [
  'frontend/.dockerignore',
  'backend/.dockerignore',
  '.dockerignore',
];

function patternsIn(relativePath: string): string[] {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * A pattern that only ever matches at the context root, despite naming a file
 * by wildcard rather than by location.
 */
function isNonRecursiveFileGlob(pattern: string): boolean {
  const bare = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (bare.startsWith('**/') || bare.startsWith('./')) return false;
  const segments = bare.split('/');
  // A pattern with a directory component is scoping deliberately (`src/test/`).
  if (segments.filter((segment) => segment.length > 0).length > 1) return false;
  return segments[segments.length - 1].includes('*');
}

describe('.dockerignore patterns', () => {
  it.each(DOCKERIGNORES)('%s scopes every filename glob with **/', (file) => {
    const offenders = patternsIn(file).filter(isNonRecursiveFileGlob);

    expect(
      offenders,
      `${file}: these match only the build-context root, so the files they name ` +
        `are still copied into the image from every subdirectory. Prefix each ` +
        `with **/ (and its negation too), or write ./ to mean root-only.`,
    ).toEqual([]);
  });

  it('recognises the shapes the rule turns on', () => {
    // The bug this test was written for, and its fix.
    expect(isNonRecursiveFileGlob('*.test.tsx')).toBe(true);
    expect(isNonRecursiveFileGlob('**/*.test.tsx')).toBe(false);
    // Negations carry the same trap: `!.env.example` re-includes only the root.
    expect(isNonRecursiveFileGlob('!.env.example')).toBe(false);
    expect(isNonRecursiveFileGlob('!*.env.example')).toBe(true);
    // Plain names and scoped paths are matched by Docker as written.
    expect(isNonRecursiveFileGlob('node_modules')).toBe(false);
    expect(isNonRecursiveFileGlob('src/test/')).toBe(false);
    expect(isNonRecursiveFileGlob('./*.log')).toBe(false);
  });
});
