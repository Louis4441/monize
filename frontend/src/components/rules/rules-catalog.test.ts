import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en/rules.json';
import {
  RULE_ACTION_TYPES,
  RULE_FIELDS,
  RULE_OPERATORS,
  RULE_TRANSACTION_TYPES,
  RULE_VALIDATION_CODES,
} from '@/lib/rule-fields';

/**
 * The editor builds keys from the tables (`fields.${field}`, `operators.${op}`,
 * and so on), so a value added to a table without a sentence would render as a
 * raw key. The harness turns that into a failure only where a test happens to
 * draw it; this pins the whole set.
 */
const editor = en.editor as unknown as Record<string, Record<string, unknown>>;

describe('the rule editor catalog', () => {
  it.each([
    ['fields', RULE_FIELDS],
    ['operators', RULE_OPERATORS],
    ['types', RULE_TRANSACTION_TYPES],
    ['actionTypes', RULE_ACTION_TYPES],
  ])('has a label for every entry of %s', (group, keys) => {
    for (const key of keys) expect(typeof editor[group][key], `${group}.${key}`).toBe('string');
  });

  it('has a sentence for every validation code, for the reference check, the local name check and an unknown code', () => {
    const codes = editor.errors.codes as Record<string, unknown>;
    for (const code of [...RULE_VALIDATION_CODES, 'REFERENCE_NOT_FOUND', 'NAME_REQUIRED', 'UNKNOWN']) {
      expect(typeof codes[code], code).toBe('string');
    }
  });

  it('has no label without a table entry to draw it', () => {
    expect(Object.keys(editor.fields).sort()).toEqual([...RULE_FIELDS].sort());
    expect(Object.keys(editor.operators).sort()).toEqual([...RULE_OPERATORS].sort());
    expect(Object.keys(editor.actionTypes).sort()).toEqual([...RULE_ACTION_TYPES].sort());
    expect(Object.keys(editor.errors.codes as object).sort()).toEqual(
      [...RULE_VALIDATION_CODES, 'REFERENCE_NOT_FOUND', 'NAME_REQUIRED', 'UNKNOWN'].sort(),
    );
  });
});
