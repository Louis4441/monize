import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { StoredBackupsSubsection } from './StoredBackupsSubsection';
import { useAuthStore } from '@/store/authStore';
import type { User } from '@/types/auth';

vi.mock('@/lib/backupApi', () => ({
  backupApi: {
    listStoredBackups: vi.fn(),
    downloadStoredBackup: vi.fn(),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      preferences: {
        timezone: 'UTC',
        dateFormat: 'YYYY-MM-DD',
        timeFormat: '24h',
      },
    }),
  ),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => numberFormatMockDefaults() };
});

import { backupApi } from '@/lib/backupApi';
import toast from 'react-hot-toast';

const daily = {
  filename: 'monize-backup-daily-2026-04-15.json.gz',
  modifiedAt: '2026-04-15T02:00:00.000Z',
  size: 2048,
  encrypted: false,
};

const adminUser = { id: 'u1', role: 'admin', authProvider: 'local' } as User;
const regularUser = { id: 'u2', role: 'user', authProvider: 'local' } as User;

const listMock = backupApi.listStoredBackups as ReturnType<typeof vi.fn>;
const downloadMock = backupApi.downloadStoredBackup as ReturnType<typeof vi.fn>;

async function renderSubsection(onRestore = vi.fn()) {
  await act(async () => {
    render(<StoredBackupsSubsection onRestore={onRestore} />);
  });
  return onRestore;
}

async function expand() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('stored-backups-summary'));
  });
}

/**
 * Whether the listing is folded, read off the element that does the folding.
 *
 * jsdom applies no user-agent stylesheet to `<details>`, so its children stay
 * in the document whatever `open` says -- asserting the table has gone would
 * pass in a browser and fail here for a reason that has nothing to do with
 * this component. `open` is the mechanism, so `open` is what is asserted.
 */
function isFolded(): boolean {
  const details = screen
    .getByTestId('stored-backups-summary')
    .closest('details');
  return details !== null && !details.open;
}

describe('StoredBackupsSubsection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: regularUser, isAuthenticated: true });
    HTMLAnchorElement.prototype.click = vi.fn();
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    global.URL.revokeObjectURL = vi.fn();
  });

  it('renders nothing when no schedule is armed and nothing is stored', async () => {
    listMock.mockResolvedValue({ enabled: false, backups: [] });

    const { container } = await act(async () =>
      render(<StoredBackupsSubsection onRestore={vi.fn()} />),
    );

    // A deployment that runs no automatic backups has nothing to say here, so
    // the section is not part of the page at all.
    expect(container.textContent).toBe('');
  });

  it('still renders when the schedule was turned off but artifacts remain', async () => {
    listMock.mockResolvedValue({ enabled: false, backups: [daily] });

    await renderSubsection();

    // Those files are recoverable data and this is the only screen that can
    // hand them back.
    expect(screen.getByText('Automatic Backups')).toBeInTheDocument();
  });

  it('starts folded, and lists the artifacts once expanded', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });

    await renderSubsection();

    expect(screen.getByText('Automatic Backups')).toBeInTheDocument();
    expect(isFolded()).toBe(true);

    await expand();

    expect(isFolded()).toBe(false);
    expect(screen.getByText(daily.filename)).toBeInTheDocument();
    // The file's own modification time, in the reader's timezone and format.
    expect(screen.getByText('2026-04-15 02:00')).toBeInTheDocument();
    expect(screen.getByText('2.0 kB')).toBeInTheDocument();
  });

  it('wraps each row into a grid card with the actions stacked on the right', async () => {
    // One tree restyled by CSS: below `sm` the row is a three-line grid card
    // carrying the filename, then the modification time, then the size beside
    // the two stacked buttons; from `sm` up it is the ordinary table. jsdom
    // applies no breakpoint, so the classes and the captions that ride in the
    // markup at every width are what is asserted.
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });

    await renderSubsection();
    await expand();

    const row = screen
      .getAllByRole('row')
      .find((r) => r.className.includes('grid-cols-[minmax(0,1fr)_auto]'));
    expect(row).toBeDefined();
    // The phone card gives the table row back at `sm`, so no desktop width
    // renders the card.
    expect(row!.className).toContain('sm:table-row');

    // The filename takes a line of its own rather than a column shared with
    // three other cells: that crowding is what the wrap exists to undo.
    const cells = screen.getAllByRole('cell');
    const filenameCell = cells.find((c) => c.textContent === daily.filename);
    expect(filenameCell!.className).toContain('col-span-2');
    expect(filenameCell!.className).toContain('row-start-1');

    // The buttons stack in the right-hand track, sharing their line with the
    // size and nothing longer: the track is as wide as the longest translated
    // button label, so a datetime beside it would overflow a 320px phone.
    // `sm:flex-row` is the desktop pair the table always drew.
    const actionsCell = cells.find((c) => c.className.includes('col-start-2'));
    expect(actionsCell!.className).toContain('row-start-3');
    const sizeCell = cells.find((c) => c.textContent?.includes('2.0 kB'));
    expect(sizeCell!.className).toContain('col-start-1');
    expect(sizeCell!.className).toContain('row-start-3');
    const modifiedCell = cells.find((c) =>
      c.textContent?.includes('2026-04-15 02:00'),
    );
    expect(modifiedCell!.className).toContain('col-span-2');
    const buttons = actionsCell!.querySelector('div');
    expect(buttons!.className).toContain('flex-col');
    expect(buttons!.className).toContain('sm:flex-row');

    // Each bare figure names the column a phone reader can no longer see in a
    // header: the caption plus the header cell that stays in the DOM.
    for (const caption of ['Date Modified', 'Size']) {
      expect(screen.getAllByText(caption)).toHaveLength(2);
    }
  });

  it('points an administrator at the page that holds the schedule', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });

    await renderSubsection();
    await expand();

    const link = screen.getByRole('link', { name: 'Admin → Backups' });
    expect(link).toHaveAttribute('href', '/admin/backups');
  });

  it('withholds the schedule link from a reader who cannot open it', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });

    await renderSubsection();
    await expand();

    // `/admin/backups` refuses a non-administrator, so offering the route here
    // would only ever send this reader to a page that turns them away.
    expect(
      screen.queryByRole('link', { name: 'Admin → Backups' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Automatic backup settings are in/),
    ).not.toBeInTheDocument();
  });

  it('says so when the server is holding nothing yet', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [] });

    await renderSubsection();
    await expand();

    expect(
      screen.getByText(
        'This server is not holding any automatic backups for you yet.',
      ),
    ).toBeInTheDocument();
  });

  it('reports a failed listing instead of rendering it as an empty folder', async () => {
    listMock.mockRejectedValue(new Error('boom'));

    await renderSubsection();
    await expand();

    // Hiding the section or showing "nothing stored" would both tell the reader
    // their server is holding no backups, which is the one answer that must
    // never be guessed here.
    expect(
      screen.getByText('Failed to load the backups stored on the server'),
    ).toBeInTheDocument();

    listMock.mockResolvedValue({ enabled: true, backups: [daily] });
    await act(async () => {
      fireEvent.click(screen.getByText('Try Again'));
    });
    expect(screen.getByText(daily.filename)).toBeInTheDocument();
  });

  it('downloads an artifact under the name the server gave it', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });
    downloadMock.mockResolvedValue(new File(['bytes'], daily.filename));

    await renderSubsection();
    await expand();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    });

    expect(downloadMock).toHaveBeenCalledWith(daily.filename);
    // The copy on the user's disk still says which recovery point it is.
    expect(
      (HTMLAnchorElement.prototype.click as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
  });

  it('hands a restore to the caller rather than restoring here', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });
    const file = new File(['bytes'], daily.filename);
    downloadMock.mockResolvedValue(file);

    const onRestore = await renderSubsection();
    await expand();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    });

    expect(onRestore).toHaveBeenCalledWith(file);
  });

  it('toasts and calls nobody back when the download fails', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });
    downloadMock.mockRejectedValue(new Error('gone'));

    const onRestore = await renderSubsection();
    await expand();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    });

    expect(toast.error).toHaveBeenCalledWith('Failed to download the backup');
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('re-reads the folder on each expand', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });

    await renderSubsection();
    expect(listMock).toHaveBeenCalledTimes(1);

    await expand();
    // Retention deletes and the schedule writes while this page is open, so a
    // second look is the honest one.
    expect(listMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      fireEvent.click(screen.getByTestId('stored-backups-summary'));
    });
    expect(isFolded()).toBe(true);
    // Folding is not a read.
    expect(listMock).toHaveBeenCalledTimes(2);
  });
});
