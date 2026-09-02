import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import toast from 'react-hot-toast';
import { render } from '@/test/render';
import { PayeeKeyInfoCard } from './PayeeKeyInfoCard';
import { payeesApi } from '@/lib/payees';
import type { PayeeDetail } from '@/types/payee';

vi.mock('@/lib/payees', () => ({
  payeesApi: { lookupContactForPayee: vi.fn() },
}));

const mapProvider = { current: undefined as string | undefined };

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ preferences: { defaultMapProvider: mapProvider.current } }),
}));

function detailFixture(overrides: Partial<PayeeDetail> = {}): PayeeDetail {
  return {
    payee: {
      id: 'payee-1',
      userId: 'user-1',
      name: 'Hydro One',
      defaultCategoryId: 'cat-1',
      defaultCategory: {
        id: 'cat-1',
        name: 'Utilities',
      } as PayeeDetail['payee']['defaultCategory'],
      notes: 'Electricity provider',
      website: null,
      hasLogo: false,
      logoFetchedAt: null,
      contactLookupAt: null,
      contactLookupSource: null,
      address: null,
      email: null,
      phone: null,
      isActive: true,
      createdAt: '2024-01-15T00:00:00.000Z',
    },
    stats: {
      transactionCount: 24,
      firstTransactionDate: '2024-02-01',
      lastTransactionDate: '2026-07-01',
      uncategorizedCount: 0,
      aliasCount: 3,
    },
    accounts: [],
    largestTransaction: {
      id: 'tx-1',
      transactionDate: '2025-12-24',
      amount: -412.5,
      currencyCode: 'CAD',
      accountId: 'acct-1',
      accountName: 'Chequing',
      description: null,
    },
    overpaymentForAccounts: [{ accountId: 'acct-loan', accountName: 'Mortgage' }],
    ...overrides,
  };
}

/** Hierarchical labels, as the page builds them from the category tree. */
const categoryLabelMap = new Map([['cat-1', 'Utilities: Hydro']]);

function renderCard(detail = detailFixture(), labels = categoryLabelMap) {
  const onSelectDate = vi.fn();
  const onSelectAccount = vi.fn();
  render(
    <PayeeKeyInfoCard
      detail={detail}
      categoryLabelMap={labels}
      onSelectDate={onSelectDate}
      onSelectAccount={onSelectAccount}
    />,
  );
  return { onSelectDate, onSelectAccount };
}

describe('PayeeKeyInfoCard', () => {
  it('shows the reference facts', () => {
    renderCard();
    expect(screen.getByText('Key Information')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Electricity provider')).toBeInTheDocument();
  });

  it('shows the default category with its parent, not the bare leaf', () => {
    renderCard();
    expect(screen.getByText('Utilities: Hydro')).toBeInTheDocument();
    expect(screen.queryByText('Utilities')).toBeNull();
  });

  it('falls back to the relation name when the map has no entry', () => {
    renderCard(detailFixture(), new Map());
    expect(screen.getByText('Utilities')).toBeInTheDocument();
  });

  it('filters the register to the largest transaction own date', () => {
    const { onSelectDate } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /412\.50/ }));
    expect(onSelectDate).toHaveBeenCalledWith('2025-12-24');
  });

  it('links the overpayment designation to the loan account', () => {
    const { onSelectAccount } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Mortgage' }));
    expect(onSelectAccount).toHaveBeenCalledWith('acct-loan');
  });

  it('drops rows that have no value', () => {
    renderCard(
      detailFixture({
        payee: {
          id: 'payee-1',
          userId: 'user-1',
          name: 'Hydro One',
          defaultCategoryId: null,
          defaultCategory: null,
          notes: null,
          website: null,
          hasLogo: false,
          logoFetchedAt: null,
          contactLookupAt: null,
          contactLookupSource: null,
          address: null,
          email: null,
          phone: null,
          isActive: true,
          createdAt: '2024-01-15T00:00:00.000Z',
        },
        stats: {
          transactionCount: 0,
          firstTransactionDate: null,
          lastTransactionDate: null,
          uncategorizedCount: 0,
          aliasCount: 0,
        },
        largestTransaction: null,
        overpaymentForAccounts: [],
      }),
    );
    expect(screen.queryByText('Default Category')).toBeNull();
    expect(screen.queryByText('First Transaction')).toBeNull();
    expect(screen.queryByText('Largest Transaction')).toBeNull();
    expect(screen.queryByText('Overpayment Payee For')).toBeNull();
    expect(screen.queryByText('Notes')).toBeNull();
  });
});

describe('PayeeKeyInfoCard contact details', () => {
  // The ref is module-level, so without this the tests depend on running in
  // order and one leaks its provider into the next.
  beforeEach(() => {
    mapProvider.current = undefined;
  });

  const withContact = (overrides: Partial<PayeeDetail['payee']>) =>
    detailFixture({
      payee: { ...detailFixture().payee, ...overrides },
    });

  it('shows nothing for a payee with no contact details', () => {
    // KeyValueList drops empty rows, which is what makes "only if populated"
    // free -- assert it rather than assuming it.
    render(
      <PayeeKeyInfoCard
        detail={detailFixture()}
        categoryLabelMap={new Map()}
        onSelectDate={vi.fn()}
        onSelectAccount={vi.fn()}
      />,
    );

    expect(screen.queryByText('Address')).not.toBeInTheDocument();
    expect(screen.queryByText('Phone')).not.toBeInTheDocument();
    expect(screen.queryByText('Email')).not.toBeInTheDocument();
  });

  it('links a phone number to the dialer', () => {
    render(
      <PayeeKeyInfoCard
        detail={withContact({ phone: '+1 (555) 010-1234' })}
        categoryLabelMap={new Map()}
        onSelectDate={vi.fn()}
        onSelectAccount={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: '+1 (555) 010-1234' })).toHaveAttribute(
      'href',
      'tel:+15550101234',
    );
  });

  it('links an email to the mail composer', () => {
    render(
      <PayeeKeyInfoCard
        detail={withContact({ email: 'hello@example.com' })}
        categoryLabelMap={new Map()}
        onSelectDate={vi.fn()}
        onSelectAccount={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'hello@example.com' }),
    ).toHaveAttribute('href', 'mailto:hello%40example.com');
  });

  it('links an address to a maps application', () => {
    render(
      <PayeeKeyInfoCard
        detail={withContact({ address: '1912 Pike Pl, Seattle' })}
        categoryLabelMap={new Map()}
        onSelectDate={vi.fn()}
        onSelectAccount={vi.fn()}
      />,
    );

    const link = screen.getByRole('link', { name: /1912 Pike Pl/ });
    expect(link.getAttribute('href')).toContain(
      encodeURIComponent('1912 Pike Pl, Seattle'),
    );
  });

  it('sends the address to the map provider the user chose', () => {
    mapProvider.current = 'google';

    render(
      <PayeeKeyInfoCard
        detail={withContact({ address: '1912 Pike Pl, Seattle' })}
        categoryLabelMap={new Map()}
        onSelectDate={vi.fn()}
        onSelectAccount={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('link', { name: /1912 Pike Pl/ }).getAttribute('href'),
    ).toContain('google.com/maps');
  });

  it('hands off to the phone map app even when a provider is stored', () => {
    // The preference applies to desktop only. jsdom reports a desktop UA, so
    // the platform has to be stubbed to exercise the branch a phone takes.
    // userAgent lives on Navigator.prototype, so there is no own descriptor to
    // put back -- defining one shadows the prototype and deleting it is what
    // undoes that. Restoring an undefined descriptor would leave the stub in
    // place for every test after this one.
    const original = Object.getOwnPropertyDescriptor(
      window.navigator,
      'userAgent',
    );
    Object.defineProperty(window.navigator, 'userAgent', {
      value:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      configurable: true,
    });
    mapProvider.current = 'google';

    try {
      render(
        <PayeeKeyInfoCard
          detail={withContact({ address: '1912 Pike Pl, Seattle' })}
          categoryLabelMap={new Map()}
          onSelectDate={vi.fn()}
          onSelectAccount={vi.fn()}
        />,
      );

      expect(
        screen.getByRole('link', { name: /1912 Pike Pl/ }).getAttribute('href'),
      ).toContain('maps.apple.com');
    } finally {
      if (original) {
        Object.defineProperty(window.navigator, 'userAgent', original);
      } else {
        delete (window.navigator as { userAgent?: unknown }).userAgent;
      }
    }
  });

  it('falls back to the platform hand-off when no provider is stored', () => {
    // Preferences may not have loaded yet, and a user who never touched the
    // setting must keep the behaviour they had before it existed.
    mapProvider.current = undefined;

    render(
      <PayeeKeyInfoCard
        detail={withContact({ address: '1912 Pike Pl, Seattle' })}
        categoryLabelMap={new Map()}
        onSelectDate={vi.fn()}
        onSelectAccount={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('link', { name: /1912 Pike Pl/ }).getAttribute('href'),
    ).toContain('openstreetmap.org');
  });

  it('renders an undialable phone number as plain text rather than a link', () => {
    render(
      <PayeeKeyInfoCard
        detail={withContact({ phone: 'call the shop' })}
        categoryLabelMap={new Map()}
        onSelectDate={vi.fn()}
        onSelectAccount={vi.fn()}
      />,
    );

    expect(screen.getByText('call the shop')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'call the shop' }),
    ).not.toBeInTheDocument();
  });

  describe('contact lookup', () => {
    const lookup = vi.mocked(payeesApi.lookupContactForPayee);

    beforeEach(() => {
      lookup.mockReset();
    });

    it('shows the looked-up badge only when a lookup wrote a field', () => {
      renderCard(
        detailFixture({
          payee: {
            ...detailFixture().payee,
            phone: '+1 555 010 2000',
            contactLookupAt: '2026-09-02T10:00:00.000Z',
            contactLookupSource: 'ai-web-search',
          },
        }),
      );
      expect(screen.getByText(/Looked up automatically on/)).toBeInTheDocument();
    });

    it('shows no badge for an attempt that found nothing', () => {
      renderCard(
        detailFixture({
          payee: {
            ...detailFixture().payee,
            contactLookupAt: '2026-09-02T10:00:00.000Z',
            contactLookupSource: null,
          },
        }),
      );
      expect(screen.queryByText(/Looked up automatically on/)).not.toBeInTheDocument();
    });

    it('looks the payee up on demand and reloads when something was filled', async () => {
      lookup.mockResolvedValue({
        reason: 'ok',
        filled: ['phone', 'email'],
        payee: detailFixture().payee,
      });
      const onContactLookedUp = vi.fn();
      render(
        <PayeeKeyInfoCard
          detail={detailFixture()}
          categoryLabelMap={categoryLabelMap}
          onSelectDate={vi.fn()}
          onSelectAccount={vi.fn()}
          onContactLookedUp={onContactLookedUp}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Look up contact details' }));

      await waitFor(() => expect(onContactLookedUp).toHaveBeenCalled());
      expect(lookup).toHaveBeenCalledWith('payee-1');
      expect(toast.success).toHaveBeenCalledWith('Filled in 2 contact details');
    });

    it('says when nothing new was found and does not reload', async () => {
      lookup.mockResolvedValue({ reason: 'none', filled: [], payee: detailFixture().payee });
      const onContactLookedUp = vi.fn();
      render(
        <PayeeKeyInfoCard
          detail={detailFixture()}
          categoryLabelMap={categoryLabelMap}
          onSelectDate={vi.fn()}
          onSelectAccount={vi.fn()}
          onContactLookedUp={onContactLookedUp}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Look up contact details' }));

      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith('No new contact details were found.'),
      );
      expect(onContactLookedUp).not.toHaveBeenCalled();
    });

    it('shows a failure with its own detail, never as nothing found', async () => {
      lookup.mockResolvedValue({
        reason: 'failed',
        detail: 'Your MCP relay agent is not connected.',
        filled: [],
        payee: detailFixture().payee,
      });
      renderCard();

      fireEvent.click(screen.getByRole('button', { name: 'Look up contact details' }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Your MCP relay agent is not connected.'),
      );
    });
  });
});
