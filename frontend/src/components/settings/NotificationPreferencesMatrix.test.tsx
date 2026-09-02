import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { NotificationPreferencesMatrix } from './NotificationPreferencesMatrix';

const list = vi.fn();
const update = vi.fn();
vi.mock('@/lib/notification-preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notification-preferences')>()),
  notificationPreferencesApi: {
    list: (...a: unknown[]) => list(...a),
    update: (...a: unknown[]) => update(...a),
  },
}));

describe('NotificationPreferencesMatrix', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue([
      { category: 'PAYMENTS', email: true, throttleMinutes: 0 },
      { category: 'BUDGETS', email: false, throttleMinutes: 15 },
    ]);
    update
      .mockReset()
      .mockResolvedValue({ category: 'PAYMENTS', email: false, throttleMinutes: 0 });
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
    // ...and one cooldown select per row.
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });

  it('reflects the stored cooldown window for each category', async () => {
    await renderMatrix();
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[0].value).toBe('0'); // PAYMENTS off
    expect(selects[1].value).toBe('15'); // BUDGETS every 15 min
  });

  it('persists the new value for the toggled category', async () => {
    await renderMatrix();
    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]); // PAYMENTS, currently on
    });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('PAYMENTS', { email: false }),
    );
  });

  it('persists a changed cooldown window', async () => {
    await renderMatrix();
    const paymentsSelect = screen.getAllByRole('combobox')[0];
    await act(async () => {
      fireEvent.change(paymentsSelect, { target: { value: '30' } });
    });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('PAYMENTS', { throttleMinutes: 30 }),
    );
  });

  it('reverts the toggle when the save fails', async () => {
    update.mockRejectedValue(new Error('boom'));
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
