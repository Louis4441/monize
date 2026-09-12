'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MonthGrid } from '@/components/ui/MonthGrid';
import { ReportError } from '@/components/reports/ReportError';
import { CalendarBanner, type CalendarCause } from '@/components/calendar/CalendarBanner';
import {
  CalendarDayCell,
  CalendarValueFigure,
} from '@/components/calendar/CalendarDayCell';
import {
  CalendarDayPanel,
  type CalendarDayValue,
} from '@/components/calendar/CalendarDayPanel';
import { CalendarToolbar } from '@/components/calendar/CalendarToolbar';
import { CALENDAR_DAY_CHIP_LIMIT } from '@/components/calendar/TransactionsCalendarView';
import {
  CALENDAR_MAX_ROWS,
  useInvestmentCalendarMonthData,
} from '@/hooks/useCalendarMonthData';
import { useInvestmentDailyValues } from '@/hooks/useInvestmentDailyValues';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import {
  dedupeInvestmentLegs,
  groupInvestmentCalendarRows,
  type CalendarAccount,
  type CalendarDayRows,
} from '@/lib/calendar-rows';
import { monthGridDays, monthOf, type WeekStart } from '@/lib/calendar-month';
import { preferredCurrency } from '@/lib/default-currency';
import { useViewMode } from '@/store/viewModeStore';
import type { Account, AccountType } from '@/types/account';
import type { InvestmentTransaction } from '@/types/investment';
import type { Transaction } from '@/types/transaction';

const LAYERS = ['transactions', 'values'] as const;

interface InvestmentCalendarViewProps {
  /** Every account the page holds, for the cash chips' colours. */
  accounts: readonly Account[];
  /** The selected brokerage accounts; empty means every investment account. */
  brokerageAccountIds: readonly string[];
  /** Their linked cash sleeves, as the page derives them. */
  cashAccountIds: readonly string[];
  weekStartsOn: WeekStart;
  /** The financial today: which month opens, and where the Values layer stops. */
  today: string;
  /** The single selected account's currency, or null for the reader's default. */
  displayCurrency?: string | null;
  onEditInvestment: (transaction: InvestmentTransaction) => void;
  onEditCashTransaction: (transaction: Transaction) => void;
  onCreateOnDay: (date: string) => void;
  /** Bumped by the page after a write, so the month refetches. */
  refreshKey?: number;
}

/**
 * The Investments page's month calendar.
 *
 * It stands in for the brokerage and cash registers, and for nothing else: the
 * summary, the allocation and the chart above it are untouched. A trade and the
 * cash leg that settles it are one chip (I5), and every figure -- a row's total,
 * a day's market value -- is the one the server sent for it (I1).
 */
export function InvestmentCalendarView({
  accounts,
  brokerageAccountIds,
  cashAccountIds,
  weekStartsOn,
  today,
  displayCurrency = null,
  onEditInvestment,
  onEditCashTransaction,
  onCreateOnDay,
  refreshKey = 0,
}: InvestmentCalendarViewProps) {
  const t = useTranslations('calendar');
  const monthLabelId = useId();
  const { layers, toggleLayer } = useViewMode('investments');
  const { defaultCurrency } = useExchangeRates();

  const [month, setMonth] = useState(() => monthOf(today));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const days = useMemo(() => monthGridDays(month, weekStartsOn), [month, weekStartsOn]);
  const gridStart = days[0];
  const gridEnd = days[days.length - 1];

  // The same resolution the portfolio chart makes: a foreign single-account
  // currency is asked for explicitly, and anything else is the reader's own
  // reporting currency, which is what the endpoint falls back to.
  const foreignCurrency =
    displayCurrency && displayCurrency !== defaultCurrency ? displayCurrency : null;
  const reportingCurrency = foreignCurrency ?? preferredCurrency(defaultCurrency);

  const data = useInvestmentCalendarMonthData(
    gridStart,
    gridEnd,
    brokerageAccountIds,
    cashAccountIds,
    refreshKey,
  );

  const valuesOn = layers.includes('values');
  const values = useInvestmentDailyValues({
    startDate: gridStart,
    endDate: gridEnd,
    today,
    accountIds: brokerageAccountIds,
    displayCurrency: foreignCurrency ?? undefined,
    enabled: valuesOn,
    refreshKey,
  });
  const valuesReady = valuesOn && !values.isStale;

  const accountsById = useMemo(() => {
    const map = new Map<string, CalendarAccount>();
    for (const account of accounts) {
      map.set(account.id, {
        id: account.id,
        accountType: account.accountType,
        linkedAccountId: account.linkedAccountId,
      });
    }
    return map;
  }, [accounts]);

  const byDay = useMemo(() => {
    if (!data.data || data.data.withheld) return new Map<string, CalendarDayRows>();
    const brokerageIds = new Set(data.data.brokerage.map((row) => row.id));
    return groupInvestmentCalendarRows({
      brokerage: data.data.brokerage,
      cash: dedupeInvestmentLegs(data.data.cash, brokerageIds),
      accountsById,
      today,
    });
  }, [data.data, accountsById, today]);

  /** Symbols for the securities this month traded, so a withheld value can name one. */
  const securityLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const row of data.data?.brokerage ?? []) {
      if (row.security?.id && row.security.symbol) labels.set(row.security.id, row.security.symbol);
    }
    return labels;
  }, [data.data]);

  const legend = useMemo(() => {
    const accountTypes = new Set<AccountType>();
    for (const rows of byDay.values()) {
      if (rows.investments.length > 0) accountTypes.add('INVESTMENT');
      for (const chip of rows.transactions) {
        accountTypes.add(accountsById.get(chip.transaction.accountId)?.accountType ?? 'OTHER');
      }
    }
    return [...accountTypes];
  }, [byDay, accountsById]);

  const causes = useMemo<CalendarCause[]>(() => {
    const found: CalendarCause[] = [];

    if (data.data?.withheld) {
      found.push({
        key: 'rowCap',
        message: t('banner.rowCap', { count: data.data.rowCount, limit: CALENDAR_MAX_ROWS }),
      });
    }

    if (!valuesOn) return found;

    const unpriced = new Set<string>();
    const pairs = new Set<string>();
    for (const point of values.byDay.values()) {
      if (point.pricesComplete === false) {
        for (const id of point.unpricedSecurityIds ?? []) unpriced.add(id);
      }
      if (point.fxComplete === false) {
        for (const pair of point.missingRatePairs ?? []) pairs.add(pair);
      }
    }

    if (unpriced.size > 0) {
      found.push({
        key: 'valuesUnpriced',
        message: t('banner.valuesUnpriced', {
          securities: [...unpriced].map((id) => securityLabels.get(id) ?? id).join(', '),
        }),
      });
    }
    if (pairs.size > 0) {
      found.push({
        key: 'valuesMissingRates',
        message: t('banner.valuesMissingRates', { pairs: [...pairs].sort().join(', ') }),
      });
    }

    return found;
  }, [data.data, valuesOn, values.byDay, securityLabels, t]);

  const selectedValue = useMemo<CalendarDayValue | undefined>(() => {
    if (!valuesReady || selectedDate === null) return undefined;
    const point = values.byDay.get(selectedDate);
    if (!point) return undefined;
    return { point, currencyCode: reportingCurrency, securityLabels };
  }, [valuesReady, selectedDate, values.byDay, reportingCurrency, securityLabels]);

  const isActionable = !data.isLoading && !data.isStale && data.error === null;

  if (data.error !== null && data.data === null) {
    return <ReportError message={t('errors.monthFailed')} onRetry={data.reload} />;
  }

  return (
    <div>
      <CalendarToolbar
        month={month}
        onMonthChange={(next) => {
          setMonth(next);
          setSelectedDate(null);
        }}
        today={today}
        monthLabelId={monthLabelId}
        availableLayers={LAYERS}
        activeLayers={layers}
        onToggleLayer={toggleLayer}
        legendAccountTypes={legend}
        legendHasScheduled={false}
      />

      <CalendarBanner causes={causes} />

      {data.error !== null && (
        <div className="mb-3">
          <ReportError message={t('errors.monthFailed')} onRetry={data.reload} />
        </div>
      )}

      {valuesOn && values.error !== null && (
        <div className="mb-3">
          <ReportError message={t('errors.valuesFailed')} onRetry={values.reload} />
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div
          className="min-w-0 flex-1"
          aria-busy={data.isLoading || (valuesOn && values.isLoading)}
          inert={!isActionable}
        >
          <MonthGrid
            month={month}
            weekStartsOn={weekStartsOn}
            today={today}
            selectedDate={selectedDate}
            onSelectDay={setSelectedDate}
            labelledBy={monthLabelId}
            renderDay={(day) => {
              const point = valuesReady ? values.byDay.get(day.date) : undefined;
              return (
                <CalendarDayCell
                  day={day}
                  rows={layers.includes('transactions') ? byDay.get(day.date) : undefined}
                  chipLimit={CALENDAR_DAY_CHIP_LIMIT}
                  onOpenDay={setSelectedDate}
                  onEditTransaction={onEditCashTransaction}
                  onEditInvestment={onEditInvestment}
                  figure={
                    point ? (
                      <CalendarValueFigure point={point} currencyCode={reportingCurrency} />
                    ) : undefined
                  }
                />
              );
            }}
          />
        </div>

        {selectedDate !== null && (
          <div className="lg:w-80 lg:shrink-0">
            <CalendarDayPanel
              date={selectedDate}
              rows={layers.includes('transactions') ? byDay.get(selectedDate) : undefined}
              value={selectedValue}
              onEditTransaction={onEditCashTransaction}
              onEditInvestment={onEditInvestment}
              createLabel={t('day.newInvestmentTransaction')}
              onCreateOnDay={onCreateOnDay}
              onClose={() => setSelectedDate(null)}
              categoryColorMap={EMPTY_CATEGORY_MAP}
              categoryIconMap={EMPTY_CATEGORY_MAP}
              categoryLabelMap={EMPTY_CATEGORY_LABELS}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Investments page holds no category maps: its cash register draws no
 * category pill, so an empty map is the honest answer rather than a lookup that
 * would be half-populated.
 */
const EMPTY_CATEGORY_MAP: ReadonlyMap<string, string | null> = new Map();
const EMPTY_CATEGORY_LABELS: ReadonlyMap<string, string> = new Map();
