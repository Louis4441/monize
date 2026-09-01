import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { NotificationPreferencesMatrix } from './NotificationPreferencesMatrix';

const list = vi.fn();
const setEmail = vi.fn();
vi.mock('@/lib/notification-preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notification-preferences')>()),
  notificationPreferencesApi: {
    list: (...a: unknown[]) => list(...a),
    setEmail: (...a: unknown[]) => setEmail(...a),
  },
}));

describe('NotificationPreferencesMatrix', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue([
      { category: 'PAYMENTS', email: true },
      { category: 'BUDGETS', email: false },
    ]);
    setEmail
      .mockReset()
      .mockResolvedValue({ category: 'PAYMENTS', email: false });
  });
  afterEach(() => cleanup());

  async function renderMatrix() {
    await act(async () => {
      render(<NotificationPreferencesMatrix />);
    });
    await act(async () => {}); // drain the mount fetch
  }

  it('renders a row per exposed category', async () => {
    await renderMatrix();
    expect(screen.getByText('Bills and scheduled')).toBeInTheDocument();
    expect(screen.getByText('Budgets')).toBeInTheDocument();
    // In-app is always on: two rows, so two switches (the email column only).
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('persists the new value for the toggled category', async () => {
    await renderMatrix();
    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]); // PAYMENTS, currently on
    });
    await waitFor(() =>
      expect(setEmail).toHaveBeenCalledWith('PAYMENTS', false),
    );
  });

  it('reverts the toggle when the save fails', async () => {
    setEmail.mockRejectedValue(new Error('boom'));
    await renderMatrix();
    const paymentsSwitch = screen.getAllByRole('switch')[0];
    expect(paymentsSwitch.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      fireEvent.click(paymentsSwitch);
    });
    await act(async () => {}); // drain the rejection handler
    await waitFor(() =>
      expect(paymentsSwitch.getAttribute('aria-checked')).toBe('true'),
    );
  });
});
