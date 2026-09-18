'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { exchangeRatesApi, RateCoverage } from '@/lib/exchange-rates';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('RateHistoryCoverage');

interface RateHistoryCoverageProps {
  /** The currency being edited. Its pair is this against the reporting currency. */
  code: string;
}

/**
 * What exchange rate history is stored for this currency, and a way to add
 * another year of it.
 *
 * The stored history of a pair usually starts the day the daily refresh first
 * ran, so a report dated earlier reports "no exchange rate" for dates the
 * provider does in fact have. Extending it is a shared write, but it needs no
 * admin rights: the pair is always this currency against the reader's own
 * reporting currency, and the year is bounded.
 *
 * Deliberately rendered OUTSIDE the currency form's `<form>`: none of this is
 * a field, and a section that marked the form dirty would arm the unsaved-changes
 * prompt for a button that saves nothing of the user's.
 */
export function RateHistoryCoverage({ code }: RateHistoryCoverageProps) {
  const t = useTranslations('currencies');
  const { defaultCurrency } = useExchangeRates();
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();

  const [coverage, setCoverage] = useState<RateCoverage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isExtending, setIsExtending] = useState(false);

  const pair = `${code}->${defaultCurrency}`;
  // 1 is not a stored rate, so there is no history for a currency against
  // itself and nothing to extend.
  const sameCurrency = code === defaultCurrency;

  const loadCoverage = useCallback(async () => {
    setIsLoading(true);
    try {
      setCoverage(await exchangeRatesApi.getRateCoverage(code));
      setLoadFailed(false);
    } catch (error) {
      logger.error('Rate coverage load failed:', error);
      setCoverage(null);
      setLoadFailed(true);
    } finally {
      setIsLoading(false);
    }
  }, [code]);

  useEffect(() => {
    if (sameCurrency) return;
    void loadCoverage();
  }, [sameCurrency, loadCoverage]);

  const handleExtend = useCallback(async () => {
    setIsExtending(true);
    try {
      const result = await exchangeRatesApi.extendRateHistory(code);
      if (result.stored > 0) {
        toast.success(
          t('rateHistory.toasts.added', {
            count: formatNumber(result.stored, 0),
            start: result.earliestDate ? formatDate(result.earliestDate) : '',
          }),
        );
        // Re-read rather than patch: the server decides what is stored, and it
        // has just written rows this component has never seen.
        await loadCoverage();
      } else {
        // The provider answered and had nothing that far back. A provider that
        // did not answer arrives as a rejection below, not as this zero.
        toast.error(t('rateHistory.toasts.noOlder', { pair }));
      }
    } catch (error) {
      logger.error('Rate history extension failed:', error);
      toast.error(getErrorMessage(error, t('rateHistory.toasts.failed')));
    } finally {
      setIsExtending(false);
    }
  }, [code, pair, t, formatNumber, formatDate, loadCoverage]);

  if (sameCurrency) return null;

  const hasStoredHistory = !!coverage?.earliestDate && !!coverage?.latestDate;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-2">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('rateHistory.title')}
      </h3>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {isLoading
          ? t('rateHistory.loading')
          : loadFailed
            ? t('rateHistory.loadFailed')
            : hasStoredHistory
              ? t('rateHistory.stored', {
                  start: formatDate(coverage!.earliestDate!),
                  end: formatDate(coverage!.latestDate!),
                  count: formatNumber(coverage!.observations, 0),
                })
              : t('rateHistory.none', { pair })}
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('rateHistory.hint', { pair })}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={handleExtend}
        disabled={isExtending}
      >
        {isExtending ? t('rateHistory.adding') : t('rateHistory.addYear')}
      </Button>
    </div>
  );
}
