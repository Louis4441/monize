import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRANSACTION_SORT,
  TRANSACTION_SORT_FIELDS,
  isSortedByDate,
  nextTransactionSort,
  resolveRegisterSort,
} from './transaction-sort';
import type { TransactionSort } from './transaction-sort';

describe('nextTransactionSort', () => {
  it('reverses the column that is already sorted', () => {
    expect(
      nextTransactionSort({ field: 'date', direction: 'desc' }, 'date'),
    ).toEqual({
      field: 'date',
      direction: 'asc',
    });
    expect(
      nextTransactionSort({ field: 'date', direction: 'asc' }, 'date'),
    ).toEqual({
      field: 'date',
      direction: 'desc',
    });
    expect(
      nextTransactionSort({ field: 'payee', direction: 'asc' }, 'payee'),
    ).toEqual({
      field: 'payee',
      direction: 'desc',
    });
  });

  it('starts a new column in the direction that column is read', () => {
    // A register is read newest first; a name column is read A to Z.
    expect(
      nextTransactionSort({ field: 'payee', direction: 'asc' }, 'date'),
    ).toEqual({
      field: 'date',
      direction: 'desc',
    });
    expect(
      nextTransactionSort({ field: 'date', direction: 'desc' }, 'payee'),
    ).toEqual({
      field: 'payee',
      direction: 'asc',
    });
    expect(
      nextTransactionSort({ field: 'payee', direction: 'desc' }, 'category'),
    ).toEqual({
      field: 'category',
      direction: 'asc',
    });
  });

  it('starts every column somewhere', () => {
    for (const field of TRANSACTION_SORT_FIELDS) {
      const next = nextTransactionSort(DEFAULT_TRANSACTION_SORT, field);
      expect(next.field).toBe(field);
      expect(['asc', 'desc']).toContain(next.direction);
    }
  });
});

describe('resolveRegisterSort', () => {
  it('drops an account sort where there is no Account column to click', () => {
    // The column is not rendered on a single account's page, so a stored
    // account sort would order the register by a header nobody can reach.
    const stored: TransactionSort = { field: 'account', direction: 'asc' };
    expect(resolveRegisterSort(stored, true)).toEqual(DEFAULT_TRANSACTION_SORT);
    // Storage is untouched, so widening the filter brings it back.
    expect(resolveRegisterSort(stored, false)).toBe(stored);
  });

  it('leaves every other field alone on either kind of page', () => {
    for (const field of TRANSACTION_SORT_FIELDS.filter(
      (f) => f !== 'account',
    )) {
      const sort: TransactionSort = { field, direction: 'asc' };
      expect(resolveRegisterSort(sort, true)).toBe(sort);
      expect(resolveRegisterSort(sort, false)).toBe(sort);
    }
  });
});

describe('isSortedByDate', () => {
  it('is true for a register that offers no sorting at all', () => {
    // Every surface but the Transactions page renders plain headers and takes
    // the server's default order, which is by date.
    expect(isSortedByDate(undefined)).toBe(true);
  });

  it('is true in either date direction and false for every other column', () => {
    expect(isSortedByDate({ field: 'date', direction: 'asc' })).toBe(true);
    expect(isSortedByDate({ field: 'date', direction: 'desc' })).toBe(true);
    for (const field of TRANSACTION_SORT_FIELDS.filter((f) => f !== 'date')) {
      expect(isSortedByDate({ field, direction: 'asc' })).toBe(false);
    }
  });
});
