import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { PayeeSeasonalityPanel } from './PayeeSeasonalityPanel';
import type { DisplayCurrencyStrategy } from '@/components/transactions/widget-shared';
import type { MonthlyTotal } from '@/types/transaction';

const strategy: DisplayCurrencyStrategy = {
  displayCurrency: 'CAD',
  toDisplay: (amount) => amount,
};

function month(key: string, total: number): MonthlyTotal {
  return { month: key, total, count: 1 };
}

/** Two even years, so a December spike can be added on top of a flat baseline. */
function evenTwoYears(amount = -100): MonthlyTotal[] {
  return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap((m) => [
    month(`2025-${String(m).padStart(2, '0')}`, amount),
    month(`2026-${String(m).padStart(2, '0')}`, amount),
  ]);
}

function renderPanel(monthly: MonthlyTotal[], isLoading = false) {
  render(
    <PayeeSeasonalityPanel
      monthly={monthly}
      currencyStrategy={strategy}
      isLoading={isLoading}
    />,
  );
}

describe('PayeeSeasonalityPanel', () => {
  it('shows the empty state when there is nothing to break down', () => {
    renderPanel([]);
    expect(screen.getByText('No spending to break down by month yet')).toBeInTheDocument();
  });

  it('names the peak month when the spending concentrates', () => {
    renderPanel([...evenTwoYears(), month('2025-12', -900), month('2026-12', -900)]);
    expect(screen.getByText(/Spending concentrates in Dec/)).toBeInTheDocument();
  });

  it('says so when spending is spread evenly', () => {
    renderPanel([...evenTwoYears(), month('2025-12', -100), month('2026-12', -100)]);
    expect(
      screen.getByText('Spending is spread evenly across the year.'),
    ).toBeInTheDocument();
  });

  it('asks for more history rather than calling one year seasonal', () => {
    renderPanel([month('2026-01', -10), month('2026-12', -900)]);
    expect(screen.getByText(/At least 2 years of history/)).toBeInTheDocument();
    // And it still draws what it has.
    expect(screen.getByText('Dec')).toBeInTheDocument();
  });

  it('always renders all twelve calendar months, in order', () => {
    renderPanel([month('2025-05', -50), month('2026-05', -50)]);
    const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('shows a skeleton while loading', () => {
    renderPanel([], true);
    expect(screen.queryByText('No spending to break down by month yet')).toBeNull();
  });
});
