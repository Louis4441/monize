import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en/rules.json';
import { CEL_ERROR_KEYS, EntityIndex, complete } from '@/lib/rule-cel';
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

  it('has a sentence for every expression error kind, and a label for every suggestion hint', () => {
    const expression = editor.expression as Record<string, Record<string, unknown>>;
    expect(Object.keys(expression.errors).sort()).toEqual([...CEL_ERROR_KEYS].sort());
    for (const key of CEL_ERROR_KEYS) expect(typeof expression.errors[key], key).toBe('string');

    // Every hint autocomplete can attach names a label the catalog has.
    const index = new EntityIndex();
    const hints = new Set<string>();
    for (const field of RULE_FIELDS) {
      for (const text of [`transaction.${field} `, `transaction.${field}.`, `transaction.${field} == `, 'transaction.']) {
        for (const item of complete(text, text.length, index)?.items ?? []) if (item.hint) hints.add(item.hint);
      }
    }
    expect(hints.size).toBeGreaterThan(20);
    for (const hint of hints) {
      const [group, key] = hint.split('.');
      expect(typeof editor[group]?.[key], hint).toBe('string');
    }
  });
});
