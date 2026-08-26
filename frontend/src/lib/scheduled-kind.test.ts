import { describe, it, expect } from 'vitest';
import {
  SCHEDULED_KIND_AMOUNT_CLASSES,
  occurrenceKind,
  SCHEDULED_KIND_CHIP_CLASSES,
  scheduledKind,
} from './scheduled-kind';

describe('scheduledKind', () => {
  it('classifies a negative amount as a bill', () => {
    expect(scheduledKind({ amount: -1200 })).toBe('bill');
    expect(scheduledKind({ amount: '-0.0001' })).toBe('bill');
  });

  it('classifies a positive amount as a deposit', () => {
    expect(scheduledKind({ amount: 5000 })).toBe('deposit');
    expect(scheduledKind({ amount: '0.0001' })).toBe('deposit');
  });

  it('classifies a zero amount as a reminder, not a deposit', () => {
    expect(scheduledKind({ amount: 0 })).toBe('reminder');
    expect(scheduledKind({ amount: '0.0000' })).toBe('reminder');
    expect(scheduledKind({ amount: -0 })).toBe('reminder');
  });

  it('classifies a transfer as a transfer whatever its amount', () => {
    expect(scheduledKind({ amount: 0, isTransfer: true })).toBe('transfer');
    expect(scheduledKind({ amount: -500, isTransfer: true })).toBe('transfer');
    expect(scheduledKind({ amount: 500, isTransfer: true })).toBe('transfer');
  });

  it('treats an unparseable amount as a reminder rather than a deposit', () => {
    expect(scheduledKind({ amount: 'n/a' })).toBe('reminder');
  });

  describe('occurrenceKind', () => {
    it('classifies from the occurrence\'s own amount when it is known', () => {
      // The template is an outflow; this occurrence was overridden to a credit.
      expect(occurrenceKind({ amount: 50 }, { amount: -100 })).toBe('deposit');
      expect(occurrenceKind({ amount: -50 }, { amount: 100 })).toBe('bill');
    });

    /**
     * The trap the helper exists for: `Number(null)` is 0, which classifies an
     * unpriceable bill as a grey reminder. An exchange rate is positive, so the
     * schedule's sign is still the right answer for direction (issue #1247).
     */
    it('falls back to the schedule\'s sign when the occurrence is unpriceable', () => {
      expect(occurrenceKind({ amount: null }, { amount: -1000 })).toBe('bill');
      expect(occurrenceKind({ amount: null }, { amount: 3000 })).toBe('deposit');
      expect(occurrenceKind({ amount: null }, { amount: '-1000.0000' })).toBe(
        'bill',
      );
    });

    it('keeps a transfer a transfer, priced or not', () => {
      expect(
        occurrenceKind({ amount: null }, { amount: -100, isTransfer: true }),
      ).toBe('transfer');
      expect(
        occurrenceKind({ amount: -100 }, { amount: -100, isTransfer: true }),
      ).toBe('transfer');
    });

    it('keeps a zero-amount reminder a reminder', () => {
      expect(occurrenceKind({ amount: 0 }, { amount: 0 })).toBe('reminder');
      expect(occurrenceKind({ amount: null }, { amount: 0 })).toBe('reminder');
    });
  });

  it('gives every kind its own chip and amount styling', () => {
    const kinds = ['bill', 'deposit', 'transfer', 'reminder'] as const;
    const chips = kinds.map((k) => SCHEDULED_KIND_CHIP_CLASSES[k]);
    const amounts = kinds.map((k) => SCHEDULED_KIND_AMOUNT_CLASSES[k]);
    expect(new Set(chips).size).toBe(kinds.length);
    expect(new Set(amounts).size).toBe(kinds.length);
  });
});
