import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { NotificationBell } from './NotificationBell';
import type { Notification } from '@/types/notification';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/budgets',
  useSearchParams: () => new URLSearchParams(),
}));

const mockGetAlerts = vi.fn();
const mockMarkAlertRead = vi.fn();
const mockMarkAllAlertsRead = vi.fn();
const mockDeleteAlert = vi.fn();
const mockDismissAlerts = vi.fn();

vi.mock('@/lib/notifications', () => ({
  notificationsApi: {
    list: (...args: any[]) => mockGetAlerts(...args),
    markRead: (...args: any[]) => mockMarkAlertRead(...args),
    markAllRead: (...args: any[]) => mockMarkAllAlertsRead(...args),
    dismiss: (...args: any[]) => mockDeleteAlert(...args),
    dismissAll: (...args: any[]) => mockDismissAlerts(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const makeNotification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'notification-1',
  userId: 'user-1',
  budgetId: 'budget-1',
  budgetCategoryId: 'bc-1',
  type: 'THRESHOLD_WARNING',
  severity: 'warning',
  title: 'Groceries reaching budget limit',
  message: 'You have used 85% of your Groceries budget.',
  data: {},
  isRead: false,
  isEmailSent: false,
  periodStart: '2026-02-01',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAlerts.mockResolvedValue([]);
    mockMarkAlertRead.mockResolvedValue({});
    mockMarkAllAlertsRead.mockResolvedValue({ updated: 0 });
    mockDeleteAlert.mockResolvedValue(undefined);
    mockDismissAlerts.mockResolvedValue({ dismissed: 0 });
  });

  it('renders the bell icon button', async () => {
    render(<NotificationBell />);
    await act(async () => {});

    expect(screen.getByTestId('notification-badge-button')).toBeInTheDocument();
  });

  it('fetches notifications on mount', async () => {
    render(<NotificationBell />);
    await act(async () => {});

    expect(mockGetAlerts).toHaveBeenCalled();
  });

  it('shows unread count badge when there are unread notifications', async () => {
    mockGetAlerts.mockResolvedValue([
      makeNotification({ id: 'a1', isRead: false }),
      makeNotification({ id: 'a2', isRead: false }),
      makeNotification({ id: 'a3', isRead: true }),
    ]);

    render(<NotificationBell />);
    await act(async () => {});

    expect(screen.getByTestId('unread-count')).toHaveTextContent('2');
  });

  it('does not show badge when all notifications are read', async () => {
    mockGetAlerts.mockResolvedValue([
      makeNotification({ id: 'a1', isRead: true }),
    ]);

    render(<NotificationBell />);
    await act(async () => {});

    expect(screen.queryByTestId('unread-count')).not.toBeInTheDocument();
  });

  it('shows 9+ when there are more than 9 unread notifications', async () => {
    const notifications = Array.from({ length: 12 }, (_, i) =>
      makeNotification({ id: `a${i}`, isRead: false }),
    );
    mockGetAlerts.mockResolvedValue(notifications);

    render(<NotificationBell />);
    await act(async () => {});

    expect(screen.getByTestId('unread-count')).toHaveTextContent('9+');
  });

  it('opens notification list dropdown when clicked', async () => {
    mockGetAlerts.mockResolvedValue([makeNotification()]);

    render(<NotificationBell />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('notification-badge-button'));

    expect(screen.getByTestId('notification-list')).toBeInTheDocument();
  });

  it('closes dropdown when clicking outside', async () => {
    mockGetAlerts.mockResolvedValue([makeNotification()]);

    render(<NotificationBell />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('notification-badge-button'));
    expect(screen.getByTestId('notification-list')).toBeInTheDocument();

    fireEvent.mouseDown(document);

    expect(screen.queryByTestId('notification-list')).not.toBeInTheDocument();
  });

  it('marks notification as read when clicked', async () => {
    mockGetAlerts.mockResolvedValue([makeNotification({ id: 'a1', isRead: false })]);

    render(<NotificationBell />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('notification-badge-button'));
    fireEvent.click(screen.getByTestId('notification-item-a1'));

    await waitFor(() => {
      expect(mockMarkAlertRead).toHaveBeenCalledWith('a1');
    });
  });

  it('marks all notifications as read when mark all read is clicked', async () => {
    mockGetAlerts.mockResolvedValue([
      makeNotification({ id: 'a1', isRead: false }),
      makeNotification({ id: 'a2', isRead: false }),
    ]);

    render(<NotificationBell />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('notification-badge-button'));
    fireEvent.click(screen.getByTestId('mark-all-read'));

    await waitFor(() => {
      expect(mockMarkAllAlertsRead).toHaveBeenCalled();
    });
  });

  it('shows empty state when no notifications', async () => {
    mockGetAlerts.mockResolvedValue([]);

    render(<NotificationBell />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('notification-badge-button'));

    expect(screen.getByTestId('no-notifications')).toHaveTextContent('No notifications');
  });

  it('navigates to budget page when notification is clicked', async () => {
    mockGetAlerts.mockResolvedValue([
      makeNotification({ id: 'a1', budgetId: 'budget-123', isRead: true }),
    ]);

    render(<NotificationBell />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('notification-badge-button'));
    fireEvent.click(screen.getByTestId('notification-item-a1'));

    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-123');
  });

  it('handles API failure gracefully', async () => {
    mockGetAlerts.mockRejectedValue(new Error('Network error'));

    render(<NotificationBell />);
    await act(async () => {});

    // Should not throw, badge should render without count
    expect(screen.queryByTestId('unread-count')).not.toBeInTheDocument();
  });

  it('shows inline undo when dismiss is clicked', async () => {
    mockGetAlerts.mockResolvedValue([
      makeNotification({ id: 'a1', isRead: false }),
      makeNotification({ id: 'a2', isRead: false }),
    ]);

    render(<NotificationBell />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('notification-badge-button'));
    expect(screen.getByTestId('notification-item-a1')).toBeInTheDocument();
    expect(screen.getByTestId('notification-item-a2')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('dismiss-notification-a1'));

    // Alert content replaced with Undo
    expect(screen.queryByTestId('notification-item-a1')).not.toBeInTheDocument();
    expect(screen.getByTestId('undo-dismiss-a1')).toBeInTheDocument();
    // Other notification remains normal
    expect(screen.getByTestId('notification-item-a2')).toBeInTheDocument();
  });

  it('restores notification when undo is clicked', async () => {
    mockGetAlerts.mockResolvedValue([
      makeNotification({ id: 'a1', isRead: false }),
    ]);

    render(<NotificationBell />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('notification-badge-button'));
    fireEvent.click(screen.getByTestId('dismiss-notification-a1'));

    // Undo is shown
    expect(screen.getByTestId('undo-dismiss-a1')).toBeInTheDocument();

    // Click undo
    fireEvent.click(screen.getByTestId('undo-dismiss-a1'));

    // Alert is restored
    expect(screen.getByTestId('notification-item-a1')).toBeInTheDocument();
    expect(screen.queryByTestId('undo-dismiss-a1')).not.toBeInTheDocument();
  });

  describe('filtering', () => {
    const mixedAlerts = [
      makeNotification({ id: 'crit-fin', severity: 'critical', type: 'OVER_BUDGET' }),
      makeNotification({ id: 'warn-fin', severity: 'warning', type: 'BILL_DUE', title: 'Hydro bill due' }),
      makeNotification({ id: 'crit-sys', severity: 'critical', type: 'BACKUP_FAILED', title: 'Backup failed' }),
    ];

    it('narrows the list to the selected severity and clears on re-click', async () => {
      mockGetAlerts.mockResolvedValue(mixedAlerts);

      render(<NotificationBell />);
      await act(async () => {});
      fireEvent.click(screen.getByTestId('notification-badge-button'));

      fireEvent.click(screen.getByTestId('notification-filter-severity-critical'));

      expect(screen.getByTestId('notification-item-crit-fin')).toBeInTheDocument();
      expect(screen.getByTestId('notification-item-crit-sys')).toBeInTheDocument();
      expect(screen.queryByTestId('notification-item-warn-fin')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('notification-filter-severity-critical'));
      expect(screen.getByTestId('notification-item-warn-fin')).toBeInTheDocument();
    });

    it('narrows the list to system or financial notifications', async () => {
      mockGetAlerts.mockResolvedValue(mixedAlerts);

      render(<NotificationBell />);
      await act(async () => {});
      fireEvent.click(screen.getByTestId('notification-badge-button'));

      fireEvent.click(screen.getByTestId('notification-filter-category-system'));
      expect(screen.getByTestId('notification-item-crit-sys')).toBeInTheDocument();
      expect(screen.queryByTestId('notification-item-crit-fin')).not.toBeInTheDocument();
      expect(screen.queryByTestId('notification-item-warn-fin')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('notification-filter-category-financial'));
      expect(screen.queryByTestId('notification-item-crit-sys')).not.toBeInTheDocument();
      expect(screen.getByTestId('notification-item-crit-fin')).toBeInTheDocument();
      expect(screen.getByTestId('notification-item-warn-fin')).toBeInTheDocument();
    });

    it('combines both filter dimensions', async () => {
      mockGetAlerts.mockResolvedValue(mixedAlerts);

      render(<NotificationBell />);
      await act(async () => {});
      fireEvent.click(screen.getByTestId('notification-badge-button'));

      fireEvent.click(screen.getByTestId('notification-filter-severity-critical'));
      fireEvent.click(screen.getByTestId('notification-filter-category-financial'));

      expect(screen.getByTestId('notification-item-crit-fin')).toBeInTheDocument();
      expect(screen.queryByTestId('notification-item-crit-sys')).not.toBeInTheDocument();
      expect(screen.queryByTestId('notification-item-warn-fin')).not.toBeInTheDocument();
    });

    it('keeps the bell count about every notification, not the filtered view', async () => {
      mockGetAlerts.mockResolvedValue(mixedAlerts);

      render(<NotificationBell />);
      await act(async () => {});
      fireEvent.click(screen.getByTestId('notification-badge-button'));
      fireEvent.click(screen.getByTestId('notification-filter-severity-critical'));

      expect(screen.getByTestId('unread-count')).toHaveTextContent('3');
    });
  });

  describe('delete all', () => {
    it('confirms, sends the active filter on the command, and removes the matching notifications', async () => {
      mockGetAlerts.mockResolvedValue([
        makeNotification({ id: 'crit-fin', severity: 'critical', type: 'OVER_BUDGET' }),
        makeNotification({ id: 'warn-fin', severity: 'warning', type: 'BILL_DUE', title: 'Hydro bill due' }),
      ]);
      mockDismissAlerts.mockResolvedValue({ dismissed: 4 });

      render(<NotificationBell />);
      await act(async () => {});
      fireEvent.click(screen.getByTestId('notification-badge-button'));
      fireEvent.click(screen.getByTestId('notification-filter-severity-critical'));

      fireEvent.click(screen.getByTestId('delete-all-notifications'));
      expect(screen.getByText('Delete notifications')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      });

      expect(mockDismissAlerts).toHaveBeenCalledWith({
        severity: 'critical',
        category: undefined,
      });
      // The critical notification is gone; clearing the filter shows the survivor.
      expect(screen.queryByTestId('notification-item-crit-fin')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('notification-filter-severity-critical'));
      expect(screen.getByTestId('notification-item-warn-fin')).toBeInTheDocument();
    });

    it('deletes everything when no filter is active', async () => {
      mockGetAlerts.mockResolvedValue([
        makeNotification({ id: 'a1' }),
        makeNotification({ id: 'a2', severity: 'critical' }),
      ]);
      mockDismissAlerts.mockResolvedValue({ dismissed: 2 });

      render(<NotificationBell />);
      await act(async () => {});
      fireEvent.click(screen.getByTestId('notification-badge-button'));
      fireEvent.click(screen.getByTestId('delete-all-notifications'));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      });

      expect(mockDismissAlerts).toHaveBeenCalledWith({
        severity: undefined,
        category: undefined,
      });
      expect(screen.getByTestId('no-notifications')).toBeInTheDocument();
      expect(screen.queryByTestId('unread-count')).not.toBeInTheDocument();
    });

    it('does not call the API when the confirm is cancelled', async () => {
      mockGetAlerts.mockResolvedValue([makeNotification({ id: 'a1' })]);

      render(<NotificationBell />);
      await act(async () => {});
      fireEvent.click(screen.getByTestId('notification-badge-button'));
      fireEvent.click(screen.getByTestId('delete-all-notifications'));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      });

      expect(mockDismissAlerts).not.toHaveBeenCalled();
      expect(screen.getByTestId('notification-item-a1')).toBeInTheDocument();
    });

    it('keeps the notifications and reports the failure when the API rejects', async () => {
      const toast = (await import('react-hot-toast')).default;
      mockGetAlerts.mockResolvedValue([makeNotification({ id: 'a1' })]);
      mockDismissAlerts.mockRejectedValue(new Error('boom'));

      render(<NotificationBell />);
      await act(async () => {});
      fireEvent.click(screen.getByTestId('notification-badge-button'));
      fireEvent.click(screen.getByTestId('delete-all-notifications'));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      });
      await act(async () => {}); // flush the rejection handler

      expect(screen.getByTestId('notification-item-a1')).toBeInTheDocument();
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });

    it('reports the server count, which can exceed the rows on screen', async () => {
      const toast = (await import('react-hot-toast')).default;
      mockGetAlerts.mockResolvedValue([makeNotification({ id: 'a1' })]);
      mockDismissAlerts.mockResolvedValue({ dismissed: 60 });

      render(<NotificationBell />);
      await act(async () => {});
      fireEvent.click(screen.getByTestId('notification-badge-button'));
      fireEvent.click(screen.getByTestId('delete-all-notifications'));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      });

      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('60 notifications deleted');
    });
  });
});
