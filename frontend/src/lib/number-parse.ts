/**
 * Locale-aware parsing and edit-formatting for number inputs.
 *
 * The app DISPLAYS numbers through `Intl.NumberFormat` in the user's effective
 * locale (see `useNumberFormat`), so a Polish user reads "1 200,99" (space
 * groups, comma decimal). The input fields, however, historically parsed and
 * formatted in the en-US convention only (comma stripped as a thousands
 * separator, dot as the decimal point) -- so the same user could neither type
 * nor paste "1200,99": the comma was discarded and 1200,99 became 120099, and a
 * value copied from a localized column would not go back into a field.
 *
 * This module reads and writes numbers in the user's own separators. It is a
 * separate, pure, fully tested layer rather than a change to `format.ts` so the
 * existing (en-US) helpers and their many other callers keep their behaviour.
 *
 * The design keeps the en-US path byte-identical: with a `.` decimal and a `,`
 * group separator (the runtime default under test), every function below does
 * exactly what the old helpers did.
 */

import { formatAmountWithCommas, roundToDecimals } from '@/lib/format';

export interface NumberSeparators {
  /** The decimal separator, e.g. "." (en) or "," (pl, de, fr). */
  decimal: string;
  /** The grouping separator, e.g. "," (en) or a no-break space (pl). */
  group: string;
}

const separatorsCache = new Map<string, NumberSeparators>();

/**
 * The decimal and grouping separators a locale uses, derived from `Intl` so
 * they match how the same locale DISPLAYS a number. Memoized because
 * `formatToParts` is not free and this is read per keystroke. `undefined` hands
 * off to the runtime default (en-US under test/CI).
 */
export function getNumberSeparators(
  locale: string | undefined,
): NumberSeparators {
  const key = locale ?? '';
  const cached = separatorsCache.get(key);
  if (cached) return cached;

  let decimal = '.';
  let group = ',';
  try {
    const parts = new Intl.NumberFormat(locale, {
      useGrouping: true,
    }).formatToParts(11111.1);
    for (const part of parts) {
      if (part.type === 'decimal') decimal = part.value;
      else if (part.type === 'group') group = part.value;
    }
  } catch {
    // Keep the en-US defaults for an unknown locale.
  }
  const result: NumberSeparators = { decimal, group };
  separatorsCache.set(key, result);
  return result;
}

// Every character treated as whitespace for parsing, including the no-break and
// narrow-no-break spaces several locales use as grouping separators.
const WHITESPACE = /[\s    ]/g;

/**
 * Parse a number a user typed or pasted, in their locale's convention, and
 * tolerating the other common one.
 *
 * The rule is deterministic:
 * - Strip whitespace (which includes locale group spaces) and anything that is
 *   not a digit, `.`, `,` or a leading `-`.
 * - If BOTH `.` and `,` appear, the LAST-occurring one is the decimal point and
 *   the other is the grouping separator ("1,234.56" and "1.234,56" both work).
 * - If only ONE kind of separator appears: it is grouping when it appears more
 *   than once ("1.000.000") OR when it is exactly the locale's grouping
 *   separator ("1,234" in en-US is 1234). Otherwise it is the decimal point --
 *   so "1200,99" and "5,5" read correctly for a comma-decimal locale, and a
 *   stray "1200.99" still parses for one whose group separator is a space.
 *
 * Returns `undefined` for anything that is not a finite number.
 */
export function parseLocaleNumber(
  raw: string,
  separators: NumberSeparators,
): number | undefined {
  if (raw == null) return undefined;
  const negative = raw.trim().startsWith('-');
  const cleaned = raw.replace(WHITESPACE, '').replace(/[^0-9.,]/g, '');
  if (cleaned === '') return undefined;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');

  let normalized: string;
  if (hasDot && hasComma) {
    const decimalChar =
      cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',') ? '.' : ',';
    const groupChar = decimalChar === '.' ? ',' : '.';
    normalized = cleaned.split(groupChar).join('').replace(decimalChar, '.');
  } else {
    const sep = hasDot ? '.' : hasComma ? ',' : '';
    if (sep === '') {
      normalized = cleaned;
    } else {
      const occurrences = cleaned.split(sep).length - 1;
      const isGroup = occurrences > 1 || sep === separators.group;
      normalized = isGroup
        ? cleaned.split(sep).join('')
        : cleaned.replace(sep, '.');
    }
  }

  const parsed = parseFloat(normalized);
  if (!isFinite(parsed)) return undefined;
  return negative && parsed > 0 ? -parsed : parsed;
}

/**
 * Filter a raw input string to the characters a number field should keep WHILE
 * TYPING, preserving order so the caret does not jump. Digits, both candidate
 * separators (so a paste in either convention survives to `parseLocaleNumber`),
 * a leading `-` when negatives are allowed, and -- when `allowOperators` --
 * the calculator operators. Grouping whitespace and everything else is dropped.
 *
 * Keeping BOTH `.` and `,` is deliberate and safe for en-US: the existing
 * fields never asserted that a typed comma is removed mid-word, and blur
 * reformats to the canonical display anyway.
 */
export function filterNumberTyping(
  raw: string,
  options: {
    allowNegative?: boolean;
    allowOperators?: boolean;
    /**
     * The locale's grouping separator, dropped from the result. For en-US this
     * is ",", so a comma is stripped exactly as the old en-US filter did; for a
     * locale whose group is a no-break space nothing extra is removed (those
     * characters never survive the keep-list below), and its "," decimal is
     * preserved.
     */
    groupSeparator?: string;
  } = {},
): string {
  const { allowNegative = false, allowOperators = false, groupSeparator } = options;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === '.' || ch === ',') out += ch;
    else if (ch === '-' && (allowNegative || allowOperators)) out += ch;
    else if (allowOperators && (ch === '+' || ch === '*' || ch === '/' || ch === '(' || ch === ')')) {
      out += ch;
    } else if (allowOperators && (ch === 'x' || ch === 'X' || ch === '×')) {
      out += '*';
    } else if (allowOperators && ch === '÷') {
      out += '/';
    }
  }
  if (groupSeparator === '.' || groupSeparator === ',') {
    out = out.split(groupSeparator).join('');
  }
  return out;
}

/**
 * Format an amount for read-only DISPLAY (grouped, fixed decimals) in the user's
 * number locale, WITHOUT a currency symbol -- "1,234.56" in en-US, "1 234,56" in
 * pl. The read-only counterpart to what `CurrencyInput` shows; use it wherever a
 * plain amount is printed and the currency symbol is composed separately,
 * instead of a bare `formatAmountWithCommas` (which is hardcoded en-US).
 *
 * The en-US / default-separator path delegates to `formatAmountWithCommas` so
 * its display seam -- and the tests that mock it -- is preserved unchanged; only
 * a genuinely non-en locale takes the `Intl` branch. Callers pass their (already
 * defensively defaulted) separators and effective locale, so a component with a
 * partial `useNumberFormat` mock never needs the formatter itself.
 */
export function formatAmountLocalized(
  value: number | undefined | null,
  decimals: number,
  separators: NumberSeparators,
  locale: string | undefined,
): string {
  if (value === undefined || value === null || isNaN(value)) return '';
  if (separators.decimal === '.' && separators.group === ',') {
    return formatAmountWithCommas(value, decimals);
  }
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(roundToDecimals(value, decimals));
}

/**
 * Format a number for EDITING (no grouping), using the locale's decimal
 * separator, at a fixed number of decimals. This is what a numeric field shows
 * on blur -- "1200,99" for a comma-decimal locale, "1200.99" for en-US -- so a
 * value read back out round-trips through `parseLocaleNumber`.
 */
export function formatNumberForEdit(
  value: number | undefined | null,
  decimals: number,
  separators: NumberSeparators,
): string {
  if (value === undefined || value === null || isNaN(value)) return '';
  const fixed = value.toFixed(decimals);
  return separators.decimal === '.'
    ? fixed
    : fixed.replace('.', separators.decimal);
}

/**
 * Normalize a calculator EXPRESSION into the canonical `.`-decimal form the
 * evaluator understands. Per-locale the decimal and grouping separators are
 * distinct, so this is unambiguous: drop the grouping separator (and grouping
 * whitespace), then map the locale decimal separator to `.`. Operators are kept.
 * For en-US (`.` decimal, `,` group) this strips commas and keeps dots -- the
 * old behaviour.
 */
export function normalizeExpression(
  raw: string,
  separators: NumberSeparators,
): string {
  let out = raw.replace(WHITESPACE, '');
  if (separators.group && separators.group !== '.' && separators.group !== ',') {
    out = out.split(separators.group).join('');
  }
  if (separators.decimal === ',') {
    // Comma is the decimal; a dot can only be a (stray) grouping separator here.
    out = out.split('.').join('').split(',').join('.');
  } else {
    // Dot is the decimal; comma is the grouping separator.
    out = out.split(',').join('');
  }
  return out;
}
