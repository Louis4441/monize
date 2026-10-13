import { useDensityStore } from '@/store/densityStore';
import { useDateDisplayStore } from '@/store/dateDisplayStore';
import { clearTransactionsPanelChoices } from '@/hooks/useTransactionsPanelCollapsed';

/**
 * Forget every view choice this browser has saved -- each view's row density,
 * the register's year display, and the Transactions page's widgets and chart
 * -- so the account's view defaults apply here as they do in a new browser.
 *
 * Settings offers it beside the defaults, because a default set from a browser
 * that has already made its own choices would otherwise change nothing on the
 * screen it was set from.
 */
export function clearBrowserViewChoices(): void {
  useDensityStore.getState().clearDensities();
  useDateDisplayStore.getState().clearCompactMobileDates();
  clearTransactionsPanelChoices();
}
