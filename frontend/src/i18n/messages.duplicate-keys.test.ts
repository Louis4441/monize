import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * No catalog may declare the same key twice inside one object.
 *
 * `JSON.parse` accepts a duplicate key and keeps the **last** one, so nothing
 * downstream can see the collision: the file loads, the parity test counts one
 * key and passes, `npm run i18n:check` compares parsed objects and passes, and
 * the only symptom is that the copy somebody reviewed is not the copy that
 * ships. That is how a branch adding `mnyJobStalledAfterCommit` to twenty
 * catalogs that already had it went unnoticed -- twenty translated strings
 * silently replaced, in every language, by a second set nobody had compared
 * against the first.
 *
 * A merge is where this happens rather than an edit: both sides append to the
 * end of the same object and a textual auto-merge keeps both lines. So the
 * check has to read the *bytes*, not the parsed object -- by the time it is an
 * object the evidence is gone.
 */

const here = dirname(fileURLToPath(import.meta.url));
const messagesDir = join(here, 'messages');

const catalogFiles = (): string[] =>
  readdirSync(messagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((dir) =>
      readdirSync(join(messagesDir, dir.name))
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(dir.name, f)),
    );

/**
 * Every `"key":` that appears twice under the same parent object, as
 * `path.to.key` paths.
 *
 * Written as a scanning parser rather than a regex over the whole file because
 * the question is scoped: the same leaf name under two different parents is
 * ordinary and must not be reported, while twice under one parent is the bug.
 */
function duplicateKeyPaths(source: string): string[] {
  const duplicates: string[] = [];
  const stack: Array<{ key: string | null; seen: Set<string> }> = [];
  const path: string[] = [];
  let pendingKey: string | null = null;
  let i = 0;

  const readString = (): string => {
    // `i` is at the opening quote.
    let out = '';
    i += 1;
    while (i < source.length && source[i] !== '"') {
      if (source[i] === '\\') {
        out += source[i] + source[i + 1];
        i += 2;
        continue;
      }
      out += source[i];
      i += 1;
    }
    i += 1;
    return out;
  };

  while (i < source.length) {
    const char = source[i];
    if (char === '"') {
      const value = readString();
      // A string is a key when the next non-space character is a colon.
      let j = i;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (source[j] === ':') {
        pendingKey = value;
        const frame = stack[stack.length - 1];
        if (frame) {
          if (frame.seen.has(value)) {
            duplicates.push([...path, value].join('.'));
          }
          frame.seen.add(value);
        }
      }
      continue;
    }
    if (char === '{') {
      stack.push({ key: pendingKey, seen: new Set() });
      path.push(pendingKey ?? '(root)');
      pendingKey = null;
    } else if (char === '}') {
      stack.pop();
      path.pop();
    }
    i += 1;
  }
  return duplicates;
}

describe('message catalogs', () => {
  it('declare every key exactly once per object', () => {
    const offenders = catalogFiles().flatMap((file) => {
      const dupes = duplicateKeyPaths(
        readFileSync(join(messagesDir, file), 'utf8'),
      );
      return dupes.map((keyPath) => `${file}: ${keyPath}`);
    });

    expect(offenders).toEqual([]);
  });

  it('detects a duplicate only within the same object', () => {
    // The guard above is worthless if it cannot fail, and worse than worthless
    // if it fails on the ordinary case of one leaf name under two parents.
    expect(
      duplicateKeyPaths('{"a": {"x": 1}, "b": {"x": 2}}'),
    ).toEqual([]);
    expect(duplicateKeyPaths('{"a": {"x": 1, "x": 2}}')).toEqual([
      '(root).a.x',
    ]);
    // A key name appearing as a *value* is not a declaration.
    expect(duplicateKeyPaths('{"a": "x", "b": "x"}')).toEqual([]);
  });
});
