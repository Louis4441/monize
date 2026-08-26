'use client';

import { useTranslations } from 'next-intl';
import {
  OverpaymentFrequency,
  ScenarioComparison,
  ScheduleFrequency,
  getPeriodsPerYear,
  overpaymentsPerYear,
  perPaymentExtraAmount,
} from '@/lib/loan-schedule';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { FREQUENCY_LABEL_KEY } from '@/components/accounts/loan-detail/loan-scenario-labels';

interface ComparisonSummaryCardsProps {
  comparison: ScenarioComparison;
  currencyCode: string;
  /** The scenario's recurring overpayment (amount at its cadence), when any. */
  recurringOverpayment?: { amount: number; frequency?: OverpaymentFrequency };
  /** The loan's own payment cadence, needed to place a recurring overpayment. */
  loanFrequency?: ScheduleFrequency;
  /** A fixed total monthly spend (budget mode): shown as the monthly payment. */
  fixedMonthlyPayment?: number;
}

/**
 * Baseline-versus-scenario outcome cards: the new payoff date, time saved,
 * interest saved, the resulting monthly payment, and the total extra principal
 * the scenario contributes.
 */
export function ComparisonSummaryCards({
  comparison,
  currencyCode,
  recurringOverpayment,
  loanFrequency,
  fixedMonthlyPayment,
}: ComparisonSummaryCardsProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const { scenario } = comparison;

  const newPayoffLabel = scenario.payoffDate
    ? formatChartDate(scenario.payoffDate, 'MMM yyyy')
    : t('loanDetail.comparison.beyondProjection');

  // Lower-installment scenarios keep the end date (no time saved); their headline
  // outcome is the smaller installment instead. Null means the schedules cannot
  // be compared at all (one stopped at the projection horizon), so there is no
  // installment drop to headline -- the time-saved card renders Unknown instead.
  const isLowerInstallment = (comparison.installmentReduction ?? 0) > 0.005;

  const opAmount = recurringOverpayment?.amount ?? 0;
  const opFrequency = recurringOverpayment?.frequency;
  // Presentation only. A cadence sparser than the loan's payments (e.g.
  // quarterly on a monthly loan) does not fall on every payment, so folding it
  // into "monthly payment" would misstate the regular outlay -- it shows as the
  // periodic overpayment note below instead. A denser or equal cadence is added
  // in as its per-payment AVERAGE (`perPaymentExtraAmount`); the schedule itself
  // applies each dated occurrence in full, so an individual row can carry more
  // or less than this figure.
  const isSparse =
    !!opFrequency &&
    !!loanFrequency &&
    overpaymentsPerYear(opFrequency) > 0 &&
    overpaymentsPerYear(opFrequency) < getPeriodsPerYear(loanFrequency);
  const perPaymentExtra =
    opAmount > 0 && !isSparse
      ? opFrequency && loanFrequency
        ? perPaymentExtraAmount(opAmount, opFrequency, loanFrequency)
        : opAmount
      : 0;

  // The resulting monthly outlay: a fixed budget shows that budget as-is;
  // for lower-installment the recomputed smaller installment; otherwise the
  // unchanged installment plus any per-payment extra.
  const monthlyPayment =
    fixedMonthlyPayment != null
      ? fixedMonthlyPayment
      : isLowerInstallment
        ? scenario.finalPaymentAmount
        : Math.round((scenario.finalPaymentAmount + perPaymentExtra) * 100) / 100;

  const overpaymentNote =
    fixedMonthlyPayment == null && !isLowerInstallment && opAmount > 0
      ? t('loanDetail.comparison.overpaymentAtFrequency', {
          frequency: t(FREQUENCY_LABEL_KEY[opFrequency ?? 'MONTHLY']),
          amount: formatCurrency(opAmount, currencyCode),
        })
      : undefined;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
      <Card
        label={t('loanDetail.comparison.newPayoff')}
        value={newPayoffLabel}
        valueClass="text-purple-600 dark:text-purple-400"
      />
      {isLowerInstallment ? (
        <Card
          label={t('loanDetail.comparison.newInstallment')}
          value={t('loanDetail.comparison.installmentDrop', {
            payment: formatCurrency(scenario.finalPaymentAmount, currencyCode),
            reduction: formatCurrency(comparison.installmentReduction ?? 0, currencyCode),
          })}
          valueClass="text-green-600 dark:text-green-400"
        />
      ) : (
        <Card
          label={t('loanDetail.comparison.timeSaved')}
          // Both figures are null when either schedule ran past the projection
          // horizon: a horizon's length minus a lifetime's is not time saved,
          // and "0 payments" would read as "the overpayment bought nothing".
          value={
            comparison.monthsSaved == null || comparison.paymentsSaved == null
              ? t('loanDetail.comparison.unknown')
              : comparison.monthsSaved > 0
                ? t('loanDetail.comparison.monthsSaved', { count: comparison.monthsSaved })
                : t('loanDetail.comparison.paymentsSaved', {
                    count: Math.max(comparison.paymentsSaved, 0),
                  })
          }
          valueClass="text-green-600 dark:text-green-400"
        />
      )}
      <Card
        label={t('loanDetail.comparison.interestSaved')}
        // A saving is unknown when either schedule ran past the projection
        // horizon, and unknown is not zero -- say so rather than print 0.00.
        value={
          comparison.interestSaved == null
            ? t('loanDetail.comparison.unknown')
            : formatCurrency(Math.max(comparison.interestSaved, 0), currencyCode)
        }
        valueClass="text-green-600 dark:text-green-400"
      />
      <Card
        label={t('loanDetail.comparison.monthlyPayment')}
        value={formatCurrency(monthlyPayment, currencyCode)}
        valueClass="text-gray-900 dark:text-gray-100"
        subvalue={overpaymentNote}
      />
      <Card
        label={t('loanDetail.comparison.totalExtraContributed')}
        value={formatCurrency(scenario.totalExtraPrincipal, currencyCode)}
        valueClass="text-blue-600 dark:text-blue-400"
      />
    </div>
  );
}

function Card({
  label,
  value,
  valueClass,
  subvalue,
}: {
  label: string;
  value: string;
  valueClass: string;
  subvalue?: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
      <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-bold ${valueClass}`}>{value}</div>
      {subvalue && (
        <div className="mt-1 text-xs font-medium text-green-600 dark:text-green-400">
          {subvalue}
        </div>
      )}
    </div>
  );
}
