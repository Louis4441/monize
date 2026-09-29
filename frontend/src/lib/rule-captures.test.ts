import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_NAME,
  MAX_CAPTURES_PER_PATTERN,
  RESERVED_CAPTURE_NAMES,
  TEMPLATE_BUILTINS,
  availablePlaceholders,
  checkPattern,
  checkTemplate,
  parseGlobCaptures,
  parseTemplateRefs,
  scanCaptures,
} from './rule-captures';
import { createGroup, createLeaf, type EditorLeaf } from './rule-tree';

const backend = join(__dirname, '..', '..', '..', 'backend', 'src', 'transaction-rules');
const read = (file: string) => readFileSync(join(backend, file), 'utf8');

describe('the capture syntax against the backend', () => {
  it('carries the same limits, name syntax, reserved names and built-ins', () => {
    const glob = read('rule-glob-capture.ts');
    expect(Number(/MAX_CAPTURES_PER_PATTERN = (\d+);/.exec(glob)?.[1])).toBe(MAX_CAPTURES_PER_PATTERN);
    expect(/CAPTURE_NAME = (\/.*\/);/.exec(glob)?.[1]).toBe(String(CAPTURE_NAME));
    const reserved = /RESERVED_CAPTURE_NAMES: readonly string\[\] = \[(.*)\];/.exec(glob)?.[1] ?? '';
    expect([...reserved.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual([...RESERVED_CAPTURE_NAMES]);
    const template = read('rule-template.ts');
    const builtins = /TEMPLATE_BUILTINS: readonly string\[\] = \[([\s\S]*?)\];/.exec(template)?.[1] ?? '';
    expect([...builtins.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual([...TEMPLATE_BUILTINS]);
  });

  it('reads the brace bounds the same way', () => {
    expect(/MAX_BRACE_BODY = (\d+);/.exec(read('rule-glob-capture.ts'))?.[1]).toBe('32');
    expect(/MAX_BRACE_BODY = (\d+);/.exec(read('rule-template.ts'))?.[1]).toBe('32');
    // 32 characters is still looked at, 33 is plain text.
    expect(parseGlobCaptures(`{${'A'.repeat(32)}}`).malformed).toHaveLength(1);
    expect(parseGlobCaptures(`{${'A'.repeat(33)}}`).malformed).toHaveLength(0);
  });
});

describe('parseGlobCaptures', () => {
  it('finds the names in order, duplicates kept', () => {
    expect(parseGlobCaptures('*Payee: {payee} Account: {acct} {payee}*').names).toEqual(['payee', 'acct', 'payee']);
  });

  it('leaves a brace that opens no name as literal text', () => {
    expect(parseGlobCaptures('a {b c} d { e')).toEqual({ names: [], malformed: [] });
    expect(parseGlobCaptures('{a-b}').malformed).toEqual([]);
  });

  it('reports a group shaped like a name that is not one', () => {
    expect(parseGlobCaptures('{Payee} {} {1a} {a_b} {abcdefghijklmnopqrstu}').malformed).toEqual([
      'Payee',
      '',
      'a_b',
      'abcdefghijklmnopqrstu',
    ]);
  });

  it('reads {payeeText} as malformed: a pattern has no built-ins', () => {
    expect(parseGlobCaptures('{payeeText}').malformed).toEqual(['payeeText']);
  });
});

describe('parseTemplateRefs', () => {
  it('knows the captures and payeeText, and reports what only looks like one', () => {
    expect(parseTemplateRefs('{payee} - {payeeText} {description} {Bad} {}')).toEqual({
      names: ['payee', 'payeeText', 'description'],
      malformed: ['Bad', ''],
    });
  });
});

describe('checkPattern', () => {
  it('accepts a pattern without captures and one with a few', () => {
    expect(checkPattern('*coffee*', [])).toEqual({ codes: [], names: [] });
    expect(checkPattern('{a} {b}', [])).toEqual({ codes: [], names: ['a', 'b'] });
  });

  it('refuses {Word}, {} and a reserved name as an invalid capture', () => {
    expect(checkPattern('{Word}', []).codes).toEqual(['INVALID_CAPTURE']);
    expect(checkPattern('{}', []).codes).toEqual(['INVALID_CAPTURE']);
    expect(checkPattern('{description}', []).codes).toEqual(['INVALID_CAPTURE']);
  });

  it('refuses a sixth capture in one pattern, and accepts five', () => {
    expect(checkPattern('{a}{b}{c}{d}{e}', []).codes).toEqual([]);
    expect(checkPattern('{a}{b}{c}{d}{e}{f}', []).codes).toEqual(['TOO_MANY_CAPTURES']);
  });

  it('refuses a name used twice, in the pattern or across the rule', () => {
    expect(checkPattern('{a} {a}', []).codes).toEqual(['DUPLICATE_CAPTURE']);
    expect(checkPattern('{a}', ['a']).codes).toEqual(['DUPLICATE_CAPTURE']);
    expect(checkPattern('{a}', ['b']).codes).toEqual([]);
  });

  it('names a name of 20 characters and refuses one of 21', () => {
    expect(checkPattern(`{a${'b'.repeat(19)}}`, []).codes).toEqual([]);
    expect(checkPattern(`{a${'b'.repeat(20)}}`, []).codes).toEqual(['INVALID_CAPTURE']);
  });
});

describe('scanCaptures', () => {
  const matches = (value: string, field: EditorLeaf['field'] = 'description'): EditorLeaf => ({
    ...createLeaf(field),
    op: 'matches',
    value,
  });

  it('collects the names of every matches leaf in the server order, nested groups included', () => {
    const a = matches('*{a}*');
    const b = matches('{b}{c}', 'memo');
    const root = createGroup('all', [a, createGroup('any', [b])]);
    expect(scanCaptures(root)).toEqual({ names: ['a', 'b', 'c'], issues: [] });
  });

  it('reports the leaf, at the path the server uses, for each refusal', () => {
    const first = matches('{a}');
    const second = matches('{a}', 'memo');
    const root = createGroup('all', [first, createGroup('any', [second])]);
    expect(scanCaptures(root).issues).toEqual([
      { uid: second.uid, path: 'condition.all[1].any[0]', codes: ['DUPLICATE_CAPTURE'] },
    ]);
  });

  it('ignores a pattern of another operator, an unset one and one over the text limit', () => {
    const contains: EditorLeaf = { ...createLeaf('description'), op: 'contains', value: '{a}{a}' };
    const unset: EditorLeaf = { ...createLeaf('description'), op: 'matches', value: undefined };
    const long = matches(`{a}${'x'.repeat(500)}`);
    expect(scanCaptures(createGroup('all', [contains, unset, long]))).toEqual({ names: [], issues: [] });
  });
});

describe('templates', () => {
  it('accepts the built-ins and the captures of the rule', () => {
    expect(checkTemplate('{payee}: {payeeText} {description}', ['payee'])).toEqual({ malformed: [], unknown: [] });
  });

  it('names each unknown placeholder once, as it is written', () => {
    expect(checkTemplate('{x} {y} {x} {Bad}', ['a'])).toEqual({ malformed: ['{Bad}'], unknown: ['{x}', '{y}'] });
  });

  it('offers the built-ins first, then the captures, without repeating a built-in', () => {
    expect(availablePlaceholders(['payee', 'description', 'ref'])).toEqual(['payeeText', 'description', 'payee', 'ref']);
  });
});
