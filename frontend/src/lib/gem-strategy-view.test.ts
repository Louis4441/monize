import { describe, it, expect } from 'vitest';
import {
  GEM_DEFAULT_RANGE,
  GEM_EQUITY_ROLES,
  GEM_RANGES,
  GEM_ROLE_COLOURS,
  GEM_OPTIONAL_ROLES,
  GEM_ROLE_ORDER,
  assetSymbol,
  buildPerformanceRows,
  compliancePercent,
  isKnown,
  isMapped,
  lastKnownIndex,
  momentumBarWidth,
  performanceDomain,
  rolesWithData,
  sortHistoryNewestFirst,
  warnedRoles,
  warningCodes,
} from './gem-strategy-view';
import { gemHistory, gemPerformance } from '@/test/gem-fixtures';

describe('gem-strategy-view', () => {
  describe('constants', () => {
    it('orders equities before the defensive roles and colours every role', () => {
      expect(GEM_ROLE_ORDER).toEqual([
        'US_EQUITY',
        'EX_US_EQUITY',
        'EM_EQUITY',
        'SAFE',
        'RISK_FREE',
      ]);
      expect(GEM_EQUITY_ROLES).not.toContain('SAFE');
      expect(GEM_EQUITY_ROLES).not.toContain('RISK_FREE');
      // The yardstick is the one role a strategy can run without.
      expect(GEM_OPTIONAL_ROLES).toEqual(['RISK_FREE']);
      for (const role of GEM_ROLE_ORDER) {
        expect(GEM_ROLE_COLOURS[role]).toMatch(/^var\(--chart-/);
      }
    });

    it('defaults the chart to one year', () => {
      expect(GEM_DEFAULT_RANGE).toBe('1Y');
      expect(GEM_RANGES).toContain('MAX');
    });
  });

  describe('isKnown', () => {
    it('accepts finite numbers only', () => {
      expect(isKnown(0)).toBe(true);
      expect(isKnown(-3.5)).toBe(true);
      expect(isKnown(null)).toBe(false);
      expect(isKnown(undefined)).toBe(false);
      expect(isKnown(Number.NaN)).toBe(false);
      expect(isKnown(Number.POSITIVE_INFINITY)).toBe(false);
    });
  });

  describe('isMapped / assetSymbol', () => {
    it('treats a role without a symbol as unmapped', () => {
      const mapped = { role: 'SAFE' as const, securityId: 's', symbol: 'IEF', name: 'IEF' };
      const unmapped = { role: 'SAFE' as const, securityId: null, symbol: null, name: null };
      expect(isMapped(mapped)).toBe(true);
      expect(isMapped(unmapped)).toBe(false);
      expect(isMapped(null)).toBe(false);
      expect(assetSymbol(mapped)).toBe('IEF');
      expect(assetSymbol(unmapped)).toBeNull();
      expect(assetSymbol(undefined)).toBeNull();
    });
  });

  describe('buildPerformanceRows', () => {
    it('returns one timestamped row per point with a key per role', () => {
      const rows = buildPerformanceRows(gemPerformance());
      expect(rows).toHaveLength(3);
      expect(rows[0].ts).toBeLessThan(rows[2].ts);
      expect(rows[2].EM_EQUITY).toBe(29.87);
    });

    it('keeps a missing observation null instead of zero', () => {
      const rows = buildPerformanceRows(
        gemPerformance({
          points: [{ date: '2025-01-01', values: { US_EQUITY: 5, EM_EQUITY: null } }],
        }),
      );
      expect(rows[0].US_EQUITY).toBe(5);
      expect(rows[0].EM_EQUITY).toBeNull();
      expect(rows[0].SAFE).toBeNull();
    });

    it('sorts out-of-order points and handles no performance', () => {
      const rows = buildPerformanceRows(
        gemPerformance({
          points: [
            { date: '2025-03-01', values: { SAFE: 2 } },
            { date: '2025-01-01', values: { SAFE: 1 } },
          ],
        }),
      );
      expect(rows.map((row) => row.SAFE)).toEqual([1, 2]);
      expect(buildPerformanceRows(null)).toEqual([]);
    });
  });

  describe('lastKnownIndex', () => {
    it('finds the last row carrying a value, or -1', () => {
      const rows = buildPerformanceRows(
        gemPerformance({
          points: [
            { date: '2025-01-01', values: { US_EQUITY: 1 } },
            { date: '2025-02-01', values: { US_EQUITY: 2 } },
            { date: '2025-03-01', values: { US_EQUITY: null } },
          ],
        }),
      );
      expect(lastKnownIndex(rows, 'US_EQUITY')).toBe(1);
      expect(lastKnownIndex(rows, 'EM_EQUITY')).toBe(-1);
    });
  });

  describe('rolesWithData', () => {
    it('lists only roles with at least one observation', () => {
      // The fixture charts the four roles a strategy always has.
      expect(rolesWithData(gemPerformance())).toEqual(
        GEM_ROLE_ORDER.filter((role) => role !== 'RISK_FREE'),
      );
      expect(
        rolesWithData(
          gemPerformance({
            points: [{ date: '2025-01-01', values: { SAFE: 1, EM_EQUITY: null } }],
          }),
        ),
      ).toEqual(['SAFE']);
      expect(rolesWithData(null)).toEqual([]);
    });
  });

  describe('performanceDomain', () => {
    it('pads the range and always spans zero', () => {
      const domain = performanceDomain(gemPerformance());
      expect(domain).toBeDefined();
      expect(domain![0]).toBeLessThanOrEqual(0);
      expect(domain![1]).toBeGreaterThanOrEqual(30);
    });

    it('returns undefined without values', () => {
      expect(performanceDomain(null)).toBeUndefined();
      expect(
        performanceDomain(gemPerformance({ points: [{ date: '2025-01-01', values: {} }] })),
      ).toBeUndefined();
    });
  });

  describe('momentumBarWidth', () => {
    it('scales against the largest absolute value in the set', () => {
      expect(momentumBarWidth(30, [30, 15])).toBe(100);
      expect(momentumBarWidth(15, [30, 15])).toBe(50);
    });

    it('scales negatives by magnitude and keeps a visible sliver', () => {
      expect(momentumBarWidth(-30, [-30, 15])).toBe(100);
      expect(momentumBarWidth(0.01, [50])).toBe(2);
    });

    it('is zero for an unknown value', () => {
      expect(momentumBarWidth(null, [10])).toBe(0);
      expect(momentumBarWidth(5, [null])).toBe(100);
    });
  });

  describe('compliance helpers', () => {
    it('clamps into 0-100 and keeps unknown unknown', () => {
      expect(compliancePercent(64)).toBe(64);
      expect(compliancePercent(120)).toBe(100);
      expect(compliancePercent(-5)).toBe(0);
      expect(compliancePercent(null)).toBeNull();
    });

 });

  describe('warning helpers', () => {
    it('collects codes and the roles a code flagged', () => {
      const warnings = [
        { code: 'UNMAPPED_ROLE' as const, roles: ['SAFE' as const] },
        { code: 'UNMAPPED_ROLE' as const, roles: ['US_EQUITY' as const] },
        { code: 'STALE_PRICES' as const },
      ];
      expect([...warningCodes(warnings)]).toEqual(['UNMAPPED_ROLE', 'STALE_PRICES']);
      expect(warnedRoles(warnings, 'UNMAPPED_ROLE')).toEqual(['US_EQUITY', 'SAFE']);
      expect(warnedRoles(warnings, 'NO_ACCOUNT')).toEqual([]);
      expect(warningCodes(undefined).size).toBe(0);
      expect(warnedRoles(undefined, 'UNMAPPED_ROLE')).toEqual([]);
    });
  });

  describe('sortHistoryNewestFirst', () => {
    it('sorts newest first without mutating the input', () => {
      const history = gemHistory();
      const ascending = [...history].reverse();
      const sorted = sortHistoryNewestFirst(ascending);
      expect(sorted.map((entry) => entry.id)).toEqual(['hist-1', 'hist-2', 'hist-3']);
      expect(ascending[0].id).toBe('hist-3');
    });
  });
});
