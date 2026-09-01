import { describe, it, expect } from 'vitest';
import {
  filterNumberTyping,
  formatNumberForEdit,
  getNumberSeparators,
  normalizeExpression,
  parseLocaleNumber,
  type NumberSeparators,
} from './number-parse';

const EN: NumberSeparators = { decimal: '.', group: ',' };
// Polish groups with a no-break space; comma is the decimal.
const PL: NumberSeparators = { decimal: ',', group: ' ' };
// German groups with a dot; comma is the decimal.
const DE: NumberSeparators = { decimal: ',', group: '.' };

describe('getNumberSeparators', () => {
  it('reads the separators a locale displays with', () => {
    expect(getNumberSeparators('en-US')).toEqual({ decimal: '.', group: ',' });
    expect(getNumberSeparators('de-DE')).toEqual({ decimal: ',', group: '.' });
  });

  it('falls back to en-US separators for an unknown locale', () => {
    expect(getNumberSeparators('not-a-locale')).toEqual({ decimal: '.', group: ',' });
  });
});

describe('parseLocaleNumber', () => {
  it('parses en-US numbers (dot decimal, comma groups)', () => {
    expect(parseLocaleNumber('1,234.56', EN)).toBe(1234.56);
    expect(parseLocaleNumber('1234.56', EN)).toBe(1234.56);
    expect(parseLocaleNumber('1,234', EN)).toBe(1234); // single group comma
    expect(parseLocaleNumber('1,000,000', EN)).toBe(1000000);
    expect(parseLocaleNumber('5', EN)).toBe(5);
  });

  it('parses comma-decimal numbers a Polish user types or pastes', () => {
    expect(parseLocaleNumber('1200,99', PL)).toBe(1200.99); // the reported case
    expect(parseLocaleNumber('5,5', PL)).toBe(5.5);
    expect(parseLocaleNumber('1 234,56', PL)).toBe(1234.56); // grouped
    expect(parseLocaleNumber('1 234,56', PL)).toBe(1234.56); // plain space groups
  });

  it('still accepts a dot decimal for a comma-decimal locale', () => {
    // Robustness: a dot is not the Polish group separator, so it reads as decimal.
    expect(parseLocaleNumber('1200.99', PL)).toBe(1200.99);
  });

  it('uses the LAST separator as the decimal when both appear', () => {
    expect(parseLocaleNumber('1.234,56', DE)).toBe(1234.56);
    expect(parseLocaleNumber('1,234.56', EN)).toBe(1234.56);
  });

  it('handles a leading minus and rejects non-numbers', () => {
    expect(parseLocaleNumber('-5,5', PL)).toBe(-5.5);
    expect(parseLocaleNumber('', EN)).toBeUndefined();
    expect(parseLocaleNumber('-', EN)).toBeUndefined();
    expect(parseLocaleNumber('abc', EN)).toBeUndefined();
  });
});

describe('filterNumberTyping', () => {
  it('drops the en-US grouping comma, keeps the dot (unchanged en-US behaviour)', () => {
    expect(filterNumberTyping('1,234.56', { groupSeparator: ',' })).toBe('1234.56');
    expect(filterNumberTyping('abc12.3', { groupSeparator: ',' })).toBe('12.3');
  });

  it('keeps a comma decimal and drops a no-break-space group', () => {
    expect(filterNumberTyping('1 234,56', { groupSeparator: ' ' })).toBe('1234,56');
    expect(filterNumberTyping('5,5', { groupSeparator: ' ' })).toBe('5,5');
  });

  it('keeps a leading minus only when allowed', () => {
    expect(filterNumberTyping('-5,5', { allowNegative: true, groupSeparator: ' ' })).toBe('-5,5');
    expect(filterNumberTyping('-5,5', { groupSeparator: ' ' })).toBe('5,5');
  });

  it('keeps and normalizes operators when allowed', () => {
    expect(filterNumberTyping('100*1,13', { allowOperators: true, groupSeparator: ' ' })).toBe('100*1,13');
    expect(filterNumberTyping('100×2', { allowOperators: true })).toBe('100*2');
  });
});

describe('formatNumberForEdit', () => {
  it('formats with the locale decimal, no grouping', () => {
    expect(formatNumberForEdit(1200.99, 2, EN)).toBe('1200.99');
    expect(formatNumberForEdit(1200.99, 2, PL)).toBe('1200,99');
    expect(formatNumberForEdit(0, 2, PL)).toBe('0,00');
    expect(formatNumberForEdit(undefined, 2, PL)).toBe('');
  });
});

describe('normalizeExpression', () => {
  it('maps a comma-decimal expression to the dot-decimal evaluator form', () => {
    expect(normalizeExpression('100*1,13', PL)).toBe('100*1.13');
    expect(normalizeExpression('1.234,56+1', DE)).toBe('1234.56+1');
  });

  it('strips en-US grouping commas and keeps dots', () => {
    expect(normalizeExpression('1,234*2', EN)).toBe('1234*2');
    expect(normalizeExpression('100*1.13', EN)).toBe('100*1.13');
  });
});
