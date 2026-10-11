'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateInput } from '@/components/ui/DateInput';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useReportData } from '@/hooks/useReportData';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import type { Security } from '@/types/investment';
import type {
  BondAssumption,
  BondMissingObservation,
  BondProjectionMissing,
  SecurityBondValuation,
} from '@/types/bond';
import { benchmarkLabel, issuerLabel, programLabel } from './bond-labels';
import { SecurityBondLotsTable } from './SecurityBondLotsTable';
import { SecurityBondRateSection } from './SecurityBondRateSection';
import { SecurityBondScenarioPanel } from './SecurityBondScenarioPanel';

interface SecurityBondCardProps {
  security: Security;
  /** Called after a recompute wrote or removed prices, so the page re-reads its quote. */
  onPricesChanged?: () => void | Promise<void>;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Investment action enum to its key in `investments.transactionList`. */
const ACTION_LABEL_KEYS: Record<string, string> = {
  BUY: 'actionBuy',
  SELL: 'actionSell',
  DIVIDEND: 'actionDividend',
  INTEREST: 'actionInterest',
  CAPITAL_GAIN: 'actionCapitalGain',
  SPLIT: 'actionSplit',
  TRANSFER_IN: 'actionTransferIn',
  TRANSFER_OUT: 'actionTransferOut',
  REINVEST: 'actionReinvest',
  ADD_SHARES: 'actionAddShares',
  REMOVE_SHARES: 'actionRemoveShares',
};

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
  const tInv = useTranslations('investments');
  const { formatDate } = useDateFormat();
  const today = useFinancialToday();
  // '' means "today", so a tab left open across midnight does not pin a day.
  const [pickedAsOf, setPickedAsOf] = useState('');
  const asOf = YMD.test(pickedAsOf) ? pickedAsOf : today;
  // The value the reader picked in the scenario panel; null is the engine's
  // default assumption (no `assume`). It belongs to one benchmark of one security.
  const [picked, setPicked] = useState<{
    securityId: string;
    benchmarkId: string;
    value: string;
  } | null>(null);
  const assume: BondAssumption | null =
    picked !== null && picked.securityId === security.id
      ? { benchmarkId: picked.benchmarkId, value: picked.value }
      : null;
  const requestKey = `${security.id}|${asOf}|${
    assume ? `${assume.benchmarkId}:${assume.value}` : ''
  }`;
  const [isRecomputing, setIsRecomputing] = useState(false);

  const { data, dataKey, isLoading, error, reload } =
    useReportData<SecurityBondValuation>(
      () =>
        investmentsApi.getSecurityBondValuation(
          security.id,
          asOf,
          assume ?? undefined,
        ),
      [security.id, asOf, assume?.benchmarkId, assume?.value],
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

  // A benchmark no future period can be projected from, each once.
  const projectionMissing = useMemo<BondProjectionMissing[]>(
    () =>
      valuation
        ? distinct(
            valuation.lots.flatMap((l) => l.valuation.projectionMissing ?? []),
            (m) => `${m.benchmarkId}|${m.publisher ?? ''}`,
          )
        : [],
    [valuation],
  );
  // `=== false` only: an absent flag is no information. Each cause is named.
  const incompleteLots = useMemo(
    () =>
      valuation
        ? valuation.lots.filter((l) => l.valuation.valuationComplete === false)
        : [],
    [valuation],
  );

  // Each cause once. A lot that is incomplete for a reason no flag names (a
  // refused purchase, a rate not known yet) is reported as "other".
  const partialCauses = useMemo(() => {
    const causes: Array<'terms' | 'reference' | 'earlyRedemption' | 'other'> = [];
    const has = (pick: (l: (typeof incompleteLots)[number]) => boolean) =>
      incompleteLots.some(pick);
    if (has((l) => l.valuation.dataCompleteness?.termsComplete === false)) {
      causes.push('terms');
    }
    if (has((l) => l.valuation.dataCompleteness?.referenceDataComplete === false)) {
      causes.push('reference');
    }
    if (
      has((l) => l.valuation.dataCompleteness?.earlyRedemptionTermsComplete === false)
    ) {
      causes.push('earlyRedemption');
    }
    const unexplained = (l: (typeof incompleteLots)[number]) => {
      const c = l.valuation.dataCompleteness;
      return (
        c?.termsComplete !== false &&
        c?.referenceDataComplete !== false &&
        c?.earlyRedemptionTermsComplete !== false
      );
    };
    if (has(unexplained)) causes.push('other');
    return causes;
  }, [incompleteLots]);

  // The action enum is shown by the investment screens' own translated name.
  const actionLabel = (action: string): string => {
    const key = ACTION_LABEL_KEYS[action];
    return key === undefined ? action : tInv(`transactionList.${key}`);
  };
  const benchmarkName = (id: string) => benchmarkLabel(t, id);
  // A step series is keyed by day, a monthly one by YYYY-MM (shown as is).
  const observationLabel = (key: string) => (YMD.test(key) ? formatDate(key) : key);

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
    const coverage = valuation.benchmarkCoverage ?? [];
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
            issuer: issuerLabel(t, instrument.issuerCode),
            program: programLabel(t, instrument.programCode),
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

        {incompleteLots.length > 0 && (
          <div
            role="note"
            className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
          >
            <p className="font-medium">{t('bond.partial.title')}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {partialCauses.map((cause) => (
                <li key={cause}>{t(`bond.partial.${cause}`)}</li>
              ))}
            </ul>
          </div>
        )}

        {refusal && (
          <div
            role="alert"
            className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
          >
            <p className="font-medium">
              {t(`bond.lotsRefusal.${refusal.code}`)}
            </p>
            <p className="mt-1">
              {t(`bond.lotsRefusalDetail.${refusal.code}`, {
                action: actionLabel(refusal.params.action),
                date: formatDate(refusal.params.date),
                quantity:
                  refusal.params.quantity === null
                    ? t('bond.unknown')
                    : formatShareQuantity(Number(refusal.params.quantity)),
              })}
            </p>
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
        {lots.length > 0 && (
          <SecurityBondRateSection
            lots={lots}
            currency={currency}
            redemptionTerms={valuation.redemptionTerms ?? null}
          />
        )}

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
                        benchmark: benchmarkName(a.benchmarkId),
                        value: formatPercentTrimmed(Number(a.value) * 100),
                        observation: observationLabel(a.observation),
                      })
                    : t('bond.assumptions.supplied', {
                        benchmark: benchmarkName(a.benchmarkId),
                        value: formatPercentTrimmed(Number(a.value) * 100),
                      })}
                </li>
              ))}
            </ul>
          </div>
        )}

        {projectionMissing.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('bond.projectionMissing.title')}
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-400">
              {projectionMissing.map((m) => (
                <li key={`${m.benchmarkId}|${m.publisher ?? ''}`}>
                  {m.publisher === null
                    ? t('bond.projectionMissing.itemNoPublisher', {
                        benchmark: benchmarkName(m.benchmarkId),
                      })
                    : t('bond.projectionMissing.item', {
                        benchmark: benchmarkName(m.benchmarkId),
                        publisher: m.publisher,
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
                        benchmark: benchmarkName(m.benchmarkId),
                        observation: observationLabel(m.observation),
                      })
                    : t('bond.missing.item', {
                        benchmark: benchmarkName(m.benchmarkId),
                        observation: observationLabel(m.observation),
                        publisher: m.publisher,
                      })}
                </li>
              ))}
            </ul>
          </div>
        )}

        {coverage.length > 0 && (
          <ul className="space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
            {coverage.map((c) => (
              <li key={c.benchmarkId}>
                {c.coveredThrough === null
                  ? t('bond.coverage.none', {
                      benchmark: benchmarkName(c.benchmarkId),
                    })
                  : t('bond.coverage.asOf', {
                      benchmark: benchmarkName(c.benchmarkId),
                      date: formatDate(c.coveredThrough),
                    })}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  // The panel outlives a reload of the valuation it drives, so a click on a
  // scenario does not unmount the table it was clicked in. What it needs (the
  // benchmark the rule reads) is read from the newest answer for this security.
  const rule =
    data !== null && data.securityId === security.id
      ? (data.lots[0]?.valuation.rateRule ?? null)
      : null;
  const scenarioBenchmark =
    rule !== null && rule.type !== 'FIXED' ? rule.benchmarkId : null;

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
              max={today}
              // The valuation refuses a day after today; a later date is
              // brought back to today rather than sent.
              onDateChange={(date) =>
                setPickedAsOf(YMD.test(date) && date > today ? today : date)
              }
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
      {rule !== null && scenarioBenchmark !== null && (
        <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-700">
          <SecurityBondScenarioPanel
            securityId={security.id}
            benchmarkId={scenarioBenchmark}
            inflation={rule.type === 'INFLATION_PLUS_MARGIN_AS_RATE'}
            currency={currency}
            asOf={asOf}
            selected={assume ? assume.value : null}
            onSelect={(value) =>
              setPicked(
                value === null
                  ? null
                  : {
                      securityId: security.id,
                      benchmarkId: scenarioBenchmark,
                      value,
                    },
              )
            }
          />
        </div>
      )}
    </Card>
  );
}
