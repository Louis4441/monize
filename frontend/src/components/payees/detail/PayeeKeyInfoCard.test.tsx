import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { PayeeKeyInfoCard } from './PayeeKeyInfoCard';
import type { PayeeDetail } from '@/types/payee';

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
      address: null,
      email: null,
      phone: null,
      latitude: null,
      longitude: null,
      geocodedAt: null,
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
          address: null,
          email: null,
          phone: null,
          latitude: null,
          longitude: null,
          geocodedAt: null,
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

  it('links a located address to a maps application', () => {
    render(
      <PayeeKeyInfoCard
        detail={withContact({
          address: '1912 Pike Pl, Seattle',
          latitude: 47.609722,
          longitude: -122.342201,
        })}
        categoryLabelMap={new Map()}
        onSelectDate={vi.fn()}
        onSelectAccount={vi.fn()}
      />,
    );

    const link = screen.getByRole('link', { name: /1912 Pike Pl/ });
    expect(link.getAttribute('href')).toContain('47.609722');
  });

  it('still links an address the lookup could not locate', () => {
    // The coordinates are what the map needs; directions only need the text,
    // so a failed lookup must not turn the address into dead text.
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
});
