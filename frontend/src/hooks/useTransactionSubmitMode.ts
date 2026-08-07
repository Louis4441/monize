'use client';

import { useCallback } from 'react';
import { useLocalStorage } from './useLocalStorage';

/**
 * What the transaction form does once a *new* transaction has been created:
 * `close` hands back to the page (which closes the modal), `new` keeps the
 * window open and starts a fresh entry pre-filled the way opening it from the
 * page would be. Editing an existing transaction always closes, so this only
 * ever applies to a create.
 */
export type TransactionSubmitMode = 'close' | 'new';

/**
 * Regular and investment transactions are entered in different rhythms -- a
 * batch of receipts versus a single trade -- so each remembers its own choice
 * under its own key, the way `lastTransactionDate.ts` keeps the two remembered
 * dates apart.
 */
export const TRANSACTION_SUBMIT_MODE_KEY = 'monize-transaction-submit-mode';
export const INVESTMENT_TRANSACTION_SUBMIT_MODE_KEY =
  'monize-investment-transaction-submit-mode';

const MODES: readonly TransactionSubmitMode[] = ['close', 'new'];

/** True for the two values this preference is allowed to hold. */
export function isTransactionSubmitMode(
  value: unknown,
): value is TransactionSubmitMode {
  return MODES.includes(value as TransactionSubmitMode);
}

/**
 * Read and persist the submit-button behaviour for one kind of transaction.
 * Anything else found under the key (a hand-edited value, a shape from an
 * older build) falls back to `close`, which is the behaviour the button had
 * before this preference existed.
 */
export function useTransactionSubmitMode(
  key: string,
): [TransactionSubmitMode, (mode: TransactionSubmitMode) => void] {
  const [stored, setStored] = useLocalStorage<unknown>(key, 'close');

  const setMode = useCallback(
    (mode: TransactionSubmitMode) => setStored(mode),
    [setStored],
  );

  return [isTransactionSubmitMode(stored) ? stored : 'close', setMode];
}
