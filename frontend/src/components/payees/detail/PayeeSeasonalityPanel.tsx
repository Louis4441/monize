'use client';

import { SeasonalityPanel } from '@/components/accounts/shared/SeasonalityPanel';
import type { DisplayCurrencyStrategy } from '@/components/transactions/widget-shared';
import type { MonthlyTotal } from '@/types/transaction';

interface PayeeSeasonalityPanelProps {
  /** The payee's whole monthly history. */
  monthly: MonthlyTotal[];
  currencyStrategy: DisplayCurrencyStrategy;
  isLoading: boolean;
}

/**
 * The shared seasonality strip with the payee page's wording. The rendering --
 * twelve fixed calendar slots, peak detection, the empty and short-history
 * states -- lives in `SeasonalityPanel`, shared with the category detail page.
 */
export function PayeeSeasonalityPanel(props: PayeeSeasonalityPanelProps) {
  return <SeasonalityPanel {...props} namespace="payeeDetail" />;
}
