import { describe, it, expect } from 'vitest';
import { createScenarioLabels } from './loan-scenario-labels';
import type { LoanScenario } from '@/types/loan-scenario';
import type { ScenarioComparison } from '@/lib/loan-schedule';

const labels = createScenarioLabels({
  t: (key, values) => `${key}${values ? ':' + Object.values(values).join(',') : ''}`,
  formatCurrency: (amount) => `$${amount.toFixed(2)}`,
  formatChartDate: (date) => date.slice(0, 7),
  currencyCode: 'PLN',
});

const scenario = {
  id: 's1',
  name: 'Extra 200',
  recurringExtraAmount: 200,
  lumpSums: [{ date: '2026-06-01', amount: 5000 }],
} as LoanScenario;

const comparison = {
  scenario: { payoffDate: '2040-06-15', finalPaymentAmount: 500 },
  paymentsSaved: 24,
  monthsSaved: 24,
  interestSaved: 15000,
  installmentReduction: 0,
} as unknown as ScenarioComparison;

describe('createScenarioLabels', () => {
  it('builds the comparison table exactly as the panel displays it', () => {
    const table = labels.comparisonTable([scenario], new Map([['s1', comparison]]));

    expect(table.headers).toHaveLength(6);
    expect(table.rows).toEqual([
      [
        'Extra 200',
        '$200.00',
        'loanDetail.scenarios.recurringSummary:$200.00 + loanDetail.scenarios.lumpSumSummary:1',
        '2040-06',
        'loanDetail.comparison.monthsSaved:24',
        '$15000.00',
      ],
    ]);
  });

  it('renders em dashes for scenarios without a projectable comparison', () => {
    const table = labels.comparisonTable([scenario], new Map([['s1', null]]));
    expect(table.rows[0].slice(3)).toEqual(['—', '—', '—']);
  });

  it('reflects a non-monthly cadence in the overpayment label and summary', () => {
    const quarterly = {
      id: 's2',
      name: 'Quarterly 300',
      recurringExtraAmount: 300,
      recurringExtraFrequency: 'QUARTERLY',
      lumpSums: [],
    } as unknown as LoanScenario;

    expect(labels.overpaymentLabel(quarterly)).toBe(
      'loanDetail.scenarios.overpaymentWithFrequency:$300.00,loanDetail.simulator.frequencyQuarterly',
    );
    expect(labels.describeScenario(quarterly)).toBe(
      'loanDetail.scenarios.overpaymentWithFrequency:$300.00,loanDetail.simulator.frequencyQuarterly',
    );
  });

  it('renders an em dash for a saving that is unknown', () => {
    // A schedule that stopped at the projection horizon has no lifetime figure
    // to compare, so the table shows the same em dash as a missing comparison
    // rather than "0 payments" or "$0.00".
    const incomparable = {
      scenario: { payoffDate: null, finalPaymentAmount: 500 },
      paymentsSaved: null,
      monthsSaved: null,
      interestSaved: null,
      installmentReduction: 0,
    } as unknown as ScenarioComparison;

    expect(labels.timeSavedLabel(incomparable)).toBe('\u2014');
    expect(labels.interestSavedLabel(incomparable)).toBe('\u2014');
    expect(labels.payoffLabel(incomparable)).toBe(
      'loanDetail.comparison.beyondProjection',
    );
  });

  it('still reports a lower installment when the schedules cannot be compared', () => {
    // installmentReduction is a property of each schedule on its own, so the
    // lower-installment headline survives a truncated comparison.
    const lowered = {
      scenario: { payoffDate: null, finalPaymentAmount: 400 },
      paymentsSaved: null,
      monthsSaved: null,
      interestSaved: null,
      installmentReduction: 100,
    } as unknown as ScenarioComparison;

    expect(labels.timeSavedLabel(lowered)).toBe(
      'loanDetail.comparison.installmentDrop:$400.00,$100.00',
    );
  });
});
