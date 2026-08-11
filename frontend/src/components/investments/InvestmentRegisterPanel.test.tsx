import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { NextIntlClientProvider } from 'next-intl';
import { InvestmentRegisterPanel } from './InvestmentRegisterPanel';
import { investmentsApi } from '@/lib/investments';
import { transactionsApi } from '@/lib/transactions';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import type { Account } from '@/types/account';
import investmentMessages from '@/i18n/messages/en/accountDetail-investment.json';
import investmentsNs from '@/i18n/messages/en/investments.json';
import transactionsNs from '@/i18n/messages/en/transactions.json';
import commonNs from '@/i18n/messages/en/common.json';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTransactions: vi.fn(),
    deleteTransaction: vi.fn(),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/lib/apiCache', () => ({
  invalidateBalanceCaches: vi.fn(),
}));

// The forms are large trees with their own data loading; the panel's contract
// with them is that it mounts them against the right account.
vi.mock('./InvestmentTransactionForm', () => ({
  InvestmentTransactionForm: ({ defaultAccountId }: { defaultAccountId?: string }) => (
    <div data-testid="investment-form">{defaultAccountId}</div>
  ),
}));
vi.mock('@/components/transactions/TransactionForm', () => ({
  TransactionForm: ({ defaultAccountId }: { defaultAccountId?: string }) => (
    <div data-testid="cash-form">{defaultAccountId}</div>
  ),
}));
vi.mock('@/components/transactions/TransactionList', () => ({
  TransactionList: ({ transactions }: { transactions: { id: string }[] }) => (
    <div data-testid="cash-list">{transactions.map((tx) => tx.id).join(',')}</div>
  ),
}));

const brokerage = {
  id: 'brok',
  name: 'TFSA - Brokerage',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  linkedAccountId: 'cash',
  currencyCode: 'CAD',
  currentBalance: 0,
  isClosed: false,
} as Account;

const cash = {
  id: 'cash',
  name: 'TFSA - Cash',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_CASH',
  linkedAccountId: 'brok',
  currencyCode: 'CAD',
  currentBalance: 3500,
  isClosed: false,
} as Account;

const standalone = {
  id: 'solo',
  name: 'Self-directed',
  accountType: 'INVESTMENT',
  accountSubType: null,
  linkedAccountId: null,
  currencyCode: 'CAD',
  currentBalance: 100,
  isClosed: false,
} as Account;

async function renderPanel(
  holdingsAccount: Account,
  cashAccount: Account | null,
) {
  await act(async () => {
    render(
      <NextIntlClientProvider
        locale="en"
        messages={{
          'accountDetail-investment': investmentMessages,
          investments: investmentsNs,
          transactions: transactionsNs,
          common: commonNs,
        }}
      >
        <InvestmentRegisterPanel
          holdingsAccount={holdingsAccount}
          cashAccount={cashAccount}
        />
      </NextIntlClientProvider>,
    );
  });
}

describe('InvestmentRegisterPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      pagination: { total: 0, page: 1, limit: 25, totalPages: 0 },
    });
    (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 'cash-tx-1' }],
      pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
    });
  });

  describe('scoping', () => {
    // The brokerage's own ledger carries the cash rows its trades generated.
    // Widening the cash register to the pair would put those in a register the
    // user reads as their cash account.
    it('scopes the cash register to the cash ledger alone', async () => {
      await renderPanel(brokerage, cash);

      expect(transactionsApi.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ['cash'] }),
      );
      const call = (transactionsApi.getAll as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.accountIds).not.toContain('brok');
    });

    it('scopes the brokerage register to the holdings account alone', async () => {
      await renderPanel(brokerage, cash);

      expect(investmentsApi.getTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'brok' }),
      );
    });

    it('scopes both registers to itself for a standalone account', async () => {
      await renderPanel(standalone, standalone);

      expect(investmentsApi.getTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'solo' }),
      );
      expect(transactionsApi.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ['solo'] }),
      );
    });

    it('asks for no cash register when the account has no cash ledger', async () => {
      await renderPanel(brokerage, null);

      expect(transactionsApi.getAll).not.toHaveBeenCalled();
      expect(investmentsApi.getTransactions).toHaveBeenCalled();
    });
  });

  describe('the toggle', () => {
    it('offers both ledgers when there is a cash half', async () => {
      await renderPanel(brokerage, cash);

      expect(screen.getByText('Brokerage')).toBeInTheDocument();
      expect(screen.getByText('Cash')).toBeInTheDocument();
    });

    it('shows the cash register once the cash ledger is chosen', async () => {
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByText('Cash'));
      });

      expect(screen.getByTestId('cash-list')).toHaveTextContent('cash-tx-1');
    });

    it('offers no toggle when there is no second ledger to switch to', async () => {
      await renderPanel(brokerage, null);

      expect(screen.queryByText('Cash')).not.toBeInTheDocument();
    });
  });

  describe('writes', () => {
    // A trade settles into the cash ledger and a cash row can carry an
    // investment split, so either side moves balances that the cached account
    // list and portfolio summary are showing.
    it('drops the balance caches after deleting a trade', async () => {
      (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            accountId: 'brok',
            action: 'BUY',
            transactionDate: '2026-01-05',
            quantity: 1,
            price: 10,
            totalAmount: 10,
            security: { symbol: 'VTI', name: 'Vanguard', currencyCode: 'CAD' },
          },
        ],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
      (investmentsApi.deleteTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );

      await renderPanel(brokerage, cash);

      // Row action, then the confirmation it opens.
      const deleteActions = screen.getAllByText('Delete');
      await act(async () => {
        fireEvent.click(deleteActions[0]);
      });
      const confirm = screen
        .getAllByRole('button')
        .filter((b) => b.textContent === 'Delete')
        .pop()!;
      await act(async () => {
        fireEvent.click(confirm);
      });

      await waitFor(() => {
        expect(investmentsApi.deleteTransaction).toHaveBeenCalledWith('tx-1');
      });
      expect(invalidateBalanceCaches).toHaveBeenCalled();
    });
  });
});
