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

const listDevices = vi.fn();
vi.mock('@/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push')>()),
  pushApi: { listDevices: (...a: unknown[]) => listDevices(...a) },
}));

const liveDevice = { id: 'd1', disabledAt: null };
const disabledDevice = { id: 'd2', disabledAt: '2026-09-01T00:00:00Z' };

describe('NotificationPreferencesMatrix', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue([
      { category: 'PAYMENTS', email: true, emailNotification: false, push: false, throttleMinutes: 0 },
      { category: 'BUDGETS', email: false, emailNotification: true, push: false, throttleMinutes: 15 },
      { category: 'SYSTEM', email: false, emailNotification: false, push: true, throttleMinutes: 30 },
    ]);
    update
      .mockReset()
      .mockResolvedValue({ category: 'PAYMENTS', email: false, emailNotification: false, push: false, throttleMinutes: 0 });
    // One live device by default, so the push column is a real control.
    listDevices.mockReset().mockResolvedValue([liveDevice, disabledDevice]);
  });
  afterEach(() => cleanup());

  async function renderMatrix(emailAvailable = true) {
    await act(async () => {
      render(<NotificationPreferencesMatrix emailAvailable={emailAvailable} />);
    });
    await act(async () => {}); // drain the mount fetches (prefs + devices)
  }

  it('renders every category with three channel switches and a cooldown select', async () => {
    await renderMatrix();
    expect(screen.getByText('Bills and scheduled')).toBeInTheDocument();
    expect(screen.getByText('Budgets')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    // report + alert + push, per row (3 rows) = 9 switches.
    expect(screen.getAllByRole('switch')).toHaveLength(9);
    // One cooldown select per row.
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
  });

  it('gates the email columns on email availability', async () => {
    await renderMatrix(false);
    // With email unavailable the report and alert switches are disabled...
    const switches = screen.getAllByRole('switch');
    // Rows render report, alert, push in order; the two email switches per row
    // are disabled, the push one is not (a device is live).
    expect(switches[0]).toBeDisabled(); // PAYMENTS report
    expect(switches[1]).toBeDisabled(); // PAYMENTS alert
    expect(switches[2]).not.toBeDisabled(); // PAYMENTS push
    expect(
      screen.getByText('Turn on email notifications above to send these by email.'),
    ).toBeInTheDocument();
  });

  it('disables the push column and explains why when no device is live', async () => {
    listDevices.mockResolvedValue([disabledDevice]);
    await renderMatrix();
    const switches = screen.getAllByRole('switch');
    expect(switches[2]).toBeDisabled(); // PAYMENTS push
    expect(
      screen.getByText('Enable push on this device first (see below).'),
    ).toBeInTheDocument();
  });

  it('persists each channel toggle for its category', async () => {
    await renderMatrix();
    const switches = screen.getAllByRole('switch');
    await act(async () => fireEvent.click(switches[0])); // PAYMENTS report on -> off
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('PAYMENTS', { email: false }),
    );
    await act(async () => fireEvent.click(switches[1])); // PAYMENTS alert off -> on
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('PAYMENTS', { emailNotification: true }),
    );
    await act(async () => fireEvent.click(switches[2])); // PAYMENTS push off -> on
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('PAYMENTS', { push: true }),
    );
  });

  it('enables the cooldown only where an interrupting channel is on, and saves the window', async () => {
    await renderMatrix();
    const selects = screen.getAllByRole('combobox');
    // PAYMENTS has neither alert email nor push on -> cooldown disabled.
    expect(selects[0]).toBeDisabled();
    // BUDGETS has alert email on -> cooldown editable.
    expect(selects[1]).not.toBeDisabled();
    await act(async () =>
      fireEvent.change(selects[1], { target: { value: '60' } }),
    );
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('BUDGETS', { throttleMinutes: 60 }),
    );
  });

  it('reverts the toggle when the save fails', async () => {
    update.mockRejectedValue(new Error('boom'));
    await renderMatrix();
    const paymentsReport = screen.getAllByRole('switch')[0];
    expect(paymentsReport.getAttribute('aria-checked')).toBe('true');
    await act(async () => fireEvent.click(paymentsReport));
    await act(async () => {}); // drain the rejection handler
    await waitFor(() =>
      expect(paymentsReport.getAttribute('aria-checked')).toBe('true'),
    );
  });
});
