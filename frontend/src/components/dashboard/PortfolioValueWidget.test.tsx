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
const getInvestmentsPeriodResult = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsMonthly: (...a: unknown[]) => getInvestmentsMonthly(...a),
    getInvestmentsDaily: (...a: unknown[]) => getInvestmentsDaily(...a),
    getInvestmentsPeriodResult: (...a: unknown[]) =>
      getInvestmentsPeriodResult(...a),
  },
}));

/**
 * A period result as the server sends it. The defaults are a window in which
 * nothing happened; each test overrides only the figures it is about.
 */
function periodResult(overrides: Record<string, unknown> = {}) {
  return {
    currency: 'USD',
    startDate: '2026-01-02',
    endDate: '2026-06-30',
    startValue: 10000,
    endValue: 10000,
    valueChange: 0,
    netExternalFlows: 0,
    knownFlowSubtotal: 0,
    investmentResult: 0,
    returnPercent: 0,
    returnMethod: 'simple' as const,
    complete: true,
    reasons: [] as string[],
    missingRatePairs: [],
    unpricedSecurityIds: [],
    unknownCashAccountIds: [],
    ...overrides,
  };
}

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
    getInvestmentsPeriodResult.mockReset();
    getInvestmentsPeriodResult.mockResolvedValue(periodResult());
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

  it('shows the investment result over the window, not the value change', async () => {
    // The issue's reproduction (#1392): two deposits of 10,000 with a price
    // that never moves. The series rose by 10,000 and the market did nothing,
    // so the headline is the server's investment result of 0 -- and the value
    // change it is NOT is named beside it rather than printed as the figure.
    getInvestmentsMonthly.mockResolvedValue([
      { month: '2026-01', value: 10000 },
      { month: '2026-06', value: 20000 },
    ]);
    getInvestmentsPeriodResult.mockResolvedValue(
      periodResult({
        startValue: 10000,
        endValue: 20000,
        valueChange: 10000,
        netExternalFlows: 10000,
        knownFlowSubtotal: 10000,
        investmentResult: 0,
        returnPercent: 0,
      }),
    );
    await renderWidget();
    const figure = screen.getByTestId('portfolio-period-change');
    // The headline itself, before the help text that explains it: the caption
    // says investment result and the figure is the server's 0 / 0%.
    expect(figure.textContent).toMatch(/^Investment result\+\$0\(\+0\.0%\)/);
    // The deposit is not the headline, under any caption.
    expect(figure.textContent).not.toMatch(/^[^V]*\$10000/);
    expect(figure).not.toHaveTextContent('100.0%');
    expect(
      screen.getByLabelText(
        'Value change +$10000, of which deposits and withdrawals were +$10000. The investment result is what is left.',
      ),
    ).toBeInTheDocument();
  });

  it('renders a withheld result as unknown with the cause the server gave', async () => {
    getInvestmentsMonthly.mockResolvedValue([
      { month: '2026-05', value: 8000 },
      { month: '2026-06', value: 10000 },
    ]);
    getInvestmentsPeriodResult.mockResolvedValue(
      periodResult({
        valueChange: null,
        netExternalFlows: null,
        investmentResult: null,
        returnPercent: null,
        complete: false,
        reasons: ['incompletePrices'],
        unpricedSecurityIds: ['sec-1'],
      }),
    );
    await renderWidget();
    const figure = screen.getByTestId('portfolio-period-change');
    expect(figure).toContainElement(screen.getByTestId('unknown-amount'));
    // The marker names the one repair: a price to add, not a rate to refresh.
    expect(
      screen.getByLabelText(/the security has no price to value them at/),
    ).toBeInTheDocument();
    expect(figure).not.toHaveTextContent('$0');
    // The two figures behind it are withheld in the same words, never blank.
    expect(
      screen.getByLabelText(
        'Value change N/A, of which deposits and withdrawals were N/A. The investment result is what is left.',
      ),
    ).toBeInTheDocument();
  });

  it('shows no figure at all when the period request fails', async () => {
    // A failed request is not a period that did nothing: never a zero, and
    // never the previous window's figure under this window's caption.
    getInvestmentsMonthly.mockResolvedValue([
      { month: '2026-05', value: 8000 },
      { month: '2026-06', value: 10000 },
    ]);
    getInvestmentsPeriodResult.mockRejectedValue(new Error('period unavailable'));
    await renderWidget();
    expect(screen.queryByTestId('portfolio-period-change')).toBeNull();
    expect(screen.queryByText(/\$2000/)).toBeNull();
    expect(screen.queryByText(/\+\$0/)).toBeNull();
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

  it('shows no period figure while the series is empty', async () => {
    // With nothing on screen there is no window to measure, so no request is
    // made and nothing is printed -- never a change of zero.
    getInvestmentsMonthly.mockResolvedValue([]);
    await renderWidget();
    expect(screen.queryByTestId('portfolio-period-change')).toBeNull();
    expect(getInvestmentsPeriodResult).not.toHaveBeenCalled();
  });

  it('asks for the MTD period against the close before the first point drawn', async () => {
    configState.current = { range: 'mtd', accountIds: ['i1'] };
    getInvestmentsDaily.mockResolvedValue([
      { date: '2026-07-01', value: 9500 },
      { date: '2026-07-02', value: 9900 },
    ]);
    getInvestmentsPeriodResult.mockResolvedValue(
      periodResult({ investmentResult: 400, returnPercent: 4 }),
    );
    await renderWidget();
    // The client picks the date; the server measures. MTD reports against the
    // previous close, so the day before the first point goes out as the
    // baseline, for the same account scope as the series.
    expect(getInvestmentsPeriodResult).toHaveBeenCalledWith(
      expect.objectContaining({ baselineDate: '2026-06-30', accountIds: 'i1' }),
    );
    expect(screen.getByTestId('portfolio-period-change')).toHaveTextContent(
      '+$400(+4.0%)',
    );
  });

  it('sends no baseline date on a range measured from its own first point', async () => {
    configState.current = { range: '1y', accountIds: [] };
    getInvestmentsMonthly.mockResolvedValue([{ month: '2026-06', value: 10000 }]);
    await renderWidget();
    expect(getInvestmentsPeriodResult).toHaveBeenCalledWith(
      expect.objectContaining({ baselineDate: undefined }),
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
