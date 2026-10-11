import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { render } from '@/test/render';
import { BondInstrumentSelect, useBondInstrumentPicker } from './BondInstrumentSelect';
import { investmentsApi } from '@/lib/investments';
import type { BondInstrumentSummary } from '@/types/bond';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    listBondInstruments: vi.fn(),
    fetchBondSeries: vi.fn(),
  },
}));

const pln: BondInstrumentSummary = {
  id: 'b-pln',
  issuerCountryCode: 'PL',
  issuerCode: 'PL_MF',
  programCode: 'PL_MF',
  seriesCode: 'TOS1029',
  currencyCode: 'PLN',
  termsProvider: 'curated',
};
const fetched: BondInstrumentSummary = {
  ...pln,
  id: 'b-new',
  seriesCode: 'EDO1136',
  termsProvider: 'obligacjeskarbowe.pl',
};
const usd: BondInstrumentSummary = {
  ...pln,
  id: 'b-usd',
  issuerCountryCode: 'US',
  seriesCode: 'TBOND30',
  currencyCode: 'USD',
};

const list = vi.mocked(investmentsApi.listBondInstruments);
const fetchSeries = vi.mocked(investmentsApi.fetchBondSeries);

function Harness({ currency = 'PLN' }: { currency?: string }) {
  const [selected, setSelected] = useState('');
  const picker = useBondInstrumentPicker(true, currency, selected);
  return (
    <>
      <BondInstrumentSelect picker={picker} currency={currency} onChange={setSelected} />
      <output data-testid="selected">{picker.effectiveBondId}</output>
    </>
  );
}

async function mount(currency?: string) {
  await act(async () => {
    render(<Harness currency={currency} />);
  });
}

async function type(value: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Find a series by code'), { target: { value } });
  });
}

const actionName = 'Fetch EDO1136 from the official source';

describe('BondInstrumentSelect series fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue([pln, usd]);
  });

  it('offers the fetch only for a code-like search that the catalog does not hold', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: /Fetch/ })).not.toBeInTheDocument();

    await type('EDO11');
    expect(screen.queryByRole('button', { name: /Fetch/ })).not.toBeInTheDocument();
    await type('EDO1136');
    expect(screen.getByRole('button', { name: actionName })).toBeInTheDocument();
    await type('edo1136');
    expect(screen.getByRole('button', { name: actionName })).toBeInTheDocument();
    await type('TOS1029');
    expect(screen.queryByRole('button', { name: /Fetch/ })).not.toBeInTheDocument();
  });

  it('hides the action when the currency maps to no single catalog country', async () => {
    list.mockResolvedValue([pln, { ...pln, id: 'b-x', issuerCountryCode: 'XX', seriesCode: 'ABC1234' }]);
    await mount();
    await type('EDO1136');
    expect(screen.queryByRole('button', { name: /Fetch/ })).not.toBeInTheDocument();
  });

  it('fetches for the single country of the currency, refreshes the list and selects the series', async () => {
    fetchSeries.mockResolvedValue({ ...fetched, created: true });
    await mount();
    await type('EDO1136');
    list.mockResolvedValue([pln, usd, fetched]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: actionName }));
    });
    expect(fetchSeries).toHaveBeenCalledWith('PL', 'EDO1136');
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('selected')).toHaveTextContent('b-new');
    const select = screen.getByLabelText('Bond series (optional)');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toContain(
      'EDO1136 (PL, PL_MF)',
    );
    expect(screen.queryByRole('button', { name: /Fetch/ })).not.toBeInTheDocument();
  });

  it('shows the server message inline when the fetch fails', async () => {
    fetchSeries.mockRejectedValue({
      response: { data: { message: 'Series EDO1136 is not published yet' } },
    });
    await mount();
    await type('EDO1136');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: actionName }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Series EDO1136 is not published yet');
    expect(screen.getByTestId('selected')).toHaveTextContent('');
    expect(screen.getByRole('button', { name: actionName })).toBeEnabled();
  });

  it('does not send twice while a fetch is in flight', async () => {
    let resolve: (v: typeof fetched & { created: boolean }) => void = () => {};
    fetchSeries.mockReturnValue(new Promise((r) => (resolve = r)));
    await mount();
    await type('EDO1136');
    const button = screen.getByRole('button', { name: actionName });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(fetchSeries).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Fetching EDO1136...' })).toBeDisabled();
    await act(async () => {
      resolve({ ...fetched, created: true });
    });
    expect(fetchSeries).toHaveBeenCalledTimes(1);
  });
});
