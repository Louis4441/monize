import { describe, it, expect } from 'vitest';
import {
  hasUnmeasuredFlow,
  periodResultUnknownReason,
  withheldPeriodCause,
} from './portfolio-period-result';

/**
 * One glyph, five server reasons: the mapping decides which repair the reader
 * is sent to, and sending them to the wrong screen is the defect `displayFx`
 * exists to avoid.
 */
describe('periodResultUnknownReason', () => {
  it('sends an unpriced holding to the security, not to the rates', () => {
    expect(periodResultUnknownReason(['incompletePrices'])).toBe('noPrice');
  });

  it('sends a cash gap to neither a price nor a rate', () => {
    expect(periodResultUnknownReason(['incompleteCash'])).toBe('noCashBalance');
  });

  it('sends an unconvertible amount to the rates', () => {
    expect(periodResultUnknownReason(['missingRatePairs'])).toBe('displayFx');
  });

  it.each(['zeroStart', 'noValueSeries'] as const)(
    'treats %s as a boundary with nothing to repair',
    (reason) => {
      expect(periodResultUnknownReason([reason])).toBe('noBaseline');
    },
  );

  it('names the price when a day is short of more than one component', () => {
    // A price is the repair the reader can make first, and repairing it may
    // resolve the rest of the day; the banner still carries every cause.
    expect(
      periodResultUnknownReason(['missingRatePairs', 'incompletePrices']),
    ).toBe('noPrice');
  });

  it('says nothing about a reason list it was never given', () => {
    expect(periodResultUnknownReason([])).toBe('noBaseline');
  });

  it.each(['externallySettledTrade', 'mixedSplit'] as const)(
    'sends %s nowhere, because no missing datum caused it',
    (reason) => {
      expect(periodResultUnknownReason([reason])).toBe('noBaseline');
    },
  );
});

describe('hasUnmeasuredFlow', () => {
  it.each(['externallySettledTrade', 'mixedSplit'] as const)(
    'is true for %s, so the card can name the cause',
    (reason) => {
      expect(hasUnmeasuredFlow([reason])).toBe(true);
    },
  );

  it('is false for a period whose figures are merely missing data', () => {
    expect(hasUnmeasuredFlow(['incompletePrices', 'missingRatePairs'])).toBe(
      false,
    );
    expect(hasUnmeasuredFlow([])).toBe(false);
  });
});

describe('withheldPeriodCause', () => {
  it('prints nothing for boundaries, which are not defects', () => {
    expect(withheldPeriodCause([['noValueSeries'], ['zeroStart']])).toBeNull();
    expect(withheldPeriodCause([])).toBeNull();
  });

  it('ranks a price over a balance over a rate, across periods', () => {
    expect(
      withheldPeriodCause([['missingRatePairs'], ['incompleteCash']]),
    ).toBe('incompleteCash');
    expect(
      withheldPeriodCause([['missingRatePairs'], ['incompletePrices']]),
    ).toBe('incompletePrices');
    expect(withheldPeriodCause([['missingRatePairs']])).toBe('missingRatePairs');
  });

  it('names an uncountable movement only when nothing is missing', () => {
    expect(withheldPeriodCause([['externallySettledTrade']])).toBe('unmeasuredFlow');
    expect(withheldPeriodCause([['mixedSplit', 'noValueSeries']])).toBe('unmeasuredFlow');
    expect(
      withheldPeriodCause([['mixedSplit'], ['missingRatePairs']]),
    ).toBe('missingRatePairs');
  });
});
