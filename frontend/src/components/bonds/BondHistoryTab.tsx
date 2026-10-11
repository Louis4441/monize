'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Select } from '@/components/ui/Select';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { programLabel } from '@/components/securities/detail/bond-labels';
import { useChartMonthFormat } from '@/hooks/useChartMonthFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { CHART_SERIES, chartColors } from '@/lib/chart-colors';
import { getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import {
  BOND_OFFER_COUNTRY,
  buildHistoryPoints,
  isHttpUrl,
} from '@/lib/bond-offer';
import type { BondHistory, BondInstrumentSummary } from '@/types/bond';

interface BondHistoryTabProps {
  /** The product a link asked for (`?program=`); used when the catalog holds it. */
  initialProgram: string | null;
}

/** The catalog's products for the country, sorted, and the currency each issues in. */
function productsOf(instruments: readonly BondInstrumentSummary[]) {
  const currencies = new Map<string, string>();
  for (const i of instruments) {
    if (i.issuerCountryCode !== BOND_OFFER_COUNTRY) continue;
    if (!currencies.has(i.programCode)) currencies.set(i.programCode, i.currencyCode);
  }
  return [...currencies.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([programCode, currencyCode]) => ({ programCode, currencyCode }));
}

interface BondHistoryBodyProps {
  program: string;
  /** The currency the product issues in; null when the catalog does not say. */
  currency: string | null;
}

function BondHistoryBody({ program, currency }: BondHistoryBodyProps) {
  const t = useTranslations('bonds');
  const tSec = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();
  const formatChartMonth = useChartMonthFormat();
  const { formatCurrency, formatCurrencyAxis, formatNumber, formatPercentTrimmed } =
    useNumberFormat();

  const requestKey = `${BOND_OFFER_COUNTRY}|${program}`;
  const history = useReportData<BondHistory>(
    () => investmentsApi.getBondHistory(BOND_OFFER_COUNTRY, program),
    [requestKey],
    { requestKey },
  );
  // The payload belongs to the product it was asked for.
  const answer = useMemo(
    () =>
      history.data !== null && history.dataKey === requestKey
        ? (history.data.programs.find((p) => p.programCode === program) ?? {
            programCode: program,
            series: [],
            coverage: { from: null, to: null, missingMonths: [] },
          })
        : null,
    [history.data, history.dataKey, requestKey, program],
  );

  const points = useMemo(
    () => (answer === null ? [] : buildHistoryPoints(answer.series, answer.coverage)),
    [answer],
  );

  const unknown = (
    <span className="text-gray-500 dark:text-gray-400">{tSec('bond.unknown')}</span>
  );
  const rate = (fraction: string | null): ReactNode =>
    fraction === null ? unknown : formatPercentTrimmed(Number(fraction) * 100);
  const feeText = (amount: number) =>
    currency === null ? formatNumber(amount) : formatCurrency(amount, currency);
  const feeAxis = (amount: number) =>
    currency === null ? formatNumber(amount) : formatCurrencyAxis(amount, currency);
  const hasFee = points.some((p) => p.fee !== null);
  const missing = answer?.coverage.missingMonths ?? [];

  const renderBody = () => {
    if (history.error) {
      return (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            {getErrorMessage(history.error, t('history.loadFailed'))}
          </p>
          <Button variant="outline" size="sm" onClick={history.reload}>
            {t('history.retry')}
          </Button>
        </div>
      );
    }
    if (answer === null) {
      return (
        <div className="flex justify-center py-8">
          <LoadingSpinner text={t('history.loading')} />
        </div>
      );
    }
    if (answer.series.length === 0) {
      return <EmptyState title={t('history.empty')} />;
    }
    const { coverage } = answer;
    const rateName = t('history.rate');
    const addendName = t('history.addend');
    const feeName = t('history.fee');
    return (
      <div className="space-y-6">
        {coverage.from !== null && coverage.to !== null && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('history.coverage', {
              from: formatChartMonth(coverage.from),
              to: formatChartMonth(coverage.to),
            })}
          </p>
        )}

        <figure className="space-y-2">
          <figcaption className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('history.rateChartTitle')}
          </figcaption>
          <div role="img" aria-label={t('history.rateChartTitle')} className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={points} margin={{ left: 0, right: 8, top: 5, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis
                  dataKey="month"
                  tickFormatter={(m: string) => formatChartMonth(m)}
                  tick={{ fill: chartColors.axis, fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: chartColors.axis, fontSize: 11 }}
                  tickFormatter={(v: number) => formatPercentTrimmed(v)}
                  width="auto"
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  labelFormatter={(m) => formatChartMonth(String(m))}
                  formatter={(v) =>
                    typeof v === 'number' ? formatPercentTrimmed(v) : tSec('bond.unknown')
                  }
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="rate"
                  name={rateName}
                  stroke={chartColors.primary}
                  strokeWidth={2}
                  dot
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="addend"
                  name={addendName}
                  stroke={CHART_SERIES[1]}
                  strokeWidth={2}
                  dot
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </figure>

        {hasFee && (
          <figure className="space-y-2">
            <figcaption className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('history.feeChartTitle')}
            </figcaption>
            <div role="img" aria-label={t('history.feeChartTitle')} className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart data={points} margin={{ left: 0, right: 8, top: 5, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                  <XAxis
                    dataKey="month"
                    tickFormatter={(m: string) => formatChartMonth(m)}
                    tick={{ fill: chartColors.axis, fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: chartColors.axis, fontSize: 11 }}
                    tickFormatter={feeAxis}
                    width="auto"
                    domain={[0, 'auto']}
                  />
                  <Tooltip
                    labelFormatter={(m) => formatChartMonth(String(m))}
                    formatter={(v) =>
                      typeof v === 'number' ? feeText(v) : tSec('bond.unknown')
                    }
                  />
                  <Line
                    type="stepAfter"
                    dataKey="fee"
                    name={feeName}
                    stroke={CHART_SERIES[2]}
                    strokeWidth={2}
                    dot
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </figure>
        )}

        <div className="space-y-1">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('history.gapsNote')}</p>
          {missing.length > 0 ? (
            <div role="note">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('history.missingTitle', { count: missing.length })}
              </h4>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
                {missing.map((month) => (
                  <li key={month}>{formatChartMonth(month)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('history.noMissing')}</p>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('history.tableTitle')}
          </h3>
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <Th>{t('history.columns.series')}</Th>
                  <Th>{t('history.columns.saleWindow')}</Th>
                  <Th align="right">{t('history.columns.rate')}</Th>
                  <Th align="right">{t('history.columns.addend')}</Th>
                  <Th align="right">{t('history.columns.fee')}</Th>
                  <Th>{t('history.columns.floor')}</Th>
                  <Th align="right">{t('history.columns.version')}</Th>
                  <Th>{t('history.columns.source')}</Th>
                </tr>
              </thead>
              <tbody className={TABLE_BODY_CLASS}>
                {answer.series.map((s) => (
                  <tr key={s.seriesCode}>
                    <Td className="whitespace-nowrap font-medium">{s.seriesCode}</Td>
                    <Td className="whitespace-nowrap">
                      {s.saleWindow === null
                        ? tSec('bond.unknown')
                        : t('offer.saleWindowValue', {
                            from: formatDate(s.saleWindow.from),
                            to: formatDate(s.saleWindow.to),
                          })}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {rate(s.firstPeriodRate ?? s.annualRate)}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {s.addend === null ? t('history.none') : rate(s.addend)}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {s.fee === null ? t('history.none') : feeText(Number(s.fee))}
                    </Td>
                    <Td>
                      {s.proceedsFloor === null
                        ? t('history.none')
                        : t(`history.floor.${s.proceedsFloor}`)}
                    </Td>
                    <Td align="right">{s.termsVersion}</Td>
                    <Td className="whitespace-nowrap">
                      {isHttpUrl(s.termsSource.url) ? (
                        <a
                          href={s.termsSource.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {tSec('bond.termsSource', { document: s.termsSource.document })}
                        </a>
                      ) : (
                        tSec('bond.termsSource', { document: s.termsSource.document })
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  return renderBody();
}

/**
 * How the terms of one product changed from one sale month to the next (spec
 * `bond-offer-and-history.md` 3 and 5): a line chart of the first-period (or
 * annual) rate and the margin, a step chart of the early redemption fee, the
 * months the catalog lacks, and a table of every stored series.
 *
 * A month with no stored series is a null point, so the line breaks there
 * rather than running across it, and the month is listed under the chart. The
 * payload is kept with the product it answers; a failed request is said to be
 * one, never drawn as an empty history.
 */
export function BondHistoryTab({ initialProgram }: BondHistoryTabProps) {
  const t = useTranslations('bonds');
  const tSec = useTranslations('securityDetail');
  const [picked, setPicked] = useState<string | null>(null);
  const catalog = useReportData<BondInstrumentSummary[]>(
    () => investmentsApi.listBondInstruments(),
    [],
  );
  const products = useMemo(
    () => (catalog.data === null ? [] : productsOf(catalog.data)),
    [catalog.data],
  );
  const program =
    [picked, initialProgram].find(
      (p): p is string => p !== null && products.some((x) => x.programCode === p),
    ) ??
    products[0]?.programCode ??
    null;
  const currency = products.find((p) => p.programCode === program)?.currencyCode ?? null;

  if (catalog.error && catalog.data === null) {
    return (
      <div role="alert" className="space-y-3">
        <p className="text-sm text-red-600 dark:text-red-400">
          {getErrorMessage(catalog.error, t('history.loadFailed'))}
        </p>
        <Button variant="outline" size="sm" onClick={catalog.reload}>
          {t('history.retry')}
        </Button>
      </div>
    );
  }
  if (catalog.data === null) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner text={t('history.loading')} />
      </div>
    );
  }
  if (program === null) {
    return <EmptyState title={t('history.noProducts')} />;
  }

  return (
    <div className="space-y-4">
      <div className="w-full sm:w-64">
        <Select
          label={t('history.product')}
          value={program}
          onChange={(e) => setPicked(e.target.value)}
          options={products.map((p) => ({
            value: p.programCode,
            label: programLabel(tSec, p.programCode),
          }))}
        />
      </div>
      <BondHistoryBody key={program} program={program} currency={currency} />
    </div>
  );
}
