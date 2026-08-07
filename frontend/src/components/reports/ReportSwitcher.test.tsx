import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { ReportSwitcher } from './ReportSwitcher';
import { customReportsApi } from '@/lib/custom-reports';
import { investmentReportsApi } from '@/lib/investment-reports';

vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: { getAll: vi.fn() },
}));

vi.mock('@/lib/investment-reports', () => ({
  investmentReportsApi: { getAll: vi.fn() },
}));

const getCustom = vi.mocked(customReportsApi.getAll);
const getInvestment = vi.mocked(investmentReportsApi.getAll);

async function openSwitcher(currentId = 'tax-summary') {
  const onSelect = vi.fn();
  await act(async () => {
    render(<ReportSwitcher currentId={currentId} onSelect={onSelect} />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Switch to another report' }));
  });
  return { onSelect };
}

describe('ReportSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCustom.mockResolvedValue([]);
    getInvestment.mockResolvedValue([]);
  });

  it('groups the reports by section, in the order the Reports page lists them', async () => {
    // Opened from an Insights report, which has four siblings, so no section
    // disappears for having had its only report removed.
    await openSwitcher('monthly-comparison');
    const sections = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'));
    // Every section that has a report in it, in REPORT_CATEGORIES order.
    expect(sections).toEqual([
      'Spending',
      'Income',
      'Net Worth',
      'Tax',
      'Debt & Loans',
      'Investment',
      'Insights',
      'Maintenance',
      'Bills',
      'Budget',
    ]);
  });

  it('files each report under its own section', async () => {
    await openSwitcher();
    const spending = screen.getByRole('group', { name: 'Spending' });
    expect(
      within(spending).getByRole('menuitem', { name: /Spending by Category/ }),
    ).toBeInTheDocument();
    const budget = screen.getByRole('group', { name: 'Budget' });
    expect(
      within(budget).getByRole('menuitem', { name: /Savings Rate/ }),
    ).toBeInTheDocument();
  });

  it('does not offer the report already on screen', async () => {
    await openSwitcher();
    expect(screen.queryByRole('menuitem', { name: /^Tax Summary/ })).toBeNull();
    // ...and the section it belonged to is gone with it, being its only report.
    expect(screen.queryByRole('group', { name: 'Tax' })).toBeNull();
  });

  it("lists the user's custom and investment reports under their sections", async () => {
    getCustom.mockResolvedValue([
      { id: 'c1', name: 'Groceries Deep Dive' },
    ] as unknown as Awaited<ReturnType<typeof customReportsApi.getAll>>);
    getInvestment.mockResolvedValue([
      { id: 'i1', name: 'RRSP Holdings' },
    ] as unknown as Awaited<ReturnType<typeof investmentReportsApi.getAll>>);

    const { onSelect } = await openSwitcher();
    const custom = screen.getByRole('group', { name: 'Custom' });
    expect(
      within(custom).getByRole('menuitem', { name: /Groceries Deep Dive/ }),
    ).toBeInTheDocument();
    const investment = screen.getByRole('group', { name: 'Investment' });
    expect(
      within(investment).getByRole('menuitem', { name: /RRSP Holdings/ }),
    ).toBeInTheDocument();

    // The id is the route: `/reports/investment/i1` is where the header sends it.
    fireEvent.click(screen.getByRole('menuitem', { name: /RRSP Holdings/ }));
    expect(onSelect).toHaveBeenCalledWith('investment/i1');
  });

  it('reports the built-in catalog when the saved reports cannot be loaded', async () => {
    // A failed lookup is not an empty list of reports: the built-ins are still
    // known, and the switcher stays usable rather than showing nothing.
    getCustom.mockRejectedValue(new Error('offline'));
    getInvestment.mockRejectedValue(new Error('offline'));
    await openSwitcher();
    await act(async () => {});
    expect(
      screen.getByRole('menuitem', { name: /Spending by Category/ }),
    ).toBeInTheDocument();
  });

  it('selects a report by its id', async () => {
    const { onSelect } = await openSwitcher();
    fireEvent.click(screen.getByRole('menuitem', { name: /Net Worth Over Time/ }));
    expect(onSelect).toHaveBeenCalledWith('net-worth');
  });

  it('filters across a list this long', async () => {
    await openSwitcher();
    fireEvent.change(screen.getByPlaceholderText('Filter reports...'), {
      target: { value: 'dividend' },
    });
    expect(
      screen.getByRole('menuitem', { name: /Dividend Yield & Growth/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Savings Rate/ })).toBeNull();
  });
});
