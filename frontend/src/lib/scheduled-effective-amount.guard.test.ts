import { describe, it, expect } from 'vitest';

/**
 * A scheduled occurrence's money comes from the effective-amount contract, never
 * from the persisted scalar.
 *
 * Issue #1247 was one line copied into seven places:
 *
 *   const amount = st.nextOverride?.amount ?? st.amount;
 *
 * Each site read as obviously right, and every one of them disagreed with the
 * cash-flow forecast (and with the posting) by however much the exchange rate had
 * moved since the schedule was written. Prose in a `CLAUDE.md` would be read,
 * agreed with, and copied again, so the rule is a scan: any new occurrence of the
 * fingerprint fails here, and the fix is `nextOccurrenceEffectiveAmount(st)` from
 * `lib/scheduled-effective-amount.ts`.
 *
 * The scan covers `src/` rather than a single component, because the mistake is
 * mechanical and its next appearance will be in a file nobody thought to test.
 * Modelled on `src/test/ui-conventions.test.ts`, which walks the tree the same way.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** A line that is only a comment, wherever it sits in a block. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

/** Source files only: tests legitimately contain the shape they assert on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(
    ([path]) => !/\.test\.tsx?$/.test(path),
  );
}

/**
 * The fallback shape, in the spacings people actually write: an `?? …amount`
 * whose left side reads an override's amount -- `nextOverride?.amount ?? x.amount`,
 * `override.amount ?? amount`, and so on.
 */
const PERSISTED_FALLBACK =
  /\b(?:next)?[Oo]verride\??\.amount\s*\?\?\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\b/;

/**
 * Files allowed to compose an override amount with a base amount.
 *
 * `PostTransactionDialog` seeds the editable field of the POST form, which is the
 * write path: the number the user confirms is the number that gets stored, and a
 * plain schedule's `amount` is not re-priced by any exchange rate. Issue #1247
 * scopes itself to read models and says the posting path is unaffected.
 */
const ALLOWED = new Set([
  '/src/components/scheduled-transactions/PostTransactionDialog.tsx',
]);

/** The surfaces issue #1247 lists as affected, plus the shared helper's own users. */
const MIGRATED_SURFACES = [
  '/src/lib/scheduled-utils.ts',
  '/src/components/dashboard/UpcomingBills.tsx',
  '/src/components/budgets/BudgetUpcomingBills.tsx',
  '/src/components/reports/UpcomingBillsReport.tsx',
  '/src/components/accounts/shared/RecurringChargesPanel.tsx',
  '/src/components/scheduled-transactions/ScheduledTransactionList.tsx',
  '/src/app/bills/page.tsx',
];

describe('scheduled effective amount guard', () => {
  it('has files to scan', () => {
    // A scan whose subject list is empty passes for the wrong reason.
    expect(productionSources().length).toBeGreaterThan(200);
  });

  it('nothing falls back from an override amount to the persisted amount', () => {
    const offenders: string[] = [];

    for (const [path, contents] of productionSources()) {
      if (ALLOWED.has(path)) continue;
      contents.split('\n').forEach((line, index) => {
        // Comments quote the banned shape on purpose -- that is how the rule is
        // explained where it was broken. Only code counts.
        if (isComment(line)) return;
        if (PERSISTED_FALLBACK.test(line)) {
          offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('bans the exact shape issue #1247 fixed, and nothing correct', () => {
    // Pinning the regex against the real strings, so a later tidy-up of it cannot
    // silently stop matching the shape it exists for.
    expect(
      PERSISTED_FALLBACK.test('const a = st.nextOverride?.amount ?? st.amount;'),
    ).toBe(true);
    expect(
      PERSISTED_FALLBACK.test('return override.amount ?? scheduled.amount;'),
    ).toBe(true);
    expect(
      PERSISTED_FALLBACK.test('return nextOverride?.amount ?? amount;'),
    ).toBe(true);
    expect(
      PERSISTED_FALLBACK.test(
        'const { amount } = nextOccurrenceEffectiveAmount(st);',
      ),
    ).toBe(false);
    // A comment quoting the shape is documentation, not a violation -- but the
    // same text in code still is.
    expect(isComment('  // never nextOverride?.amount ?? amount')).toBe(true);
    expect(isComment('  const a = nextOverride?.amount ?? amount;')).toBe(false);
  });

  it('every migrated surface still reads the shared resolver', () => {
    // A surface that stops importing it has either been deleted (update this
    // list, deliberately) or has gone back to deriving the amount itself.
    const paths = new Map(productionSources());
    const problems = MIGRATED_SURFACES.flatMap((path) => {
      const contents = paths.get(path);
      if (contents === undefined) return [`${path}: no such source file`];
      return contents.includes('scheduled-effective-amount')
        ? []
        : [`${path}: does not import lib/scheduled-effective-amount`];
    });

    expect(problems).toEqual([]);
  });

  it('the allowed exception still exists, so the exemption is not stale', () => {
    const paths = new Map(productionSources());
    for (const path of ALLOWED) {
      expect(paths.has(path)).toBe(true);
    }
  });
});
