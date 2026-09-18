import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/render';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { RateHistoryCoverage } from './RateHistoryCoverage';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { UserPreferences } from '@/types/auth';

const getRateCoverage = vi.fn();
const extendRateHistory = vi.fn();

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getRateCoverage: (...args: any[]) => getRateCoverage(...args),
    extendRateHistory: (...args: any[]) => extendRateHistory(...args),
    getLatestRates: () => Promise.resolve([]),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const coverage = {
  from: 'EUR',
  to: 'PLN',
  earliestDate: '2026-01-02',
  latestDate: '2026-09-16',
  observations: 180,
};

async function renderSection(code = 'EUR') {
  await act(async () => {
    render(<RateHistoryCoverage code={code} />);
  });
}

describe('RateHistoryCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({
      preferences: { defaultCurrency: 'PLN' } as UserPreferences,
    });
    getRateCoverage.mockResolvedValue(coverage);
    extendRateHistory.mockResolvedValue({
      from: 'EUR',
      to: 'PLN',
      requestedFrom: '2025-01-02',
      requestedTo: '2026-01-01',
      stored: 240,
      earliestDate: '2025-01-02',
      answered: true,
    });
  });

  it('shows the stored span and observation count', async () => {
    await renderSection();

    expect(getRateCoverage).toHaveBeenCalledWith('EUR');
    expect(await screen.findByText(/Stored history:/)).toHaveTextContent(
      '180 observations',
    );
  });

  it('says so when the pair has no stored history', async () => {
    getRateCoverage.mockResolvedValue({
      ...coverage,
      earliestDate: null,
      latestDate: null,
      observations: 0,
    });

    await renderSection();

    expect(
      await screen.findByText('No stored history for EUR->PLN'),
    ).toBeInTheDocument();
  });

  it('extends the history, reports what was added and re-reads the coverage', async () => {
    await renderSection();
    getRateCoverage.mockResolvedValue({
      ...coverage,
      earliestDate: '2025-01-02',
      observations: 420,
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Add another year of rate history' }),
    );

    await waitFor(() => expect(extendRateHistory).toHaveBeenCalledWith('EUR'));
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('Added 240 rates'),
    );
    // The server decides what is stored, so the section re-reads rather than
    // patching its own state.
    await waitFor(() => expect(getRateCoverage).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/420 observations/)).toBeInTheDocument();
  });

  it('distinguishes a provider with no older data from a failure', async () => {
    extendRateHistory.mockResolvedValue({
      from: 'EUR',
      to: 'PLN',
      requestedFrom: '2025-01-02',
      requestedTo: '2026-01-01',
      stored: 0,
      earliestDate: '2026-01-02',
      answered: true,
    });
    await renderSection();

    await userEvent.click(
      screen.getByRole('button', { name: 'Add another year of rate history' }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The provider has no older rates for EUR->PLN',
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('surfaces the server message when the provider did not answer', async () => {
    extendRateHistory.mockRejectedValue({
      response: { data: { message: 'The exchange rate provider did not answer.' } },
    });
    await renderSection();

    await userEvent.click(
      screen.getByRole('button', { name: 'Add another year of rate history' }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The exchange rate provider did not answer.',
      ),
    );
  });

  it('disables the button while an extension is in flight', async () => {
    let release: (value: unknown) => void = () => {};
    extendRateHistory.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await renderSection();
    const button = screen.getByRole('button', {
      name: 'Add another year of rate history',
    });

    await userEvent.click(button);

    expect(
      screen.getByRole('button', { name: 'Fetching another year...' }),
    ).toBeDisabled();
    await act(async () => {
      release({ stored: 0, answered: true, earliestDate: null });
    });
  });

  it('renders nothing for the reader’s own reporting currency', async () => {
    await renderSection('PLN');

    expect(screen.queryByText('Rate history')).not.toBeInTheDocument();
    expect(getRateCoverage).not.toHaveBeenCalled();
  });

  it('reports a coverage read that failed rather than an empty history', async () => {
    getRateCoverage.mockRejectedValue(new Error('boom'));

    await renderSection();

    expect(
      await screen.findByText('Could not read the stored rate history'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('No stored history for EUR->PLN'),
    ).not.toBeInTheDocument();
  });
});
