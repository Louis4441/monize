import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MnyReviewStep } from './MnyReviewStep';
import type { MnyPreview, MnyPreviewAccount } from '@/lib/import-mny';

function account(
  overrides: Partial<MnyPreviewAccount> = {},
): MnyPreviewAccount {
  return {
    key: 'acct-1',
    handle: 1,
    name: 'Chequing',
    moneyName: 'Chequing',
    accountType: 'CHEQUING',
    accountSubType: null,
    currencyCode: 'USD',
    transactionCount: 120,
    investmentCount: 0,
    openingBalance: 100,
    finalBalance: 2500.5,
    closed: false,
    favourite: false,
    ...overrides,
  };
}

function preview(overrides: Partial<MnyPreview> = {}): MnyPreview {
  return {
    stagedFileId: 'staged-1',
    filename: 'finances.mny',
    sizeBytes: 1024,
    era: 'moneyPlus',
    passwordProtected: false,
    baseCurrency: 'USD',
    accounts: [account()],
    counts: {
      accountsIncluded: 1,
      accountsInFile: 3,
      payeesToCreate: 40,
      payeesInFile: 500,
      categoriesToCreate: 30,
      categoriesInFile: 128,
      transactionsToCreate: 120,
      transfersToLink: 12,
      transactionsSkipped: 0,
      securitiesToCreate: 0,
      securitiesInFile: 0,
      investmentsToCreate: 0,
      investmentsSkipped: 0,
      shareTransfersPaired: 0,
      stockSplitsApplied: 0,
      pricesToImport: 0,
      exchangeRatesToImport: 0,
    },
    fileCounts: {
      accounts: 3,
      payees: 500,
      categories: 128,
      securities: 0,
      securityPrices: 0,
      exchangeRates: 0,
      bills: 0,
      transactions: 120,
    },
    missingTables: [],
    missingFields: [],
    warnings: [],
    options: {
      wipeExistingData: false,
      referencedOnlyPayees: true,
      referencedOnlyCategories: true,
      importClosedAccounts: true,
      importPrices: true,
      importExchangeRates: true,
      accounts: [],
      bills: [],
    },
    ...overrides,
  };
}

describe('MnyReviewStep', () => {
  const defaultProps = {
    preview: preview(),
    excludedHandles: new Set<number>(),
    currencyOverrides: new Map<number, string>(),
    options: preview().options,
    currencyOptions: [
      { value: 'USD', label: 'USD - US Dollar' },
      { value: 'CAD', label: 'CAD - Canadian Dollar' },
    ],
    isLoading: false,
    onToggleAccount: vi.fn(),
    onSetAllAccounts: vi.fn(),
    onSetAccountCurrency: vi.fn(),
    onSetOption: vi.fn(),
    onBack: vi.fn(),
    onImport: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('names the file, its Money era and its base currency', () => {
    render(<MnyReviewStep {...defaultProps} />);

    // One paragraph carries all three, so match it whole rather than matching
    // "USD" which also appears in every currency dropdown.
    expect(
      screen.getByText(
        /finances\.mny -- Money Plus \/ Sunset format, base currency USD/,
      ),
    ).toBeInTheDocument();
  });

  it('shows the final balance computed from the file, the verification baseline', () => {
    render(<MnyReviewStep {...defaultProps} />);

    expect(screen.getByText('$2,500.50')).toBeInTheDocument();
  });

  it('shows referenced-versus-total counts rather than just totals', () => {
    render(<MnyReviewStep {...defaultProps} />);

    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText(/of 500 in the file/)).toBeInTheDocument();
  });

  it('toggles an account when its checkbox is clicked', () => {
    render(<MnyReviewStep {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Import Chequing'));

    expect(defaultProps.onToggleAccount).toHaveBeenCalledWith(1);
  });

  it('dims an excluded account and keeps it listed', () => {
    render(
      <MnyReviewStep {...defaultProps} excludedHandles={new Set([1])} />,
    );

    const checkbox = screen.getByLabelText('Import Chequing') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    // Still listed: unticking an account must not hide its numbers.
    expect(checkbox.closest('tr')).toHaveClass('opacity-50');
    expect(screen.getByText('$2,500.50')).toBeInTheDocument();
  });

  it('disables the import button when nothing is selected', () => {
    render(
      <MnyReviewStep {...defaultProps} excludedHandles={new Set([1])} />,
    );

    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled();
  });

  it('reports a currency override, and clears it when set back to the file value', () => {
    render(<MnyReviewStep {...defaultProps} />);
    const select = screen.getByLabelText('Currency for Chequing');

    fireEvent.change(select, { target: { value: 'CAD' } });
    expect(defaultProps.onSetAccountCurrency).toHaveBeenCalledWith(1, 'CAD');

    fireEvent.change(select, { target: { value: 'USD' } });
    expect(defaultProps.onSetAccountCurrency).toHaveBeenCalledWith(1, null);
  });

  it('marks a closed account and a favourite', () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          accounts: [account({ closed: true, favourite: true })],
        })}
      />,
    );

    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('Favourite')).toBeInTheDocument();
  });

  it("shows the Money name when the account had to be renamed", () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          accounts: [account({ name: 'Savings (2)', moneyName: 'Savings' })],
        })}
      />,
    );

    expect(screen.getByText(/named "Savings" in Money/)).toBeInTheDocument();
  });

  it("says which tables this Money version does not have", () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({ missingTables: ['BILL'] })}
      />,
    );

    expect(screen.getByText(/no BILL table/)).toBeInTheDocument();
  });

  it('says plainly that scheduled bills are not imported yet', () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          fileCounts: { ...preview().fileCounts, securities: 98, bills: 1844 },
        })}
      />,
    );

    expect(
      screen.getByText(/Scheduled bills are not imported yet/),
    ).toBeInTheDocument();
  });

  describe('investments', () => {
    const withInvestments = () =>
      preview({
        counts: {
          ...preview().counts,
          securitiesToCreate: 86,
          securitiesInFile: 98,
          investmentsToCreate: 412,
          shareTransfersPaired: 4,
          stockSplitsApplied: 2,
          pricesToImport: 68000,
          exchangeRatesToImport: 120,
        },
        fileCounts: {
          ...preview().fileCounts,
          securities: 98,
          securityPrices: 68000,
          exchangeRates: 120,
        },
        accounts: [account({ investmentCount: 412 })],
      });

    it('summarises the securities, investments, prices and rates', () => {
      render(
        <MnyReviewStep {...defaultProps} preview={withInvestments()} />,
      );

      expect(screen.getByText('86')).toBeInTheDocument();
      expect(screen.getByText('412')).toBeInTheDocument();
      expect(screen.getByText('68000')).toBeInTheDocument();
      expect(
        screen.getByText(/4 share transfers, 2 stock splits/),
      ).toBeInTheDocument();
    });

    it('shows an account its investment rows alongside its transactions', () => {
      render(
        <MnyReviewStep {...defaultProps} preview={withInvestments()} />,
      );

      expect(screen.getByText('+ 412 investments')).toBeInTheDocument();
    });

    it('hides the investment summary for a file with no securities', () => {
      render(<MnyReviewStep {...defaultProps} />);

      expect(screen.queryByText('Securities')).not.toBeInTheDocument();
    });

    it('lets the user turn the price and rate history off', () => {
      render(
        <MnyReviewStep {...defaultProps} preview={withInvestments()} />,
      );

      fireEvent.click(screen.getByText('Import price history'));

      expect(defaultProps.onSetOption).toHaveBeenCalledWith(
        'importPrices',
        false,
      );
    });
  });

  it('surfaces mapper warnings with their counts and samples', () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          warnings: [
            {
              code: 'degeneratePayeeSkipped',
              count: 2,
              samples: ['#', '*'],
            },
          ],
        })}
      />,
    );

    expect(
      screen.getByText(/2 placeholder payees Money keeps internally/),
    ).toBeInTheDocument();
    expect(screen.getByText('#, *')).toBeInTheDocument();
  });

  it('toggles an import option', () => {
    render(<MnyReviewStep {...defaultProps} />);

    fireEvent.click(screen.getByLabelText(/Only import payees that are used/));

    expect(defaultProps.onSetOption).toHaveBeenCalledWith(
      'referencedOnlyPayees',
      false,
    );
  });

  it('selects and clears every account at once', () => {
    render(<MnyReviewStep {...defaultProps} />);

    fireEvent.click(screen.getByText('Select none'));
    expect(defaultProps.onSetAllAccounts).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByText('Select all'));
    expect(defaultProps.onSetAllAccounts).toHaveBeenCalledWith(true);
  });

  it('starts the import and goes back', () => {
    render(<MnyReviewStep {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));
    expect(defaultProps.onImport).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(defaultProps.onBack).toHaveBeenCalled();
  });

  it('cannot untick the cash side Monize adds to an investment pair', () => {
    // It has no Money handle of its own, so there is nothing to exclude.
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          accounts: [
            account({
              key: 'acct-1-cash',
              handle: null,
              name: 'TFSA - Cash',
              accountType: 'INVESTMENT',
              accountSubType: 'INVESTMENT_CASH',
            }),
          ],
        })}
      />,
    );

    expect(screen.getByLabelText('Import TFSA - Cash')).toBeDisabled();
  });
});
