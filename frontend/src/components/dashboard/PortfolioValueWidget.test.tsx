import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Account } from '@/types/account';
import { PortfolioValueWidget } from './PortfolioValueWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

const configState = { current: { range: '1y', accountIds: [] as string[] } };
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: configState.current, updateConfig: vi.fn() }),
}));
vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => () => 'Jan 2026',
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'USD' }),
}));

const getInvestmentsMonthly = vi.fn();
const getInvestmentsDaily = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsMonthly: (...a: unknown[]) => getInvestmentsMonthly(...a),
    getInvestmentsDaily: (...a: unknown[]) => getInvestmentsDaily(...a),
  },
}));

const getPortfolioSummary = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...a: unknown[]) => getPortfolioSummary(...a),
  },
}));

const triggerManualRefresh = vi.fn();
vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: () => ({ isRefreshing: false, triggerManualRefresh }),
}));

const investmentAccount = { id: 'i1', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', name: 'Brokerage' } as Account;

/** Answer every media query as a viewport of this width. */
function viewport(width: number) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });
}

async function renderWidget() {
  await act(async () => {
    render(<PortfolioValueWidget accounts={[investmentAccount]} isLoading={false} />);
  });
}

describe('PortfolioValueWidget', () => {
  beforeEach(() => {
    getInvestmentsMonthly.mockReset();
    getInvestmentsDaily.mockReset();
    getPortfolioSummary.mockReset();
    getPortfolioSummary.mockResolvedValue({ totalPortfolioValue: 12345, holdings: [] });
    triggerManualRefresh.mockReset();
    configState.current = { range: '1y', accountIds: [] };
  });

  it('renders the area chart and the Total Portfolio Value from the summary for long ranges', async () => {
    getInvestmentsMonthly.mockResolvedValue([
      { month: '2026-05', value: 9000 },
      { month: '2026-06', value: 10000 },
    ]);
    await renderWidget();
    expect(screen.getByText('Portfolio Value over Time')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
    expect(getInvestmentsMonthly).toHaveBeenCalled();
    expect(getInvestmentsDaily).not.toHaveBeenCalled();
    // Header shows the live summary total (same value as the Investments page),
    // not the last point of the historical series.
    expect(screen.getByText('$12345')).toBeInTheDocument();
    expect(screen.queryByText('$10000')).not.toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('uses daily data for short ranges', async () => {
    configState.current = { range: '3m', accountIds: [] };
    getInvestmentsDaily.mockResolvedValue([{ date: '2026-07-01', value: 5000 }]);
    await renderWidget();
    expect(getInvestmentsDaily).toHaveBeenCalled();
    expect(getInvestmentsMonthly).not.toHaveBeenCalled();
  });

  it('shows the empty state with no history', async () => {
    getInvestmentsMonthly.mockResolvedValue([]);
    await renderWidget();
    expect(screen.getByText('No investment history to show yet.')).toBeInTheDocument();
  });

  it('refreshes prices when the refresh button is clicked', async () => {
    getInvestmentsMonthly.mockResolvedValue([{ month: '2026-06', value: 10000 }]);
    await renderWidget();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Refresh current value'));
    });
    expect(triggerManualRefresh).toHaveBeenCalledTimes(1);
    // No account filter -> refresh every eligible security (undefined scope).
    expect(triggerManualRefresh).toHaveBeenCalledWith(undefined);
  });

  it('shows the move over the window in money and percent', async () => {
    getInvestmentsMonthly.mockResolvedValue([
      { month: '2026-05', value: 8000 },
      { month: '2026-06', value: 10000 },
    ]);
    await renderWidget();
    // 1Y measures from the first point drawn, so 8000 -> 10000 is +2000 (+25%).
    expect(screen.getByTestId('portfolio-period-change')).toHaveTextContent(
      '+$2000(+25.0%)',
    );
  });

  it('keeps the window and the refresh on the title line, figures on the card\'s own edge', async () => {
    // A widget header is one line for what the widget IS and its controls; the
    // value and its move take a row of the card body, right-aligned on one
    // edge so they read as a figure and its change rather than two numbers --
    // and that edge is the card's, not the one where the settings gear starts.
    viewport(1280);
    getPortfolioSummary.mockResolvedValue({ totalPortfolioValue: 10000, holdings: [] });
    getInvestmentsMonthly.mockResolvedValue([
      { month: '2026-05', value: 8000 },
      { month: '2026-06', value: 10000 },
    ]);
    await renderWidget();

    const change = screen.getByTestId('portfolio-period-change');
    const value = screen.getByText('$10000');
    const range = screen.getByText('1Y');
    const refresh = screen.getByLabelText('Refresh current value');
    const gear = screen.getByLabelText('Configure Portfolio Value over Time');

    // One column for the two figures, aligned on their right edges, in a row of
    // the body rather than in the header beside the gear.
    const figures = value.parentElement!;
    expect(change.parentElement).toBe(figures);
    expect(figures.className).toContain('flex-col');
    expect(figures.className).toContain('items-end');
    const figuresRow = screen.getByTestId('portfolio-figures');
    expect(figuresRow).toContainElement(figures);
    expect(figuresRow.className).toContain('justify-end');
    expect(figuresRow).not.toContainElement(gear);
    // Smaller than the value it sits under.
    expect(change.className).toContain('text-xs');
    expect(value.className).toContain('text-sm');

    // On a desktop the control that reprices the chart sits on the title's
    // line, to the LEFT of the window it acts on.
    expect(figuresRow).not.toContainElement(refresh);
    expect(refresh.compareDocumentPosition(range)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(range.compareDocumentPosition(figuresRow)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // The gear keeps the top of the header, whatever the header-right holds.
    expect(gear.className).toContain('self-start');
  });

  it('moves the refresh control beside the value on a phone', async () => {
    // A phone title line holds the window and the gear and nothing else, so
    // the refresh control rides on the figures' row instead -- one control, in
    // one place, never a second copy hidden at the other breakpoint.
    viewport(400);
    getPortfolioSummary.mockResolvedValue({ totalPortfolioValue: 10000, holdings: [] });
    getInvestmentsMonthly.mockResolvedValue([{ month: '2026-06', value: 10000 }]);
    await renderWidget();

    const refresh = screen.getByLabelText('Refresh current value');
    const value = screen.getByText('$10000');
    const figuresRow = screen.getByTestId('portfolio-figures');

    expect(screen.getAllByLabelText('Refresh current value')).toHaveLength(1);
    expect(figuresRow).toContainElement(refresh);
    // To the left of the figure it refreshes.
    expect(refresh.compareDocumentPosition(value)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows no period change while the series is empty', async () => {
    // An unknown baseline is not a flat market: nothing is printed rather than
    // a change of zero.
    getInvestmentsMonthly.mockResolvedValue([]);
    await renderWidget();
    expect(screen.queryByTestId('portfolio-period-change')).toBeNull();
  });

  it('measures the MTD change from the close before the window', async () => {
    configState.current = { range: 'mtd', accountIds: [] };
    getInvestmentsDaily.mockImplementation((params: { endDate?: string }) =>
      // The baseline lookup asks for the days before the window; the chart's own
      // request carries the window itself.
      Promise.resolve(
        params.endDate === '2026-06-30'
          ? [{ date: '2026-06-30', value: 9000 }]
          : [
              { date: '2026-07-01', value: 9500 },
              { date: '2026-07-02', value: 9900 },
            ],
      ),
    );
    await renderWidget();
    // 9900 against the 30 June close of 9000, not against the 1 July point.
    expect(screen.getByTestId('portfolio-period-change')).toHaveTextContent(
      '+$900(+10.0%)',
    );
  });

  it('scopes the refresh to the shown holdings when an account filter is active', async () => {
    configState.current = { range: '1y', accountIds: ['i1'] };
    getInvestmentsMonthly.mockResolvedValue([{ month: '2026-06', value: 10000 }]);
    getPortfolioSummary.mockResolvedValue({
      totalPortfolioValue: 5000,
      holdings: [{ securityId: 's1' }, { securityId: 's2' }, { securityId: 's1' }],
    });
    await renderWidget();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Refresh current value'));
    });
    expect(triggerManualRefresh).toHaveBeenCalledWith(['s1', 's2']);
  });
});
