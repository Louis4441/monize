import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@/test/render';
import { RecurringChargesPanel } from './RecurringChargesPanel';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));

const mockGetAll = vi.fn();
const mockGetRecurringCharges = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...a: unknown[]) => mockGetAll(...a),
    getRecurringCharges: (...a: unknown[]) => mockGetRecurringCharges(...a),
  },
}));

function charge(overrides: Record<string, unknown> = {}) {
  return {
    payeeName: 'Netflix',
    amounts: [-15],
    dates: ['2026-05-01', '2026-06-01'],
    frequency: 'monthly',
    currentAmount: -15,
    previousAmount: -15,
    categoryName: 'Streaming',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAll.mockResolvedValue({
    data: [
      { id: 't1', payeeId: 'p1', payeeName: 'Netflix' },
      { id: 't2', payeeId: null, payeeName: null },
    ],
    pagination: { hasMore: false },
  });
  mockGetRecurringCharges.mockResolvedValue([charge()]);
});

async function renderPanel() {
  await act(async () => {
    render(<RecurringChargesPanel accountId="cc-1" currencyCode="CAD" />);
  });
}

describe('RecurringChargesPanel', () => {
  it('derives payees then lists detected subscriptions', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());
    expect(screen.getByText(/Monthly/)).toBeInTheDocument();
    expect(screen.getByText('$15.00')).toBeInTheDocument();
    // Only non-null payee ids are passed through.
    expect(mockGetRecurringCharges).toHaveBeenCalledWith(
      expect.objectContaining({ payeeIds: ['p1'] }),
    );
  });

  it('filters out irregular cadences', async () => {
    mockGetRecurringCharges.mockResolvedValue([charge({ frequency: 'irregular' })]);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByText('No recurring charges detected on this card')).toBeInTheDocument(),
    );
  });

  it('skips the recurring lookup when the card has no payees', async () => {
    mockGetAll.mockResolvedValue({ data: [], pagination: {} });
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByText('No recurring charges detected on this card')).toBeInTheDocument(),
    );
    expect(mockGetRecurringCharges).not.toHaveBeenCalled();
  });
});
