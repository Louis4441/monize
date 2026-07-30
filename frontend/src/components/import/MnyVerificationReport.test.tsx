import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MnyVerificationReport } from './MnyVerificationReport';
import type { MnyAccountVerification, MnyImportResult } from '@/lib/import-mny';

function line(
  overrides: Partial<MnyAccountVerification> = {},
): MnyAccountVerification {
  return {
    accountName: 'Chequing',
    accountId: 'acct-uuid',
    expectedBalance: 2500.5,
    importedBalance: 2500.5,
    delta: 0,
    transactionCount: 120,
    matches: true,
    ...overrides,
  };
}

function result(overrides: Partial<MnyImportResult> = {}): MnyImportResult {
  return {
    accountsCreated: 3,
    payeesCreated: 40,
    categoriesCreated: 30,
    transactionsCreated: 120,
    splitsCreated: 8,
    transfersLinked: 12,
    securitiesCreated: 0,
    investmentTransactionsCreated: 0,
    pricesImported: 0,
    exchangeRatesImported: 0,
    billsCreated: 0,
    skipped: { accounts: 0, payees: 0, categories: 0, transactions: 0 },
    existingDataRemoved: false,
    verification: [line()],
    warnings: [],
    ...overrides,
  };
}

describe('MnyVerificationReport', () => {
  const defaultProps = {
    result: result(),
    currencyCode: 'USD',
    filename: 'finances.mny',
    onDone: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('leads with the reconciliation verdict, not the counts', () => {
    render(<MnyVerificationReport {...defaultProps} />);

    expect(
      screen.getByText(/All 1 accounts reconcile/),
    ).toBeInTheDocument();
  });

  it('names how many accounts differ when some do', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({
          verification: [
            line(),
            line({
              accountName: 'Savings',
              importedBalance: 2400,
              expectedBalance: 2500,
              delta: -100,
              matches: false,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText(/1 accounts do not match/)).toBeInTheDocument();
    expect(screen.getByText('Check')).toBeInTheDocument();
  });

  it('shows both balances and the difference per account', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({
          verification: [
            line({
              expectedBalance: 2500,
              importedBalance: 2400,
              delta: -100,
              matches: false,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText('$2,500.00')).toBeInTheDocument();
    expect(screen.getByText('$2,400.00')).toBeInTheDocument();
    expect(screen.getByText('-$100.00')).toBeInTheDocument();
  });

  it('reports what was created', () => {
    render(<MnyVerificationReport {...defaultProps} />);

    // "120" also appears as the account's transaction count in the table, so
    // read the tiles by their labels.
    const tileValue = (label: string) =>
      screen.getByText(label).parentElement?.textContent;
    expect(tileValue('Transfers')).toContain('12');
    expect(tileValue('Split legs')).toContain('8');
    expect(tileValue('Payees')).toContain('40');
  });

  it('says so when existing data was wiped first', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({ existingDataRemoved: true })}
      />,
    );

    expect(
      screen.getByText(/Your existing data was removed before this import/),
    ).toBeInTheDocument();
  });

  it('lists warnings with their counts', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({
          warnings: [
            { code: 'balanceMismatch', count: 3, samples: ['Savings'] },
          ],
        })}
      />,
    );

    expect(
      screen.getByText(/3 accounts ended with a balance that differs/),
    ).toBeInTheDocument();
  });

  it('finishes on request', () => {
    render(<MnyVerificationReport {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(defaultProps.onDone).toHaveBeenCalled();
  });

  describe('report download', () => {
    const createObjectURL = vi.fn(() => 'blob:report');
    const revokeObjectURL = vi.fn();
    let clickSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      Object.defineProperty(URL, 'createObjectURL', {
        value: createObjectURL,
        writable: true,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        value: revokeObjectURL,
        writable: true,
      });
      clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined);
    });

    afterEach(() => clickSpy.mockRestore());

    it('downloads the full result as JSON, named after the file', () => {
      // A user chasing a discrepancy needs the numbers, not a screenshot.
      render(<MnyVerificationReport {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: 'Download report' }));

      expect(createObjectURL).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');
    });
  });
});
