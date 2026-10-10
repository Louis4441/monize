'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateInput } from '@/components/ui/DateInput';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useReportData } from '@/hooks/useReportData';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import type { Security } from '@/types/investment';
import type {
  BondMissingObservation,
  SecurityBondValuation,
} from '@/types/bond';
import { SecurityBondLotsTable } from './SecurityBondLotsTable';
import { SecurityBondRateSection } from './SecurityBondRateSection';

interface SecurityBondCardProps {
  security: Security;
  /** Called after a recompute wrote or removed prices, so the page re-reads its quote. */
  onPricesChanged?: () => void | Promise<void>;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Each distinct entry once, in first-seen order. */
function distinct<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * A bond-linked security's lots valued on a day (spec 13). Shown only for a
 * security with a `bondInstrumentId`; the page decides that.
 *
 * The payload is kept with the request key that produced it (security and
 * day): while a different key is loading, the previous figures are not shown,
 * and a failed request is an error state, never an empty or zero valuation.
 */
export function SecurityBondCard({
  security,
  onPricesChanged,
}: SecurityBondCardProps) {
  const t = useTranslations('securityDetail');
  const { formatCurrency, formatPercentTrimmed, formatShareQuantity } =
    useNumberFormat();
  const today = useFinancialToday();
  // '' means "today", so a tab left open across midnight does not pin a day.
  const [pickedAsOf, setPickedAsOf] = useState('');
  const asOf = YMD.test(pickedAsOf) ? pickedAsOf : today;
  const requestKey = `${security.id}|${asOf}`;
  const [isRecomputing, setIsRecomputing] = useState(false);

  const { data, dataKey, isLoading, error, reload } =
    useReportData<SecurityBondValuation>(
      () => investmentsApi.getSecurityBondValuation(security.id, asOf),
      [security.id, asOf],
      { requestKey },
    );

  // The payload belongs to the request that produced it: anything else on hand
  // describes another security or day and is not shown as this one.
  const valuation = data !== null && dataKey === requestKey ? data : null;
  const currency = security.currencyCode;

  const handleRecompute = async () => {
    setIsRecomputing(true);
    try {
      const result = await investmentsApi.recomputeSecurityBondPrices(
        security.id,
      );
      toast.success(
        t('bond.recompute.done', {
          written: result.written,
          deleted: result.deleted,
        }),
      );
      reload();
      await onPricesChanged?.();
    } catch (err) {
      toast.error(getErrorMessage(err, t('bond.recompute.failed')));
    } finally {
      setIsRecomputing(false);
    }
  };

  const assumptions = useMemo(
    () =>
      valuation
        ? distinct(
            valuation.lots.flatMap((l) => l.valuation.projectionAssumptions),
            (a) => `${a.benchmarkId}|${a.value}|${a.basis}|${a.observation ?? ''}`,
          )
        : [],
    [valuation],
  );
  const missing = useMemo<BondMissingObservation[]>(
    () =>
      valuation
        ? distinct(
            valuation.lots.flatMap((l) => l.valuation.missing),
            (m) => `${m.benchmarkId}|${m.observation}|${m.publisher ?? ''}`,
          )
        : [],
    [valuation],
  );

  const unknownTotal = (reason: string): ReactNode => (
    <>
      <span className="text-gray-500 dark:text-gray-400">
        {t('bond.unknown')}
      </span>
      <span className="block text-xs font-normal text-gray-500 dark:text-gray-400">
        {reason}
      </span>
    </>
  );

  const renderBody = () => {
    // A failed latest request is shown as one, whatever an earlier answer was.
    if (error) {
      return (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-red-600 dark:text-red-400">
            {getErrorMessage(error, t('bond.loadFailed'))}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            {t('error.retry')}
          </Button>
        </div>
      );
    }
    if (!valuation) {
      return (
        <div className="flex justify-center py-8">
          <LoadingSpinner text={t('bond.loading')} />
        </div>
      );
    }

    const { totals, refusal, lots, instrument } = valuation;
    const totalReason = refusal
      ? t('bond.totals.unknownRefusal')
      : t('bond.totals.unknownLot');
    const total = (value: string | null): ReactNode =>
      value === null
        ? unknownTotal(totalReason)
        : formatCurrency(Number(value), currency);

    return (
      <div className="space-y-4" aria-busy={isLoading}>
        {/* Figures only mean something with the instrument they belong to. */}
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('bond.instrument', {
            series: instrument.seriesCode,
            issuer: instrument.issuerCode,
            program: instrument.programCode,
            country: instrument.issuerCountryCode,
          })}
        </p>

        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">
              {t('bond.totals.quantity')}
            </dt>
            <dd className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {totals.quantity === null
                ? unknownTotal(totalReason)
                : formatShareQuantity(totals.quantity)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">
              {t('bond.totals.grossValue')}
            </dt>
            <dd className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {total(totals.grossValue)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">
              {t('bond.totals.earlyRedemptionValue')}
            </dt>
            <dd className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {total(totals.earlyRedemptionValue)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">
              {t('bond.totals.accruedInterest')}
            </dt>
            <dd className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {total(totals.accruedInterest)}
            </dd>
          </div>
        </dl>

        {refusal && (
          <div
            role="alert"
            className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
          >
            <p className="font-medium">
              {t(`bond.lotsRefusal.${refusal.code}`)}
            </p>
            <p className="mt-1">{refusal.detail}</p>
          </div>
        )}

        {!refusal && lots.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('bond.noLots')}
          </p>
        )}
        {lots.length > 0 && (
          <SecurityBondLotsTable lots={lots} currency={currency} />
        )}
        {lots.length > 0 && <SecurityBondRateSection lots={lots} />}

        {assumptions.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('bond.assumptions.title')}
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-400">
              {assumptions.map((a) => (
                <li
                  key={`${a.benchmarkId}|${a.value}|${a.basis}|${a.observation ?? ''}`}
                >
                  {a.basis === 'LATEST_OBSERVATION' && a.observation !== null
                    ? t('bond.assumptions.latestObservation', {
                        benchmarkId: a.benchmarkId,
                        value: formatPercentTrimmed(Number(a.value) * 100),
                        observation: a.observation,
                      })
                    : t('bond.assumptions.supplied', {
                        benchmarkId: a.benchmarkId,
                        value: formatPercentTrimmed(Number(a.value) * 100),
                      })}
                </li>
              ))}
            </ul>
          </div>
        )}

        {missing.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('bond.missing.title')}
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-400">
              {missing.map((m) => (
                <li key={`${m.benchmarkId}|${m.observation}|${m.publisher ?? ''}`}>
                  {m.publisher === null
                    ? t('bond.missing.itemNoPublisher', {
                        benchmarkId: m.benchmarkId,
                        observation: m.observation,
                      })
                    : t('bond.missing.item', {
                        benchmarkId: m.benchmarkId,
                        observation: m.observation,
                        publisher: m.publisher,
                      })}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  return (
    <Card padding="sm" aria-label={t('bond.title')} as="section">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('bond.title')}
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-44">
            <DateInput
              label={t('bond.asOf')}
              value={asOf}
              onDateChange={(date) => setPickedAsOf(date)}
            />
          </div>
          <Button
            variant="outline"
            onClick={handleRecompute}
            disabled={isRecomputing}
            isLoading={isRecomputing}
          >
            {t('bond.recompute.button')}
          </Button>
        </div>
      </div>
      {renderBody()}
    </Card>
  );
}
