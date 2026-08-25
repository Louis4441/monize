import { describe, it, expect } from 'vitest';
import {
  nextOccurrenceEffectiveAmount,
  overrideEffectiveAmount,
  scheduleEffectiveAmount,
  sumEffectiveAmounts,
} from './scheduled-effective-amount';
import type {
  ScheduledTransaction,
  ScheduledTransactionOverride,
} from '@/types/scheduled-transaction';

/**
 * The client half of the effective-amount contract (issue #1247). The numbers are
 * the issue's worked example: 10 shares at 100, pinned at 1.50 while the security
 * was priced in EUR (so the persisted amount implies 1,500 CAD), re-priced to
 * 1,350 CAD once the security became USD at 1.35.
 *
 * Every case also asserts what must NOT come back, because the defect is a
 * plausible number rather than an error.
 */
describe('scheduled effective amounts', () => {
  const plain = (overrides: Partial<ScheduledTransaction> = {}) =>
    ({
      id: 'st-plain',
      amount: -1200,
      currencyCode: 'CAD',
      isInvestment: false,
      isSplit: false,
      isTransfer: false,
      ...overrides,
    }) as ScheduledTransaction;

  const investment = (overrides: Partial<ScheduledTransaction> = {}) =>
    ({
      id: 'st-inv',
      // The security-currency cash impact, at the account's own currency code.
      amount: -1000,
      currencyCode: 'CAD',
      isInvestment: true,
      isSplit: false,
      isTransfer: false,
      ...overrides,
    }) as ScheduledTransaction;

  const override = (
    overrides: Partial<ScheduledTransactionOverride> = {},
  ) =>
    ({
      id: 'ovr-1',
      scheduledTransactionId: 'st-plain',
      originalDate: '2026-09-01',
      overrideDate: '2026-09-03',
      amount: null,
      ...overrides,
    }) as ScheduledTransactionOverride;

  describe('scheduleEffectiveAmount', () => {
    it('reads the server figure and its settlement currency', () => {
      expect(
        scheduleEffectiveAmount(
          investment({
            effectiveAmount: -1350,
            effectiveAmountComplete: true,
            effectiveCurrencyCode: 'CAD',
          }),
        ),
      ).toEqual({ amount: -1350, currencyCode: 'CAD', complete: true });
    });

    it('reports an explicit null as unknown, never as the persisted amount', () => {
      const result = scheduleEffectiveAmount(
        investment({
          effectiveAmount: null,
          effectiveAmountComplete: false,
          effectiveCurrencyCode: 'CAD',
        }),
      );

      expect(result.amount).toBeNull();
      expect(result.complete).toBe(false);
      expect(result.amount).not.toBe(-1000);
    });

    it('keeps a plain schedule on its stored amount', () => {
      expect(scheduleEffectiveAmount(plain({ effectiveAmount: -1200 }))).toEqual(
        { amount: -1200, currencyCode: 'CAD', complete: true },
      );
    });

    // A rolling deploy serves some responses from a backend that predates the
    // field. Absent is "no information", so it is read as unknown for anything
    // an exchange rate re-prices and as the stored amount for everything else --
    // the same split `lib/forecast.ts` makes.
    describe('when the server did not send the field (older backend)', () => {
      it('treats a top-level investment schedule as unknown', () => {
        const result = scheduleEffectiveAmount(investment());

        expect(result.amount).toBeNull();
        expect(result.complete).toBe(false);
      });

      it('treats a split parent with an investment line as unknown', () => {
        const result = scheduleEffectiveAmount(
          plain({
            isSplit: true,
            splits: [
              { kind: 'investment', investmentAction: 'BUY' },
            ] as never,
          }),
        );

        expect(result.amount).toBeNull();
        expect(result.complete).toBe(false);
      });

      it('keeps a plain schedule known', () => {
        expect(scheduleEffectiveAmount(plain())).toEqual({
          amount: -1200,
          currencyCode: 'CAD',
          complete: true,
        });
      });

      it('keeps a split parent with no investment line known', () => {
        const result = scheduleEffectiveAmount(
          plain({
            isSplit: true,
            splits: [{ kind: 'category', amount: -1200 }] as never,
          }),
        );

        expect(result).toEqual({
          amount: -1200,
          currencyCode: 'CAD',
          complete: true,
        });
      });
    });
  });

  describe('overrideEffectiveAmount', () => {
    it('reads the override figure the server resolved', () => {
      const result = overrideEffectiveAmount(
        investment({
          effectiveAmount: -1350,
          effectiveAmountComplete: true,
          effectiveCurrencyCode: 'CAD',
        }),
        override({ effectiveAmount: -675, effectiveAmountComplete: true }),
      );

      expect(result).toEqual({
        amount: -675,
        currencyCode: 'CAD',
        complete: true,
      });
    });

    it('reports an unknown override as unknown', () => {
      const result = overrideEffectiveAmount(
        investment({ effectiveAmount: null, effectiveAmountComplete: false }),
        override({ effectiveAmount: null, effectiveAmountComplete: false }),
      );

      expect(result.amount).toBeNull();
      expect(result.complete).toBe(false);
    });

    it('falls through to the base occurrence for a date-only override', () => {
      const schedule = plain({ effectiveAmount: -1200 });

      expect(
        overrideEffectiveAmount(schedule, override({ amount: null })),
      ).toEqual(scheduleEffectiveAmount(schedule));
    });

    it('uses a non-investment override stored amount on an older backend', () => {
      expect(
        overrideEffectiveAmount(plain(), override({ amount: -1350 })),
      ).toEqual({ amount: -1350, currencyCode: 'CAD', complete: true });
    });
  });

  describe('nextOccurrenceEffectiveAmount', () => {
    it('prefers the next override over the base occurrence', () => {
      const result = nextOccurrenceEffectiveAmount(
        plain({
          effectiveAmount: -1200,
          nextOverride: override({ effectiveAmount: -1350 }),
        }),
      );

      expect(result.amount).toBe(-1350);
    });

    it('uses the base occurrence when there is no override', () => {
      expect(
        nextOccurrenceEffectiveAmount(plain({ effectiveAmount: -1200 })).amount,
      ).toBe(-1200);
    });
  });

  describe('sumEffectiveAmounts', () => {
    const known = (amount: number) => ({
      amount,
      currencyCode: 'CAD',
      complete: true,
    });
    const unknown = { amount: null, currencyCode: 'CAD', complete: false };

    it('totals a complete set', () => {
      expect(
        sumEffectiveAmounts([known(-1200), known(-1350)], (x) => x, Math.abs),
      ).toEqual({ total: 2550, knownSubtotal: 2550, unknownCount: 0 });
    });

    it('withholds the total when any component is unknown, keeping the subtotal', () => {
      const result = sumEffectiveAmounts(
        [known(-1200), unknown],
        (x) => x,
        Math.abs,
      );

      expect(result.total).toBeNull();
      expect(result.knownSubtotal).toBe(1200);
      expect(result.unknownCount).toBe(1);
    });

    it('totals an empty set as a known zero, not as unknown', () => {
      // Nothing upcoming is a settled answer; reporting it as unknown would take
      // a question the user can act on away from them.
      expect(sumEffectiveAmounts([], (x: never) => x)).toEqual({
        total: 0,
        knownSubtotal: 0,
        unknownCount: 0,
      });
    });

    it('accumulates in integer ten-thousandths, so cents do not drift', () => {
      const result = sumEffectiveAmounts(
        [known(0.1), known(0.2)],
        (x) => x,
      );

      expect(result.total).toBe(0.3);
    });
  });
});
