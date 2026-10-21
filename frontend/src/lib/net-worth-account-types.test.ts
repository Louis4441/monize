import { describe, it, expect } from 'vitest';
import {
  NET_WORTH_ACCOUNT_TYPE_ORDER,
  netWorthAccountTypeColor,
  netWorthAccountTypes,
  netWorthStackTop,
} from './net-worth-account-types';
import { chartColors } from './chart-colors';

describe('netWorthAccountTypes', () => {
  it('lists every type any month holds, in stacking order', () => {
    expect(
      netWorthAccountTypes([
        { byAccountType: { MORTGAGE: -100, CHEQUING: 10 } },
        { byAccountType: { INVESTMENT: 50, CHEQUING: 12 } },
      ]),
    ).toEqual(['CHEQUING', 'INVESTMENT', 'MORTGAGE']);
  });

  it('is empty when no month carries the breakdown', () => {
    expect(netWorthAccountTypes([{}, { byAccountType: undefined }])).toEqual([]);
  });
});

describe('netWorthAccountTypeColor', () => {
  it('gives every type its own colour, never the net worth line accent', () => {
    const colours = NET_WORTH_ACCOUNT_TYPE_ORDER.map(netWorthAccountTypeColor);
    expect(new Set(colours).size).toBe(colours.length);
    expect(colours).not.toContain(chartColors.primary);
    expect(colours).not.toContain('var(--chart-1)');
    expect(netWorthAccountTypeColor('OTHER')).toBe(chartColors.neutral);
  });
});

describe('netWorthStackTop', () => {
  it('is what the asset types hold, owed amounts aside', () => {
    expect(
      netWorthStackTop({ netWorth: 60, byAccountType: { CHEQUING: 10, INVESTMENT: 200, MORTGAGE: -150 } }),
    ).toBe(210);
  });

  it('is zero for a month that only owes', () => {
    expect(netWorthStackTop({ netWorth: -150, byAccountType: { MORTGAGE: -150 } })).toBe(0);
  });

  it('is net worth for a month without the breakdown', () => {
    expect(netWorthStackTop({ netWorth: 42 })).toBe(42);
  });
});
