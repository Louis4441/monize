import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { PayeeDetailHeader } from './PayeeDetailHeader';
import type { Payee } from '@/types/payee';

function payee(overrides: Partial<Payee> = {}): Payee {
  return {
    id: 'payee-1',
    userId: 'user-1',
    name: 'Starbucks',
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
    isActive: true,
    createdAt: '2024-01-15T00:00:00.000Z',
    ...overrides,
  };
}

function renderHeader(overrides: Partial<Payee> = {}) {
  const handlers = {
    onBack: vi.fn(),
    onViewTransactions: vi.fn(),
    onEdit: vi.fn(),
    onMerge: vi.fn(),
    onToggleActive: vi.fn(),
    onSelectPayee: vi.fn(),
  };
  render(
    <PayeeDetailHeader
      payee={payee(overrides)}
      isTogglePending={false}
      payees={[]}
      {...handlers}
    />,
  );
  return handlers;
}

describe('PayeeDetailHeader', () => {
  it('shows the payee name', () => {
    renderHeader();
    expect(screen.getByRole('heading', { name: 'Starbucks' })).toBeInTheDocument();
  });

  it('fires the action callbacks', () => {
    const handlers = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Payees' }));
    fireEvent.click(screen.getByRole('button', { name: 'View Transactions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(handlers.onBack).toHaveBeenCalled();
    expect(handlers.onViewTransactions).toHaveBeenCalled();
    expect(handlers.onEdit).toHaveBeenCalled();
    expect(handlers.onMerge).toHaveBeenCalled();
  });

  it('offers Deactivate for an active payee', () => {
    const handlers = renderHeader();
    expect(screen.queryByText('Inactive')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(handlers.onToggleActive).toHaveBeenCalled();
  });

  it('offers Reactivate, hides Merge and badges an inactive payee', () => {
    const handlers = renderHeader({ isActive: false });
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(handlers.onToggleActive).toHaveBeenCalled();
  });
});
