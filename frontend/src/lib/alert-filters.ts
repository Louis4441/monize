import type {
  AlertCategory,
  AlertSeverity,
  AlertType,
  BudgetAlert,
} from '@/types/budget';
import { SYSTEM_ALERT_TYPES } from '@/types/budget';

/**
 * The alert panel's active filter. `null` on a dimension means that dimension
 * is unfiltered. The same object travels on the delete-all command, so what
 * the user sees matching and what the server dismisses are classified by one
 * rule (`SYSTEM_ALERT_TYPES`, contract-tested against the backend's copy).
 */
export interface AlertFilters {
  severity: AlertSeverity | null;
  category: AlertCategory | null;
}

export const NO_ALERT_FILTERS: AlertFilters = { severity: null, category: null };

export function alertCategory(alertType: AlertType): AlertCategory {
  return SYSTEM_ALERT_TYPES.includes(alertType) ? 'system' : 'financial';
}

export function hasActiveAlertFilters(filters: AlertFilters): boolean {
  return filters.severity !== null || filters.category !== null;
}

export function matchesAlertFilters(
  alert: BudgetAlert,
  filters: AlertFilters,
): boolean {
  if (filters.severity !== null && alert.severity !== filters.severity) {
    return false;
  }
  if (
    filters.category !== null &&
    alertCategory(alert.alertType) !== filters.category
  ) {
    return false;
  }
  return true;
}
