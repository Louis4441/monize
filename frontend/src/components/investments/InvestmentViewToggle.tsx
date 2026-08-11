'use client';

import { useTranslations } from 'next-intl';

/**
 * Which of an investment account's two ledgers a register is showing: the
 * brokerage's trades, or the cash account's ordinary transactions.
 */
export type InvestmentTransactionView = 'brokerage' | 'cash';

interface InvestmentViewToggleProps {
  value: InvestmentTransactionView;
  onChange: (view: InvestmentTransactionView) => void;
}

const BUTTON_BASE =
  'px-3 py-1 text-sm font-medium rounded transition-colors';
const BUTTON_ACTIVE =
  'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm';
const BUTTON_INACTIVE =
  'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200';

/**
 * The segmented control that switches an investment register between the
 * brokerage and cash ledgers.
 *
 * An investment account is one account with two ledgers, so every surface
 * showing its register offers the same switch. Rendering it from one component
 * is what keeps the two reading as the same control -- both call sites
 * previously hardcoded which half was active, so the styling had to be kept in
 * step by hand.
 */
export function InvestmentViewToggle({
  value,
  onChange,
}: InvestmentViewToggleProps) {
  const t = useTranslations('investments');

  return (
    <div className="inline-flex rounded-md bg-gray-100 dark:bg-gray-700 p-0.5">
      <button
        onClick={() => onChange('brokerage')}
        aria-pressed={value === 'brokerage'}
        className={`${BUTTON_BASE} ${value === 'brokerage' ? BUTTON_ACTIVE : BUTTON_INACTIVE}`}
      >
        {t('page.brokerageTab')}
      </button>
      <button
        onClick={() => onChange('cash')}
        aria-pressed={value === 'cash'}
        className={`${BUTTON_BASE} ${value === 'cash' ? BUTTON_ACTIVE : BUTTON_INACTIVE}`}
      >
        {t('page.cashTab')}
      </button>
    </div>
  );
}
