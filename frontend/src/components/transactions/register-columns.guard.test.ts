import { describe, it, expect } from 'vitest';
import {
  REGISTER_COLUMN_ORDER,
  REGISTER_COLUMN_PRIORITY,
  PRIORITY_MIN_WIDTH_PX,
  REGISTER_TABLE_CONTAINER,
  REGISTER_DESCRIPTION_CELL_FLEX,
  REGISTER_PAYEE_NAME_CAP,
  registerColumnClass,
  type RegisterColumnId,
} from './register-columns';

/**
 * Guard for the register's column contract (`register-columns.ts`).
 *
 * The defect this pins: each `<th>`/`<td>` used to carry its own hand-written
 * visibility class, and they drifted until the columns appeared in no
 * explicable order -- Status (ranked high) surfaced last of all at 1400px,
 * Attachments (ranked low) before Tags (ranked medium), and the Account
 * column rendered on single-account pages. The contract is only worth having
 * if a new cell cannot quietly opt back out of it, so this scans the two
 * register files for any visibility class that does not come from the module.
 */
const REGISTER_SOURCES = import.meta.glob(
  '/src/components/transactions/{TransactionList,TransactionRow}.tsx',
  { query: '?raw', eager: true, import: 'default' },
) as Record<string, string>;

/**
 * Blank out comments, keeping line numbering, so the scan reads CODE. The
 * prose documenting this rule has to name the banned pattern; a scan that
 * prose can trip is also a scan that prose can satisfy (the stripper is
 * tested in both directions below, per `loan-history.guard.test.ts`).
 *
 * Deliberately crude -- a `//` inside a string literal would be blanked too.
 * That direction is safe here: it can only hide code from the scan, and the
 * negative control below fails if the scan stops seeing a real class.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
}

/**
 * A hand-written responsive column-visibility class -- viewport variants and
 * container-query variants alike. The viewport forms are doubly banned: they
 * bypass the module AND they measure the wrong thing (the register sits
 * inside page padding, so viewport-keyed columns appeared before the table
 * could hold them and scrolled Status out from behind the sticky Actions).
 */
const HAND_WRITTEN_VISIBILITY =
  /hidden\s+@?(?:sm|md|lg|xl|2xl|min-\[\d+px\]):table-cell/;

describe('the register column contract', () => {
  it('resolves both register sources (an empty match set proves nothing)', () => {
    expect(Object.keys(REGISTER_SOURCES).sort()).toEqual([
      '/src/components/transactions/TransactionList.tsx',
      '/src/components/transactions/TransactionRow.tsx',
    ]);
  });

  it('strips comments but still sees code', () => {
    const stripped = withoutComments(
      [
        '// hidden lg:table-cell',
        '/* hidden lg:table-cell */',
        'const x = "hidden lg:table-cell";',
      ].join('\n'),
    );
    const lines = stripped.split('\n');
    expect(HAND_WRITTEN_VISIBILITY.test(lines[0])).toBe(false);
    expect(HAND_WRITTEN_VISIBILITY.test(lines[1])).toBe(false);
    expect(HAND_WRITTEN_VISIBILITY.test(lines[2])).toBe(true);
    // Line numbering must survive, or the offender report points at the
    // wrong line.
    expect(lines).toHaveLength(3);
  });

  it('takes every column-visibility class from register-columns.ts', () => {
    const offenders = Object.entries(REGISTER_SOURCES).flatMap(([path, content]) =>
      withoutComments(content)
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => HAND_WRITTEN_VISIBILITY.test(line))
        .map(({ line, number }) => `${path}:${number}: ${line.trim()}`),
    );

    expect(
      offenders,
      'A register cell must read its responsive visibility from ' +
        "registerColumnClass('<id>') so the column order and tiers stay one " +
        'table. Add or change a tier in register-columns.ts; never spell a ' +
        '`hidden *:table-cell` class in the register itself.',
    ).toEqual([]);
  });

  it('mentions the columns in the enforced order, header and row alike', () => {
    // The DOM order is the source order of the cells, so the order the
    // registerColumnClass('...') literals appear in each file is the order the
    // columns render in. Always-visible columns produce no class and so no
    // call; the enforced order still holds over the ones that do.
    for (const [path, content] of Object.entries(REGISTER_SOURCES)) {
      const mentioned = [
        ...withoutComments(content).matchAll(/registerColumnClass\('([a-zA-Z]+)'\)/g),
      ].map(([, id]) => id);

      expect(mentioned.length, `${path} uses the shared classes`).toBeGreaterThan(0);
      const expectedOrder = REGISTER_COLUMN_ORDER.filter((id) =>
        mentioned.includes(id),
      );
      expect(mentioned, `${path} keeps the enforced column order`).toEqual(
        expectedOrder,
      );
    }
  });

  it('assigns the priorities the spec names', () => {
    expect(REGISTER_COLUMN_PRIORITY).toEqual({
      date: 'always',
      account: 'high',
      payee: 'always',
      category: 'high',
      description: 'low',
      refNumber: 'low',
      tags: 'medium',
      attachments: 'low',
      amount: 'always',
      paidCurrency: 'always',
      paidAmount: 'always',
      feePaid: 'always',
      balance: 'always',
      status: 'high',
      actions: 'exceptPhones',
    } satisfies Record<RegisterColumnId, string>);
  });

  it('reveals the tiers in rank order as the register widens', () => {
    // "High before medium before low" is the whole point of the tiers; a
    // class-string edit that inverted two breakpoints would otherwise pass.
    expect(PRIORITY_MIN_WIDTH_PX.always).toBe(0);
    expect(PRIORITY_MIN_WIDTH_PX.high).toBeLessThan(PRIORITY_MIN_WIDTH_PX.medium);
    expect(PRIORITY_MIN_WIDTH_PX.medium).toBeLessThan(PRIORITY_MIN_WIDTH_PX.low);
    // And the classes agree with the table the assertion above trusted. They
    // must be CONTAINER-QUERY variants (`@min-[...]`): a viewport variant
    // measures the window, which overstates the register's width by the page
    // padding around it -- the defect that scrolled Status out of view.
    const widthOfClass = (cls: string): number => {
      if (cls === '') return 0;
      const match = cls.match(/^hidden @min-\[(\d+)px\]:table-cell$/);
      expect(match, `container-query visibility class: ${cls}`).toBeTruthy();
      return Number(match![1]);
    };
    for (const id of REGISTER_COLUMN_ORDER) {
      expect(widthOfClass(registerColumnClass(id)), id).toBe(
        PRIORITY_MIN_WIDTH_PX[REGISTER_COLUMN_PRIORITY[id]],
      );
    }
  });

  it('never hides an always column and always renders a class string', () => {
    for (const id of REGISTER_COLUMN_ORDER) {
      const cls = registerColumnClass(id);
      expect(typeof cls, id).toBe('string');
      if (REGISTER_COLUMN_PRIORITY[id] === 'always') {
        expect(cls, `${id} is part of what a register is`).toBe('');
      } else {
        expect(cls, `${id} is a real responsive class`).toMatch(
          HAND_WRITTEN_VISIBILITY,
        );
      }
    }
  });

  it('gives the tier classes a container to measure', () => {
    // Every `@min-[...]` variant matches against the nearest @container
    // ancestor; without one on the scroll wrapper the hideable columns
    // silently never appear at any width.
    expect(REGISTER_TABLE_CONTAINER).toBe('@container');
    const list = withoutComments(
      REGISTER_SOURCES['/src/components/transactions/TransactionList.tsx'],
    );
    expect(
      /overflow-x-auto \$\{REGISTER_TABLE_CONTAINER\}/.test(list),
      'TransactionList marks the overflow-x-auto wrapper as the register container',
    ).toBe(true);
  });

  it('makes Description the column that yields', () => {
    // `w-full` hands Description the width the content-sized columns leave;
    // `max-w-0` lets it shrink below its own content so the inner truncate
    // ellipsizes. Together they are what keeps a low-tier column's arrival
    // from overflowing the table and scrolling Status out from behind the
    // sticky Actions column -- the register squeezes Description instead.
    expect(REGISTER_DESCRIPTION_CELL_FLEX.split(' ').sort()).toEqual([
      'max-w-0',
      'w-full',
    ]);
    const row = withoutComments(
      REGISTER_SOURCES['/src/components/transactions/TransactionRow.tsx'],
    );
    const descriptionCellLine = row
      .split('\n')
      .find((line) => line.includes("registerColumnClass('description')"));
    expect(descriptionCellLine, 'the description cell exists').toBeTruthy();
    expect(
      descriptionCellLine!.includes('REGISTER_DESCRIPTION_CELL_FLEX'),
      'the description cell carries the yield classes',
    ).toBe(true);
  });

  it('lets the payee outrank Description for width', () => {
    // The payee cap is never a fixed pixel figure -- fixed is what kept the
    // longest payees truncated at 280px however wide the register grew. Both
    // halves scale with the register in cqw: a conservative share with a px
    // floor while nothing can yield, and a wider share once Description is on
    // screen to yield -- still a bound, because a 255-char payee under
    // max-w-none would overflow the table and scroll Status out from behind
    // the sticky Actions. The tier threshold must repeat the low tier's
    // figure as a literal (Tailwind's scanner only sees complete class
    // names), so this holds the two copies equal.
    const shape = REGISTER_PAYEE_NAME_CAP.match(
      /^sm:max-w-\[max\((\d+)px,(\d+)cqw\)\] @min-\[(\d+)px\]:max-w-\[(\d+)cqw\]$/,
    );
    expect(shape, 'a scaling cap with a px floor, widened at a container width').toBeTruthy();
    const [, floorPx, baseShare, thresholdPx, wideShare] = shape!.map(Number);
    expect(thresholdPx, 'the cap widens exactly where Description appears').toBe(
      PRIORITY_MIN_WIDTH_PX.low,
    );
    expect(floorPx, 'no register width renders less payee than the old fixed cap did')
      .toBeGreaterThanOrEqual(280);
    expect(wideShare, 'with Description there to yield, the payee gets more').toBeGreaterThan(
      baseShare,
    );
    expect(wideShare, 'and still a bound, so a pathological payee cannot hide Status')
      .toBeLessThan(100);

    const row = withoutComments(
      REGISTER_SOURCES['/src/components/transactions/TransactionRow.tsx'],
    );
    // Both payee renderings (the filter button and the plain name) wear the
    // shared classes -- the cap drifting on one of the two is how the last
    // hand-written pair got out of sync with the contract.
    const uses = row.match(/REGISTER_PAYEE_NAME_CAP/g) ?? [];
    expect(uses.length, 'both payee name renderings use the shared cap').toBeGreaterThanOrEqual(3); // import + 2 uses

    // And no register file reintroduces a hand-written payee-style cap.
    const offenders = Object.entries(REGISTER_SOURCES).flatMap(([path, content]) =>
      withoutComments(content)
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /sm:max-w-\[/.test(line))
        .map(({ line, number }) => `${path}:${number}: ${line.trim()}`),
    );
    expect(
      offenders,
      'A width cap on the payee name comes from REGISTER_PAYEE_NAME_CAP, ' +
        'never a hand-written sm:max-w-[...] -- a fixed cap is what kept the ' +
        'longest payee from rendering while Description held the slack.',
    ).toEqual([]);
  });

  it('gates the Account column structurally, not with CSS', () => {
    // "Only if multi-accounts selected" is a DOM decision: on a single
    // account's page the column must not exist at any width. Both files carry
    // the guard -- a header without its cells (or vice versa) misaligns every
    // column after it.
    for (const [path, content] of Object.entries(REGISTER_SOURCES)) {
      const code = withoutComments(content);
      const gate = /\{!isSingleAccountView && \(/;
      expect(gate.test(code), `${path} renders Account only for multi-account views`).toBe(
        true,
      );
    }
  });
});
