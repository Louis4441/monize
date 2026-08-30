import { describe, it, expect } from 'vitest';
import {
  REGISTER_COLUMN_ORDER,
  REGISTER_COLUMN_PRIORITY,
  PRIORITY_MIN_WIDTH_PX,
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

/** A hand-written responsive column-visibility class. */
const HAND_WRITTEN_VISIBILITY = /hidden\s+(?:sm|md|lg|xl|2xl|min-\[\d+px\]):table-cell/;

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

  it('reveals the tiers in rank order as the window widens', () => {
    // "High before medium before low" is the whole point of the tiers; a
    // class-string edit that inverted two breakpoints would otherwise pass.
    expect(PRIORITY_MIN_WIDTH_PX.always).toBe(0);
    expect(PRIORITY_MIN_WIDTH_PX.high).toBeLessThan(PRIORITY_MIN_WIDTH_PX.medium);
    expect(PRIORITY_MIN_WIDTH_PX.medium).toBeLessThan(PRIORITY_MIN_WIDTH_PX.low);
    // And the classes agree with the table the assertion above trusted.
    const widthOfClass = (cls: string): number => {
      if (cls === '') return 0;
      const named: Record<string, number> = {
        sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536,
      };
      const match = cls.match(/^hidden (?:min-\[(\d+)px\]|(sm|md|lg|xl|2xl)):table-cell$/);
      expect(match, `parseable visibility class: ${cls}`).toBeTruthy();
      return match![1] ? Number(match![1]) : named[match![2]];
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
