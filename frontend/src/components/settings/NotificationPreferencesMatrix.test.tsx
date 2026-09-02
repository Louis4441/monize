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
      { category: 'PAYMENTS', email: true, emailNotification: false, throttleMinutes: 0 },
      { category: 'BUDGETS', email: false, emailNotification: false, throttleMinutes: 0 },
    ]);
    update
      .mockReset()
      .mockResolvedValue({ category: 'PAYMENTS', email: false, emailNotification: false, throttleMinutes: 0 });
  });
  afterEach(() => cleanup());

  async function renderMatrix() {
    await act(async () => {
      render(<NotificationPreferencesMatrix />);
    });
    await act(async () => {}); // drain the mount fetch
  }

  it('renders a report-email switch per category, with in-app locked on', async () => {
    await renderMatrix();
    expect(screen.getByText('Bills and scheduled')).toBeInTheDocument();
    expect(screen.getByText('Budgets')).toBeInTheDocument();
    // Only the report email is a live control: two rows, so two switches.
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('shows notification email and cooldown as coming soon (no live control)', async () => {
    await renderMatrix();
    // Two rows x two coming-soon cells (notification email + cooldown) = four.
    expect(screen.getAllByText('Coming soon')).toHaveLength(4);
    // No cooldown select is rendered yet.
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('persists the report-email toggle for the category', async () => {
    await renderMatrix();
    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]); // PAYMENTS report email, currently on
    });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('PAYMENTS', { email: false }),
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
