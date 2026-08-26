import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { failOnActWarnings, isActWarning, pendingActWarnings, recordActWarning } from './act-guard';

// React's real message, verbatim, including the printf placeholder that carries
// the component name as a separate argument.
const REACT_ACT_WARNING =
  'An update to %s inside a test was not wrapped in act(...).\n\n' +
  'When testing, code that causes React state updates should be wrapped into act(...):';

describe('act-guard', () => {
  it('recognizes React act warnings and nothing else', () => {
    expect(isActWarning([REACT_ACT_WARNING, 'TransactionsPage'])).toBe(true);
    expect(
      isActWarning(['Warning: The current testing environment is not configured to support act(...)']),
    ).toBe(true);
    expect(isActWarning(['<path> attribute d: Expected number'])).toBe(false);
    expect(isActWarning(['[useTransactionSelection]', 'Save failed'])).toBe(false);
    expect(isActWarning([new Error('boom')])).toBe(false);
  });

  it('fails the test, naming the component React named', () => {
    recordActWarning([REACT_ACT_WARNING, 'TransactionsPage']);
    expect(pendingActWarnings()).toHaveLength(1);

    expect(() => failOnActWarnings()).toThrow(/An update to TransactionsPage inside a test/);
  });

  it('reports once per distinct warning, and resets so it fails only the test that earned it', () => {
    recordActWarning([REACT_ACT_WARNING, 'DateInput']);
    recordActWarning([REACT_ACT_WARNING, 'DateInput']);
    recordActWarning([REACT_ACT_WARNING, 'SecurityList']);

    expect(() => failOnActWarnings()).toThrow(/2 act\(\) warnings/);
    // Reported once: a warning left in the buffer would fail every later test
    // in the file and hide which one actually produced it.
    expect(pendingActWarnings()).toHaveLength(0);
    expect(() => failOnActWarnings()).not.toThrow();
  });

  it('says nothing when nothing was recorded', () => {
    expect(() => failOnActWarnings()).not.toThrow();
  });

  // A guard nothing calls is not a guard. `setup.ts` is the only wiring, and it
  // is a side-effecting file that cannot be imported twice to assert on -- so
  // the wiring is checked by reading it.
  describe('setup.ts wiring', () => {
    const setup = readFileSync(join(__dirname, 'setup.ts'), 'utf8');

    it('routes console.error through the guard', () => {
      expect(setup).toMatch(/isActWarning\(args\)/);
      expect(setup).toMatch(/recordActWarning\(args\)/);
    });

    it('fails after every test and after the last one', () => {
      // In `afterEach`, after `cleanup()`: an update React commits while
      // unmounting belongs to the test that mounted the tree.
      expect(setup).toMatch(/cleanup\(\);[\s\S]*?failOnActWarnings\(\);[\s\S]*?\}\);/);
      expect(setup).toMatch(/afterAll\(failOnActWarnings\)/);
    });

    it('does not suppress act warnings anywhere else', () => {
      // Any second mention of act() in a console filter would be a silencer.
      const filtered = setup.match(/msg\.includes\('([^']*)'\)/g) ?? [];
      expect(filtered.some((m) => /act/i.test(m))).toBe(false);
    });
  });
});
