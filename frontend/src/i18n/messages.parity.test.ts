import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Structural parity between the English source catalogs and every translated
 * locale. A missing key would render the raw key path to users (next-intl has
 * no per-key fallback here), and a placeholder referenced in a translation but
 * not supplied by the component would break interpolation -- so both are
 * guarded here for all current and future locales.
 */

const here = dirname(fileURLToPath(import.meta.url));
const messagesDir = join(here, 'messages');

// Locales that must be complete mirrors of `en`. `xx` is excluded: it is the
// generated pseudo-locale (covered by `npm run i18n:check`).
const TRANSLATED_LOCALES = readdirSync(messagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'en' && d.name !== 'xx')
  .map((d) => d.name);

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function flatten(value: Json, prefix = ''): Record<string, Json> {
  if (Array.isArray(value)) {
    return value.reduce<Record<string, Json>>((acc, v, i) => {
      Object.assign(acc, flatten(v, `${prefix}[${i}]`));
      return acc;
    }, {});
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce<Record<string, Json>>((acc, [k, v]) => {
      Object.assign(acc, flatten(v, prefix ? `${prefix}.${k}` : k));
      return acc;
    }, {});
  }
  return { [prefix]: value };
}

function load(locale: string, file: string): Record<string, Json> {
  return flatten(JSON.parse(readFileSync(join(messagesDir, locale, file), 'utf8')));
}

const namespaceFiles = readdirSync(join(messagesDir, 'en')).filter((f) =>
  f.endsWith('.json'),
);

/**
 * Real ICU argument names for a message: `{name}` and the selector of
 * `{name, plural/select, ...}`. Plural/select branch literals (e.g. the
 * `transakcje` in `one {# transakcje}`) are not arguments and are skipped.
 */
function icuArgs(message: string): Set<string> {
  const args = new Set<string>();

  function parseMessage(i: number): number {
    while (i < message.length) {
      const c = message[i];
      if (c === '}') return i;
      if (c === '{') {
        i = parseArg(i + 1);
      } else {
        i += 1;
      }
    }
    return i;
  }

  function parseArg(i: number): number {
    const m = /^\s*([a-zA-Z0-9_]+)\s*/.exec(message.slice(i));
    if (!m) throw new Error(`Malformed ICU argument at ${i}: ${message}`);
    args.add(m[1]);
    i += m[0].length;
    if (message[i] === '}') return i + 1;
    if (message[i] !== ',') throw new Error(`Expected , or } in: ${message}`);
    const typeMatch = /^\s*([a-zA-Z]+)\s*/.exec(message.slice(i + 1));
    if (!typeMatch) throw new Error(`Missing ICU type in: ${message}`);
    const type = typeMatch[1];
    i += 1 + typeMatch[0].length;
    if (type === 'plural' || type === 'select' || type === 'selectordinal') {
      i += 1; // consume the ',' before the branches
      while (i < message.length) {
        while (i < message.length && /\s/.test(message[i])) i += 1;
        if (message[i] === '}') return i + 1;
        const key = /^(=?\w+)\s*/.exec(message.slice(i));
        if (!key) throw new Error(`Bad branch key in: ${message}`);
        i += key[0].length;
        while (i < message.length && /\s/.test(message[i])) i += 1;
        if (message[i] !== '{') throw new Error(`Expected { branch in: ${message}`);
        i = parseMessage(i + 1) + 1;
      }
      throw new Error(`Unterminated ${type} in: ${message}`);
    }
    // number/date/time and similar: skip to the matching brace
    let depth = 1;
    while (i < message.length && depth > 0) {
      if (message[i] === '{') depth += 1;
      else if (message[i] === '}') depth -= 1;
      i += 1;
    }
    return i;
  }

  parseMessage(0);
  return args;
}

describe.each(TRANSLATED_LOCALES)('locale "%s"', (locale) => {
  it('has the same namespace files as en', () => {
    expect(readdirSync(join(messagesDir, locale)).sort()).toEqual(
      namespaceFiles.slice().sort(),
    );
  });

  describe.each(namespaceFiles)('%s', (file) => {
    const en = load('en', file);
    const translated = load(locale, file);

    it('has identical key structure to en', () => {
      expect(Object.keys(translated).sort()).toEqual(Object.keys(en).sort());
    });

    it('only references ICU placeholders supplied by en', () => {
      for (const [key, value] of Object.entries(translated)) {
        if (typeof value !== 'string' || typeof en[key] !== 'string') continue;
        const enArgs = icuArgs(en[key] as string);
        const localeArgs = icuArgs(value);
        const extra = [...localeArgs].filter((a) => !enArgs.has(a));
        expect(extra, `${file}:${key} -> ${value}`).toEqual([]);
      }
    });
  });
});
