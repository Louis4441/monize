import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { AccountSwitcher } from './AccountSwitcher';
import type { Account } from '@/types/account';

function account(id: string, name: string, accountType = 'CHEQUING'): Account {
  return {
    id,
    accountType,
    name,
    currencyCode: 'CAD',
    currentBalance: 0,
  } as Account;
}

const two = [account('acc-1', 'Everyday Chequing'), account('acc-2', 'Savings', 'SAVINGS')];

function open(accounts: Account[], currentId = 'acc-1') {
  const onSelect = vi.fn();
  render(
    <AccountSwitcher currentId={currentId} accounts={accounts} onSelect={onSelect} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));
  return { onSelect };
}

describe('AccountSwitcher', () => {
  it('renders nothing when there is no other account to switch to', () => {
    render(
      <AccountSwitcher currentId="acc-1" accounts={[two[0]]} onSelect={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Switch to another account' })).toBeNull();
  });

  it('lists the other accounts, not the current one', () => {
    open(two);
    expect(screen.getByRole('menuitem', { name: /Savings/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Everyday Chequing/ })).toBeNull();
  });

  it('names each account type, so alike-named accounts are told apart', () => {
    open(two);
    expect(screen.getByRole('menuitem', { name: /Savings/ })).toHaveTextContent('Savings');
  });

  it('selects an account and closes', () => {
    const { onSelect } = open(two);
    fireEvent.click(screen.getByRole('menuitem', { name: /Savings/ }));
    expect(onSelect).toHaveBeenCalledWith('acc-2');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('filters a long list by name or type', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      account(`acc-${index}`, `Account number ${index}`),
    );
    open(many, 'acc-0');
    fireEvent.change(screen.getByPlaceholderText('Filter accounts...'), {
      target: { value: 'number 7' },
    });
    expect(screen.getByRole('menuitem', { name: /Account number 7/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Account number 3/ })).toBeNull();
  });
});
