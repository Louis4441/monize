import { describe, it, expect } from 'vitest';

/**
 * A phone number is STORED as E.164 and SHOWN grouped, and exactly one function
 * turns one into the other: `formatPhoneForDisplay` (`@/lib/phone-number`).
 *
 * Rendering `payee.phone` straight into the markup puts `+442079460958` in
 * front of a reader, which is the number and is not how anyone reads one -- and
 * because the column used to hold whatever was typed, a raw render looked
 * perfectly fine for every row written before normalization and wrong for every
 * row written after. `frontend/CLAUDE.md` states the rule; per the repo's
 * "prefer the rule the machine can check", this scan is what keeps it, modelled
 * on `number-parse.guard.test.ts`.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * Blank comment lines, preserving line count so a reported line number still
 * points at the offending line. The paragraphs above and in `CLAUDE.md` have to
 * be able to NAME the pattern being banned without tripping the scan -- the
 * alternative is a weaker explanation, which is the opposite of the point.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
        ? ''
        : line;
    })
    .join('\n');
}

/**
 * A phone value rendered into JSX: `{payee.phone}`, `{row.phone ?? ...}`,
 * `{x.phone || ...}`. By shape rather than by variable name, because the alias
 * is how this kind of thing gets through -- `preview.phone` and `payee.phone`
 * are the same mistake.
 */
const RAW_JSX_RENDER = /\{\s*\w+(?:\?)?\.phone\s*(?:\}|\?\?|\|\|)/;

/**
 * The files allowed to handle a raw phone value, each with the reason.
 *
 * `phone-number.ts` is where the formatting lives. `contact-links.ts` builds the
 * `tel:` href, which needs the stored digits and the stored `;ext=` suffix, not
 * the grouped display form.
 */
const ALLOWED = new Set(['/src/lib/phone-number.ts', '/src/lib/contact-links.ts']);

function productionSources(): [string, string][] {
  return Object.entries(sources)
    .filter(([path]) => !path.includes('.test.'))
    .filter(([path]) => !ALLOWED.has(path))
    .map(([path, source]) => [path, stripComments(source)]);
}

describe('a phone number is displayed through one formatter', () => {
  it('loads the sources, so the scan is not vacuous', () => {
    // A broken glob would make the rule below pass over an empty list, and the
    // guard would silently stop guarding.
    expect(productionSources().length).toBeGreaterThan(100);
  });

  it('is never rendered raw', () => {
    const offenders = productionSources()
      .filter(([, source]) => RAW_JSX_RENDER.test(source))
      .map(([path]) => path);
    // Wrap the value in `formatPhoneForDisplay` from `@/lib/phone-number`.
    expect(offenders).toEqual([]);
  });

  it('is formatted at every surface that shows one', () => {
    // The other half of the rule: the scan above cannot see a value passed
    // through a variable, so the surfaces known to display a phone are also
    // required to reference the formatter. A new one added without it fails
    // the scan above; one that renames its variable fails this.
    const displaySurfaces = [
      '/src/components/payees/detail/PayeeKeyInfoCard.tsx',
      '/src/components/payees/ContactLookupDialog.tsx',
      '/src/components/ai/TransactionConfirmationCard.tsx',
      '/src/components/ai/BulkConfirmationCard.tsx',
      '/src/components/payees/PayeeForm.tsx',
    ];
    const missing = displaySurfaces.filter(
      (path) => !sources[path]?.includes('formatPhoneForDisplay'),
    );
    expect(missing).toEqual([]);
  });

  it('catches a raw render, so the rule cannot pass by matching nothing', () => {
    // The counter-test.
    for (const offending of [
      '<span>{payee.phone}</span>',
      '<span>{preview.phone}</span>',
      "value: row.phone || '-',".replace('value:', '{'),
      '{payee?.phone}',
      '{selected.phone ?? none}',
    ]) {
      expect(RAW_JSX_RENDER.test(offending)).toBe(true);
    }
  });

  it('does not read a formatted render as a raw one', () => {
    for (const allowed of [
      '<span>{formatPhoneForDisplay(payee.phone)}</span>',
      '{phoneDisplay}',
      'const link = telHref(payee.phone);',
    ]) {
      expect(RAW_JSX_RENDER.test(allowed)).toBe(false);
    }
  });

  it('blanks comments without moving the lines after them', () => {
    const source = ['// {payee.phone}', 'const a = 1;', ' * {row.phone}'].join('\n');
    const blanked = stripComments(source);
    expect(RAW_JSX_RENDER.test(blanked)).toBe(false);
    expect(blanked.split('\n')).toHaveLength(3);
    expect(blanked.split('\n')[1]).toBe('const a = 1;');
    // ...and a real render on the line after a comment still matches.
    expect(RAW_JSX_RENDER.test(stripComments('// note\n<b>{payee.phone}</b>'))).toBe(
      true,
    );
  });
});
