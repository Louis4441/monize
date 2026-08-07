import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  INVESTMENT_TRANSACTION_SUBMIT_MODE_KEY,
  TRANSACTION_SUBMIT_MODE_KEY,
  isTransactionSubmitMode,
  useTransactionSubmitMode,
} from './useTransactionSubmitMode';

describe('useTransactionSubmitMode', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to close, the behaviour the button had before the choice existed', () => {
    const { result } = renderHook(() =>
      useTransactionSubmitMode(TRANSACTION_SUBMIT_MODE_KEY),
    );
    expect(result.current[0]).toBe('close');
  });

  it('persists a choice and restores it on the next mount', () => {
    const { result, unmount } = renderHook(() =>
      useTransactionSubmitMode(TRANSACTION_SUBMIT_MODE_KEY),
    );
    act(() => result.current[1]('new'));
    expect(result.current[0]).toBe('new');
    unmount();

    const remounted = renderHook(() =>
      useTransactionSubmitMode(TRANSACTION_SUBMIT_MODE_KEY),
    );
    expect(remounted.result.current[0]).toBe('new');
  });

  it('keeps the regular and investment choices apart', () => {
    // Entering a batch of receipts must not change what the trade form's
    // button does, so the two keys are genuinely distinct storage.
    const regular = renderHook(() =>
      useTransactionSubmitMode(TRANSACTION_SUBMIT_MODE_KEY),
    );
    const investment = renderHook(() =>
      useTransactionSubmitMode(INVESTMENT_TRANSACTION_SUBMIT_MODE_KEY),
    );

    act(() => regular.result.current[1]('new'));

    expect(regular.result.current[0]).toBe('new');
    expect(investment.result.current[0]).toBe('close');
    expect(TRANSACTION_SUBMIT_MODE_KEY).not.toBe(
      INVESTMENT_TRANSACTION_SUBMIT_MODE_KEY,
    );
  });

  it('falls back to close for a stored value that is not a mode', () => {
    window.localStorage.setItem(
      TRANSACTION_SUBMIT_MODE_KEY,
      JSON.stringify('createAndNew'),
    );
    const { result } = renderHook(() =>
      useTransactionSubmitMode(TRANSACTION_SUBMIT_MODE_KEY),
    );
    // An unrecognised value must not be treated as "keep the window open":
    // silently repeating an action the user did not choose is the worse half
    // of the two behaviours to guess at.
    expect(result.current[0]).toBe('close');
  });

  it('falls back to close for an unparseable entry', () => {
    window.localStorage.setItem(TRANSACTION_SUBMIT_MODE_KEY, 'not-json');
    const { result } = renderHook(() =>
      useTransactionSubmitMode(TRANSACTION_SUBMIT_MODE_KEY),
    );
    expect(result.current[0]).toBe('close');
  });

  it('recognises exactly the two modes', () => {
    expect(isTransactionSubmitMode('close')).toBe(true);
    expect(isTransactionSubmitMode('new')).toBe(true);
    expect(isTransactionSubmitMode('')).toBe(false);
    expect(isTransactionSubmitMode(null)).toBe(false);
    expect(isTransactionSubmitMode({ mode: 'new' })).toBe(false);
  });
});
