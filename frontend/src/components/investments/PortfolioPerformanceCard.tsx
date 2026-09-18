'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePortfolioPeriodResults } from '@/hooks/usePortfolioPeriodResults';
import { PerformancePeriodsCard } from '@/components/ui/PerformancePeriodsCard';
import { PORTFOLIO_PERIOD_PRESETS } from '@/types/net-worth';

interface PortfolioPerformanceCardProps {
  /** The page's account filter, as it goes to the chart beside this card. */
  accountIds?: string[];
  /** Report in this currency instead of the reader's preferred one. */
  displayCurrency?: string | null;
  /** Bumped by the page after a write, so the figures follow the ledger. */
  reloadKey?: number;
}

/**
 * What the portfolio earned over each trailing period, deposits taken out.
 *
 * Every figure comes from `GET /net-worth/investments-period-results` and
 * nothing here subtracts or divides: a change derived from the value series
 * counts the reader's own contributions as performance, which is the defect
 * INV-PORTRESULT-001 exists to stop (issue #1392). The percentage is the
 * server's `returnPercent` -- over `investmentResult`, never over the value
 * change -- and the amount beneath it is that result in the currency the
 * server reports in.
 *
 * A period the server could not report reads "n/a", the same answer the
 * security card gives for a window its history does not cover, and for the same
 * reason: a zero would be a claim that nothing happened. A request that has not
 * answered yet, or failed, leaves every period unknown rather than zero.
 */
export function PortfolioPerformanceCard({
  accountIds,
  displayCurrency,
  reloadKey,
}: PortfolioPerformanceCardProps) {
  const t = useTranslations('investments');
  const { formatCurrency, formatSignedPercent, defaultCurrency } =
    useNumberFormat();
  const { results } = usePortfolioPeriodResults({
    periods: PORTFOLIO_PERIOD_PRESETS.join(','),
    accountIds:
      accountIds && accountIds.length > 0 ? accountIds.join(',') : undefined,
    displayCurrency: displayCurrency ?? undefined,
    reloadKey,
  });

  const entries = useMemo(() => {
    const currency = results?.currency;
    // The chart's convention for a figure reported in a currency that is not
    // the reader's own: the code is named, so nobody reads it as their money.
    const money = (value: number) => {
      const amount = formatCurrency(value, currency);
      const signed = `${value >= 0 ? '+' : ''}${amount}`;
      return currency && currency !== defaultCurrency
        ? `${signed} ${currency}`
        : signed;
    };

    return PORTFOLIO_PERIOD_PRESETS.map((preset) => {
      const period = results?.periods?.[preset];
      // Each figure is judged on its own: a period whose money is known and
      // whose ratio is not (a portfolio that started the window at nothing)
      // still has an amount worth reading.
      const percent = period?.returnPercent ?? null;
      const result = period?.investmentResult ?? null;
      return {
        period: preset,
        label: t(`portfolioPerformance.periods.${preset}` as Parameters<typeof t>[0]),
        primary: percent === null ? null : formatSignedPercent(percent),
        primaryValue: percent,
        secondary: result === null ? null : money(result),
        secondaryValue: result,
      };
    });
  }, [results, t, formatCurrency, formatSignedPercent, defaultCurrency]);

  return (
    <PerformancePeriodsCard
      title={t('portfolioPerformance.title')}
      subtitle={t('portfolioPerformance.subtitle')}
      entries={entries}
      unavailableLabel={t('portfolioPerformance.unavailable')}
      emptyMessage={t('portfolioPerformance.empty')}
      footnote={t('portfolioPerformance.footnote')}
      data-testid="portfolio-performance"
    />
  );
}
