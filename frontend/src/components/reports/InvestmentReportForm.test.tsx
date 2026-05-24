import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { InvestmentReportForm } from './InvestmentReportForm';

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/components/ui/IconPicker', () => ({
  IconPicker: () => <div data-testid="icon-picker" />,
}));
vi.mock('@/components/ui/ColorPicker', () => ({
  ColorPicker: () => <div data-testid="color-picker" />,
}));
vi.mock('@/components/ui/DateInput', () => ({
  DateInput: ({ label }: { label?: string }) => <div>{label}</div>,
}));
vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: ({ label }: { label?: string }) => <div>{label}</div>,
}));
vi.mock('./InvestmentReportColumnChooser', () => ({
  InvestmentReportColumnChooser: () => <div data-testid="column-chooser" />,
}));

describe('InvestmentReportForm', () => {
  beforeEach(() => vi.clearAllMocks());

  async function renderForm(onSubmit = vi.fn().mockResolvedValue(undefined)) {
    await act(async () => {
      render(<InvestmentReportForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    });
    return onSubmit;
  }

  it('renders the builder sections after loading', async () => {
    await renderForm();
    expect(await screen.findByText('Columns')).toBeInTheDocument();
    expect(screen.getByText('Accounts')).toBeInTheDocument();
    expect(screen.getByText('Grouping & Sorting')).toBeInTheDocument();
    expect(screen.getByText('Report Date')).toBeInTheDocument();
    expect(screen.getByTestId('column-chooser')).toBeInTheDocument();
  });

  it('submits the assembled report configuration with symbol-led default columns', async () => {
    const onSubmit = await renderForm();
    const nameInput = screen.getByPlaceholderText('e.g., Taxable Holdings Overview');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'My Holdings' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Report' }));
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.name).toBe('My Holdings');
    expect(submitted.config.columns[0]).toBe('symbol');
    expect(submitted.config.columns).toContain('marketValue');
    expect(submitted.config.sortColumn).toBe('marketValue');
    expect(submitted.config.accountIds).toEqual([]);
    expect(submitted.config.asOfDate).toBeNull();
  });

  it('requires a name', async () => {
    const onSubmit = await renderForm();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Report' }));
    });
    await waitFor(() =>
      expect(screen.getByText('Name is required')).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
