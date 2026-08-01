import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { GemSignalHistoryTable } from './GemSignalHistoryTable';
import { gemAssets, gemHistory } from '@/test/gem-fixtures';

const symbolByRole = new Map(gemAssets.map((asset) => [asset.role, asset.symbol]));

describe('GemSignalHistoryTable', () => {
  it('lists evaluations newest first with a momentum column per asset', () => {
    render(<GemSignalHistoryTable history={gemHistory()} symbolByRole={symbolByRole} lookbackMonths={12} />);

    const table = screen.getByRole('table');
    for (const symbol of ['SPY', 'EWA', 'EMIM', 'IEF']) {
      // Prefix match: the header also carries its role-description tooltip.
      expect(
        within(table).getByRole('columnheader', {
          name: new RegExp(`^${symbol}`),
        }),
      ).toBeInTheDocument();
    }
    const firstRow = within(table).getAllByRole('row')[1];
    expect(within(firstRow).getByText('+29.87%')).toBeInTheDocument();
    expect(within(firstRow).getByText('Switch')).toBeInTheDocument();
  });

  it('falls back to the role name when a column has no ticker', () => {
    render(
      <GemSignalHistoryTable
        history={gemHistory()}
        symbolByRole={new Map([['SAFE', null]])}
        lookbackMonths={12}
      />,
    );
    // The header carries a tooltip explaining the role, so its accessible
    // name is the ticker (or role name) plus that description.
    expect(
      screen.getByRole('columnheader', { name: /^Safe asset/ }),
    ).toBeInTheDocument();
  });

  it('distinguishes done, pending and nothing-to-do rows', () => {
    render(<GemSignalHistoryTable history={gemHistory()} symbolByRole={symbolByRole} lookbackMonths={12} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Pending')).toBeInTheDocument();
    expect(within(table).getByText('Done')).toBeInTheDocument();
    expect(within(table).getByText('Nothing to do')).toBeInTheDocument();
    expect(within(table).getByText('No change')).toBeInTheDocument();
  });

  it('expands a row to the full evaluation detail and collapses it again', () => {
    render(<GemSignalHistoryTable history={gemHistory()} symbolByRole={symbolByRole} lookbackMonths={12} />);
    const table = screen.getByRole('table');
    const toggle = within(table).getAllByRole('button', { name: /Show evaluation detail/ })[0];

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(table).getByText('State')).toBeInTheDocument();
    expect(within(table).getByText('RISK-ON')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers the full history when rows are trimmed', () => {
    const onShowAll = vi.fn();
    render(
      <GemSignalHistoryTable
        history={gemHistory()}
        limit={2}
        onShowAll={onShowAll}
        symbolByRole={symbolByRole}
        lookbackMonths={12}
      />,
    );
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'See full history (3)' }));
    expect(onShowAll).toHaveBeenCalledOnce();
  });

  it('hides the full-history link when nothing is trimmed', () => {
    render(
      <GemSignalHistoryTable
        history={gemHistory()}
        limit={5}
        onShowAll={vi.fn()}
        symbolByRole={symbolByRole}
        lookbackMonths={12}
      />,
    );
    expect(screen.queryByRole('button', { name: /See full history/ })).not.toBeInTheDocument();
  });

  it('renders an empty state before the first evaluation', () => {
    render(<GemSignalHistoryTable history={[]} symbolByRole={symbolByRole} lookbackMonths={12} />);
    expect(screen.getByText('No evaluations yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a mobile list with the same rows', () => {
    render(<GemSignalHistoryTable history={gemHistory()} symbolByRole={symbolByRole} lookbackMonths={12} />);
    const listItems = screen.getAllByRole('listitem');
    expect(listItems).toHaveLength(3);
    const mobileToggle = within(listItems[0]).getByRole('button');
    fireEvent.click(mobileToggle);
    expect(mobileToggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks an unknown winner and unknown momentum instead of zero', () => {
    render(
      <GemSignalHistoryTable
        history={[
          {
            ...gemHistory()[0],
            winner: null,
            momentum: { US_EQUITY: null, EX_US_EQUITY: null, EM_EQUITY: null, SAFE: null },
          },
        ]}
        symbolByRole={symbolByRole}
        lookbackMonths={12}
      />,
    );
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(1);
  });
});
