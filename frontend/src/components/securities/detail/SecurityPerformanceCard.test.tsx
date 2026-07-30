import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityPerformanceCard } from './SecurityPerformanceCard';
import type { SecurityPricePoint } from '@/lib/security-detail';

/**
 * Periods are measured against the real clock (`periodStartDate` defaults to
 * `new Date()`), so fixtures are dated relative to today rather than pinned --
 * a hard-coded 2024 series would drift out of every window as time passes.
 */
const TODAY = new Date();

function isoDaysAgo(days: number): string {
  const date = new Date(TODAY);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

/** Oldest-first series, as the card documents its input. */
function series(
  points: readonly { daysAgo: number; close: number; adjusted?: number }[],
): SecurityPricePoint[] {
  return points
    .map((point) => ({
      date: isoDaysAgo(point.daysAgo),
      close: point.close,
      totalReturnClose: point.adjusted,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

describe('SecurityPerformanceCard', () => {
  it('reports the periods the history covers', () => {
    render(
      <SecurityPerformanceCard
        prices={series([
          { daysAgo: 40, close: 100 },
          { daysAgo: 0, close: 110 },
        ])}
      />,
    );

    expect(screen.getByText('Security performance')).toBeInTheDocument();
    // 1M reaches back 30 days, so the 40-day-old point is its baseline: +10%.
    expect(screen.getByText('+10.00%')).toBeInTheDocument();
  });

  it('says n/a for a period the history does not reach, rather than 0%', () => {
    // The distinction the card exists to make: a zero here would be a statement
    // about the security's performance instead of about our data.
    render(
      <SecurityPerformanceCard
        prices={series([
          { daysAgo: 40, close: 100 },
          { daysAgo: 0, close: 110 },
        ])}
      />,
    );

    // 3M, YTD, 1Y, 3Y and 5Y all start before the oldest point. YTD is the one
    // that depends on the date the test runs, so this counts at least four.
    expect(screen.getAllByText('n/a').length).toBeGreaterThanOrEqual(4);
  });

  it('states that dividends are included when an adjusted series exists', () => {
    render(
      <SecurityPerformanceCard
        prices={series([
          { daysAgo: 40, close: 100, adjusted: 97 },
          { daysAgo: 0, close: 110, adjusted: 110 },
        ])}
      />,
    );

    expect(screen.getByText('Includes dividends')).toBeInTheDocument();
    expect(screen.queryByText('Excludes dividends')).not.toBeInTheDocument();
  });

  it('warns that dividends are excluded when the provider supplies no adjusted close', () => {
    // MSN supplies none. A distributing fund then looks worse than it was by its
    // whole yield, which the card has to say rather than leave to be discovered.
    render(
      <SecurityPerformanceCard
        prices={series([
          { daysAgo: 40, close: 100 },
          { daysAgo: 0, close: 110 },
        ])}
      />,
    );

    expect(screen.getByText('Excludes dividends')).toBeInTheDocument();
  });

  it('shows the empty state, and no dividend caption, without enough history', () => {
    render(<SecurityPerformanceCard prices={series([{ daysAgo: 0, close: 110 }])} />);

    expect(
      screen.getByText('Not enough price history to measure a return yet.'),
    ).toBeInTheDocument();
    // A caption about what the figures include, with no figures, is noise.
    expect(screen.queryByText('Includes dividends')).not.toBeInTheDocument();
    expect(screen.queryByText('Excludes dividends')).not.toBeInTheDocument();
  });

  it('separates the security\'s return from the holder\'s', () => {
    // Readers take any "Performance" heading on a page about their own holding to
    // mean their own return; the subtitle is what stops that misreading.
    render(<SecurityPerformanceCard prices={series([{ daysAgo: 0, close: 110 }])} />);

    expect(screen.getByText(/whether or not you held it/)).toBeInTheDocument();
  });
});
