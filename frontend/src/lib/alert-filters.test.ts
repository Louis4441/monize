import { describe, it, expect } from 'vitest';
import type { BudgetAlert } from '@/types/budget';
import {
  NO_ALERT_FILTERS,
  alertCategory,
  hasActiveAlertFilters,
  matchesAlertFilters,
} from './alert-filters';

const makeAlert = (overrides: Partial<BudgetAlert> = {}): BudgetAlert => ({
  id: 'alert-1',
  userId: 'user-1',
  budgetId: 'budget-1',
  budgetCategoryId: 'bc-1',
  alertType: 'THRESHOLD_WARNING',
  severity: 'warning',
  title: 'Groceries reaching budget limit',
  message: 'You have used 85% of your Groceries budget.',
  data: {},
  isRead: false,
  isEmailSent: false,
  periodStart: '2026-02-01',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('alertCategory', () => {
  it('classifies system alert types as system', () => {
    expect(alertCategory('BACKUP_FAILED')).toBe('system');
    expect(alertCategory('SCHEDULED_POST_FAILED')).toBe('system');
    expect(alertCategory('SMTP_FAILURE')).toBe('system');
  });

  it('classifies everything else as financial, BILL_DUE included', () => {
    expect(alertCategory('BILL_DUE')).toBe('financial');
    expect(alertCategory('OVER_BUDGET')).toBe('financial');
    expect(alertCategory('POSITIVE_MILESTONE')).toBe('financial');
  });
});

describe('hasActiveAlertFilters', () => {
  it('is false with nothing selected', () => {
    expect(hasActiveAlertFilters(NO_ALERT_FILTERS)).toBe(false);
  });

  it('is true when either dimension is set', () => {
    expect(hasActiveAlertFilters({ severity: 'info', category: null })).toBe(true);
    expect(hasActiveAlertFilters({ severity: null, category: 'system' })).toBe(true);
  });
});

describe('matchesAlertFilters', () => {
  it('matches everything with no filter active', () => {
    expect(matchesAlertFilters(makeAlert(), NO_ALERT_FILTERS)).toBe(true);
  });

  it('filters on severity', () => {
    const filters = { severity: 'critical' as const, category: null };
    expect(matchesAlertFilters(makeAlert({ severity: 'critical' }), filters)).toBe(true);
    expect(matchesAlertFilters(makeAlert({ severity: 'warning' }), filters)).toBe(false);
  });

  it('filters on category', () => {
    const filters = { severity: null, category: 'system' as const };
    expect(
      matchesAlertFilters(makeAlert({ alertType: 'BACKUP_FAILED' }), filters),
    ).toBe(true);
    expect(
      matchesAlertFilters(makeAlert({ alertType: 'BILL_DUE' }), filters),
    ).toBe(false);
  });

  it('requires both dimensions when both are set', () => {
    const filters = { severity: 'critical' as const, category: 'system' as const };
    expect(
      matchesAlertFilters(
        makeAlert({ alertType: 'BACKUP_FAILED', severity: 'critical' }),
        filters,
      ),
    ).toBe(true);
    expect(
      matchesAlertFilters(
        makeAlert({ alertType: 'BACKUP_FAILED', severity: 'warning' }),
        filters,
      ),
    ).toBe(false);
    expect(
      matchesAlertFilters(
        makeAlert({ alertType: 'OVER_BUDGET', severity: 'critical' }),
        filters,
      ),
    ).toBe(false);
  });
});
