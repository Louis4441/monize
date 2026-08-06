import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { CategoryScheduledPanel } from './CategoryScheduledPanel';
import type { NextScheduledItem } from '@/lib/scheduled-utils';

const items: NextScheduledItem[] = [
  { date: '2026-08-15', amount: -45.5, currencyCode: 'CAD', payeeName: 'Netflix' },
  { date: '2026-08-20', amount: 2000, currencyCode: 'CAD', payeeName: null },
];

function renderPanel(list: NextScheduledItem[] = items, isLoading = false) {
  return render(<CategoryScheduledPanel items={list} isLoading={isLoading} />);
}

describe('CategoryScheduledPanel', () => {
  it('titles the panel', () => {
    renderPanel();
    expect(screen.getByText('Upcoming Scheduled')).toBeInTheDocument();
    expect(screen.getByText('Bills and deposits in this category')).toBeInTheDocument();
  });

  it('lists each schedule with payee, date and amount', () => {
    renderPanel();
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    // The date is formatted, not the raw ISO string.
    expect(screen.queryByText('2026-08-15')).toBeNull();
    expect(screen.getByText(/45\.50/)).toBeInTheDocument();
  });

  it('colours an outgoing bill red and an incoming deposit green', () => {
    renderPanel();
    expect(screen.getByText(/45\.50/).className).toContain('text-red-600');
    expect(screen.getByText(/2,000\.00/).className).toContain('text-green-600');
  });

  it('falls back to "No payee" for a schedule without one', () => {
    renderPanel();
    expect(screen.getByText('No payee')).toBeInTheDocument();
  });

  it('says when nothing is scheduled', () => {
    renderPanel([]);
    expect(screen.getByText('Nothing scheduled in this category')).toBeInTheDocument();
  });

  it('shows a skeleton while loading, not the empty state', () => {
    const { container } = renderPanel([], true);
    expect(screen.queryByText('Nothing scheduled in this category')).toBeNull();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });
});
