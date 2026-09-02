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
 * - If only ONE kind of separator appears, it is grouping only when its digit
 *   runs form valid thousands groups (1-3 digits before the first separator,
 *   exactly 3 after each). Otherwise it is the decimal point. This is what makes
 *   the DOT-GROUP locales (de/es/it/nl/pt-BR/tr) safe: "1.234" reads as 1234
 *   (valid grouping) but "1200.99" and "5.5" read as decimals -- a trailing run
 *   that is not exactly 3 digits cannot be a thousands group, so it was never a
 *   grouping separator, and stripping it (the old `sep === group` rule) inflated
 *   the value ~100x. "1200,99"/"5,5" in a comma-decimal locale and a stray
 *   "1200.99" in a space-group locale all read correctly.
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
      const parts = cleaned.split(sep);
      if (sep === separators.decimal) {
        // The locale's DECIMAL separator: a single one ("1.5", "1.234" in en) is
        // the decimal point. Repeated occurrences are the decimal point only if
        // they cannot be valid grouping -- "1.000.000" pasted by a European reads
        // as 1000000, but "1.2.3" is a typo whose last separator is the decimal.
        normalized =
          parts.length === 2
            ? parts.join('.')
            : looksLikeGrouping(parts)
              ? parts.join('')
              : joinLastAsDecimal(parts);
      } else {
        // The locale's GROUPING separator (or a stray non-locale symbol): it is
        // grouping only when the digit runs are valid 3-digit groups ("1,234",
        // "1.234.567", "1.234" in de). A trailing run that is not exactly 3
        // digits cannot be a group, so "1200.99"/"5.5" in a dot-group locale and
        // a stray "1200.99" in a space-group locale read as decimals.
        normalized = looksLikeGrouping(parts)
          ? parts.join('')
          : parts.length === 2
            ? parts.join('.')
            : joinLastAsDecimal(parts);
      }
    }
  }

  const parsed = parseFloat(normalized);
  if (!isFinite(parsed)) return undefined;
  return negative && parsed > 0 ? -parsed : parsed;
}

/**
 * Whether the digit runs on either side of a single kind of separator form
 * valid thousands grouping: two or more groups, 1-3 digits before the first
 * separator, and exactly 3 digits in every group after it. A trailing run that
 * is not exactly 3 digits (e.g. the ".99" of "1200.99" or the ".5" of "5.5")
 * cannot be a thousands group, so the separator is a decimal point instead.
 */
function looksLikeGrouping(parts: string[]): boolean {
  return (
    parts.length > 1 &&
    parts[0].length >= 1 &&
    parts[0].length <= 3 &&
    parts.slice(1).every((p) => p.length === 3)
  );
}

/**
 * Join a `.`/`,`-split number treating the LAST separator as the decimal point
 * and dropping the earlier ones -- the reading of an ambiguous, non-grouping
 * multi-separator string like "1.2.3" (-> "12.3").
 */
function joinLastAsDecimal(parts: string[]): string {
  const last = parts[parts.length - 1];
  return parts.slice(0, -1).join('') + '.' + last;
}

/**
 * Filter a raw input string to the characters a number field should keep WHILE
 * TYPING, preserving order so the caret does not jump. Digits, both candidate
 * separators (so a paste in either convention survives to `parseLocaleNumber`),
 * a leading `-` when negatives are allowed, and -- when `allowOperators` --
 * the calculator operators. Grouping whitespace and everything else is dropped.
 *
 * Both `.` and `,` are kept: neither is stripped here, because in a DOT-GROUP
 * locale (de/es/it/nl/pt-BR/tr) the "grouping" separator is also a decimal
 * candidate, and eagerly dropping it destroyed a typed/pasted "1200.99" (->
 * "120099") before `parseLocaleNumber` could disambiguate it. Disambiguation is
 * `parseLocaleNumber`'s job (by digit count); this filter only removes what can
 * never be part of a number. Grouping whitespace never survives the keep-list.
 */
export function filterNumberTyping(
  raw: string,
  options: {
    allowNegative?: boolean;
    allowOperators?: boolean;
    /**
     * Accepted for call-site symmetry with the other helpers; NOT used to strip.
     * A `.`/`,` group separator is also a decimal candidate, so stripping it here
     * (before `parseLocaleNumber` runs) was the ~100x dot-group bug. Whitespace
     * groups are already dropped by the keep-list.
     */
    groupSeparator?: string;
  } = {},
): string {
  const { allowNegative = false, allowOperators = false } = options;
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
  return out;
}

/**
 * Format an amount for read-only DISPLAY (grouped, fixed decimals) in the user's
 * number locale, WITHOUT a currency symbol -- "1,234.56" in en-US, "1 234,56" in
 * pl. The read-only counterpart to what `CurrencyInput` shows; use it wherever a
 * plain amount is printed and the currency symbol is composed separately,
 * instead of a bare `formatAmountWithCommas` (which is hardcoded en-US).
 *
 * The en-US display seam (`formatAmountWithCommas`, which the tests mock) is used
 * only for a genuinely en-like locale with default separators; other locales --
 * including ones that happen to share `.`/`,` but group differently, e.g. Indian
 * `hi`/`en-IN` (lakh grouping "12,34,567") -- take the `Intl` branch so the
 * localization this helper promises actually applies to them. The `Intl` call is
 * guarded like `getNumberSeparators`: an invalid locale falls back to the
 * en-US formatter rather than throwing during render. Callers pass their (already
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
  // Delegate to the en-US display seam only for the plain en locales that group
  // "1,234,567". en-IN, hi and other locales sharing `.`/`,` group differently
  // (lakh), so they must take the Intl branch to be localized correctly.
  const l = (locale ?? '').toLowerCase();
  const enUsLike = l === '' || l === 'en' || l === 'en-us' || l === 'en-ca' || l === 'en-gb';
  if (enUsLike && separators.decimal === '.' && separators.group === ',') {
    return formatAmountWithCommas(value, decimals);
  }
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(roundToDecimals(value, decimals));
  } catch {
    // Invalid locale string: keep the en-US formatter rather than throwing.
    return formatAmountWithCommas(value, decimals);
  }
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
