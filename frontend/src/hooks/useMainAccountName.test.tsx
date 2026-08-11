import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useMainAccountName, useAccountOptionLabel } from './useMainAccountName';
import { Account } from '@/types/account';
import messages from '@/i18n/messages/en/accounts.json';

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={{ accounts: messages }}>
      {children}
    </NextIntlClientProvider>
  );
}

const cashHalf = {
  id: 'cash',
  name: 'TFSA - Cash',
  currencyCode: 'CAD',
  isClosed: false,
} as Account;

describe('useMainAccountName', () => {
  it('strips the pair suffixes', () => {
    const { result } = renderHook(() => useMainAccountName(), { wrapper });

    expect(result.current('TFSA - Brokerage')).toBe('TFSA');
    expect(result.current('TFSA - Cash')).toBe('TFSA');
    expect(result.current('Chequing')).toBe('Chequing');
  });

  // The stripper is a dependency of memos and effects across the reports and
  // the account surfaces. Keyed on `t` it changed identity every render, so
  // every memo built on it recomputed and every effect depending on one re-ran.
  it('keeps a stable identity across renders', () => {
    const { result, rerender } = renderHook(() => useMainAccountName(), {
      wrapper,
    });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});

describe('useAccountOptionLabel', () => {
  it('labels an option with the entity name and currency, suffix stripped', () => {
    const { result } = renderHook(() => useAccountOptionLabel(), { wrapper });

    expect(result.current(cashHalf)).toBe('TFSA (CAD)');
  });

  it('marks a closed account with the translated status word', () => {
    const { result } = renderHook(() => useAccountOptionLabel(), { wrapper });

    expect(result.current({ ...cashHalf, isClosed: true })).toBe(
      'TFSA (CAD) (Closed)',
    );
  });

  it('keeps a stable identity across renders', () => {
    const { result, rerender } = renderHook(() => useAccountOptionLabel(), {
      wrapper,
    });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
