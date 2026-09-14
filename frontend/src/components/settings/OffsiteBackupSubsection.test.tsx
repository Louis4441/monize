import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { OffsiteBackupSubsection } from './OffsiteBackupSubsection';
import type {
  BackupOffsiteSettingsView,
  BackupOffsiteUpload,
} from '@/lib/backupApi';

vi.mock('@/lib/backupApi', () => ({
  backupApi: {
    getOffsiteSettings: vi.fn(),
    updateOffsiteSettings: vi.fn(),
    listOffsiteUploads: vi.fn(),
  },
  OFFSITE_UPLOADS_PAGE_SIZE: 20,
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

const getMock = backupApi.getOffsiteSettings as ReturnType<typeof vi.fn>;
const updateMock = backupApi.updateOffsiteSettings as ReturnType<typeof vi.fn>;
const uploadsMock = backupApi.listOffsiteUploads as ReturnType<typeof vi.fn>;

const offView: BackupOffsiteSettingsView = {
  s3Mode: 'off',
  s3Bucket: null,
  s3Region: null,
  s3Prefix: null,
  s3Endpoint: null,
  s3ForcePathStyle: false,
  s3AccessKeyIdSet: false,
  s3SecretAccessKeySet: false,
  emailEnabled: false,
  emailTo: null,
  deploymentS3Available: true,
  encryptionConfigured: true,
};

const ownView: BackupOffsiteSettingsView = {
  ...offView,
  s3Mode: 'own',
  s3Bucket: 'my-bucket',
  s3Region: 'us-east-1',
  s3AccessKeyIdSet: true,
  s3SecretAccessKeySet: true,
};

function upload(overrides: Partial<BackupOffsiteUpload>): BackupOffsiteUpload {
  return {
    id: 'up-1',
    destination: 's3',
    objectKey: 'backups/ab/cd/user/monize-backup-daily-2026-09-14-9f3c1a2b4d5e.mzbe',
    tier: 'daily',
    digest: '9f3c1a2b4d5e'.padEnd(64, '0'),
    sizeBytes: 2048,
    status: 'uploaded',
    attempts: 1,
    lastError: null,
    createdAt: '2026-09-14T02:05:00.000Z',
    updatedAt: '2026-09-14T02:05:00.000Z',
    ...overrides,
  };
}

async function renderSubsection() {
  await act(async () => {
    render(<OffsiteBackupSubsection />);
  });
}

describe('OffsiteBackupSubsection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue(offView);
    uploadsMock.mockResolvedValue([]);
  });

  it('renders the destinations the server reports', async () => {
    await renderSubsection();

    expect(screen.getByText('Off-site Copies')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getByRole('switch', {
        name: 'Email me a copy of each completed automatic backup',
      }),
    ).toHaveAttribute('aria-checked', 'false');
    // The ledger is asked for one page, never for more rows than the endpoint
    // is willing to answer with.
    expect(uploadsMock).toHaveBeenCalledWith(20);
  });

  it('reports a failed read instead of rendering an empty form over it', async () => {
    getMock.mockRejectedValue(new Error('boom'));

    await renderSubsection();

    // An empty form here would invite the reader to re-enter a bucket they
    // already have, and would show "Off" for a destination that may be on.
    expect(
      screen.getByText('Failed to load your off-site backup destinations'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Off' })).not.toBeInTheDocument();

    getMock.mockResolvedValue(offView);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    });
    expect(screen.getByRole('button', { name: 'Off' })).toBeInTheDocument();
  });

  it('says why a bucket of your own cannot be configured with no encryption key', async () => {
    getMock.mockResolvedValue({ ...offView, encryptionConfigured: false });

    await renderSubsection();

    expect(
      screen.getByText(/This server has no encryption key set/),
    ).toBeInTheDocument();
  });

  it("disables the deployment's bucket when this server has none", async () => {
    getMock.mockResolvedValue({ ...offView, deploymentS3Available: false });

    await renderSubsection();

    // Disabled rather than hidden: a control that vanishes says nothing about
    // why, and the hint beside it names what would have to change.
    expect(
      screen.getByRole('button', { name: "This server's bucket" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/This server has no off-site bucket of its own/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'My own bucket' })).toBeEnabled();
  });

  it('reveals the own-bucket fields and never renders a stored secret', async () => {
    getMock.mockResolvedValue(ownView);

    await renderSubsection();

    expect(screen.getByLabelText('Bucket')).toHaveValue('my-bucket');
    const accessKey = screen.getByLabelText('Access key ID');
    const secret = screen.getByLabelText('Secret access key');
    // The server reports only that a credential is stored, so both boxes are
    // empty and say so; a value here would be a secret the API never returns.
    expect(accessKey).toHaveValue('');
    expect(secret).toHaveValue('');
    expect(accessKey).toHaveAttribute('placeholder', '•••• stored');
    expect(secret).toHaveAttribute('placeholder', '•••• stored');
    expect(accessKey).toHaveAttribute('type', 'password');
  });

  it('hides the own-bucket fields while the mode is not `own`', async () => {
    await renderSubsection();

    expect(screen.queryByLabelText('Bucket')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'My own bucket' }));
    });

    expect(screen.getByLabelText('Bucket')).toBeInTheDocument();
  });

  it('sends only the fields that changed, and no blank credential', async () => {
    getMock.mockResolvedValue(ownView);
    updateMock.mockResolvedValue({ ...ownView, s3Bucket: 'other-bucket' });

    await renderSubsection();

    // Nothing has moved yet, so there is nothing to save.
    expect(screen.getByRole('button', { name: 'Save Destinations' })).toBeDisabled();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Bucket'), {
        target: { value: 'other-bucket' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
    });

    // The region, the mode and both credentials were untouched: resending them
    // would re-write columns nobody edited, and a blank credential string would
    // read as a field the user cleared.
    expect(updateMock).toHaveBeenCalledWith({ s3Bucket: 'other-bucket' });
  });

  it('sends a credential the user actually typed', async () => {
    getMock.mockResolvedValue(ownView);
    updateMock.mockResolvedValue(ownView);

    await renderSubsection();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Secret access key'), {
        target: { value: 'typed-secret' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
    });

    expect(updateMock).toHaveBeenCalledWith({ s3SecretAccessKey: 'typed-secret' });
    // Adopting the server's answer empties the box again, so the next save
    // cannot resend what was already stored.
    expect(screen.getByLabelText('Secret access key')).toHaveValue('');
  });

  it('carries every own-bucket field the user edited into one payload', async () => {
    getMock.mockResolvedValue(ownView);
    updateMock.mockResolvedValue(ownView);

    await renderSubsection();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Region'), {
        target: { value: 'eu-central-1' },
      });
      fireEvent.change(screen.getByLabelText('Key prefix'), {
        target: { value: 'backups/' },
      });
      fireEvent.change(screen.getByLabelText('Endpoint'), {
        target: { value: 'https://s3.example.com' },
      });
      fireEvent.click(screen.getByLabelText('Use path-style addressing'));
      fireEvent.change(screen.getByLabelText('Access key ID'), {
        target: { value: 'AKIAEXAMPLE' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
    });

    // The bucket and the mode were not touched, so they stay out of it; an
    // empty field the row already holds empty is not a change either.
    expect(updateMock).toHaveBeenCalledWith({
      s3Region: 'eu-central-1',
      s3Prefix: 'backups/',
      s3Endpoint: 'https://s3.example.com',
      s3ForcePathStyle: true,
      s3AccessKeyId: 'AKIAEXAMPLE',
    });
  });

  it('clears a field the user emptied rather than leaving the stored value', async () => {
    getMock.mockResolvedValue(ownView);
    updateMock.mockResolvedValue({ ...ownView, s3Region: null });

    await renderSubsection();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Region'), {
        target: { value: '  ' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
    });

    // An emptied text field is a value difference and is sent as null; the
    // credential boxes are the exception, and they are never sent blank.
    expect(updateMock).toHaveBeenCalledWith({ s3Region: null });
  });

  it('shows the server refusal beside the form rather than only in a toast', async () => {
    getMock.mockResolvedValue(ownView);
    updateMock.mockRejectedValue(new Error('400'));

    await renderSubsection();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Bucket'), {
        target: { value: 'other-bucket' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
    });
    await act(async () => {});

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Failed to save your off-site backup destinations',
    );
  });

  it('forgets stored credentials only through the flag, and only once confirmed', async () => {
    getMock.mockResolvedValue(ownView);
    updateMock.mockResolvedValue({
      ...ownView,
      s3AccessKeyIdSet: false,
      s3SecretAccessKeySet: false,
    });

    await renderSubsection();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove Stored Credentials' }),
      );
    });

    // Asking is part of it: a blank box means "leave it alone", so forgetting a
    // working destination's credentials is never a side effect of a save.
    expect(updateMock).not.toHaveBeenCalled();

    // Cancelling forgets nothing.
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Cancel',
        }),
      );
    });
    expect(updateMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove Stored Credentials' }),
      );
    });
    const dialog = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Remove Stored Credentials' }),
      );
    });

    expect(updateMock).toHaveBeenCalledWith({ clearS3Credentials: true });
    expect(
      screen.queryByRole('button', { name: 'Remove Stored Credentials' }),
    ).not.toBeInTheDocument();
  });

  it('turns email on and sends the address with it', async () => {
    updateMock.mockResolvedValue({
      ...offView,
      emailEnabled: true,
      emailTo: 'me@example.com',
    });

    await renderSubsection();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', {
          name: 'Email me a copy of each completed automatic backup',
        }),
      );
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Send copies to'), {
        target: { value: 'me@example.com' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
    });

    expect(updateMock).toHaveBeenCalledWith({
      emailEnabled: true,
      emailTo: 'me@example.com',
    });
    expect(screen.getByLabelText('Send copies to')).toHaveAttribute(
      'type',
      'email',
    );
  });

  it('says the ledger is empty rather than leaving the panel blank', async () => {
    await renderSubsection();

    expect(screen.getByText('No off-site copies yet')).toBeInTheDocument();
  });

  it('reports a failed ledger read as a failure, not as no copies', async () => {
    uploadsMock.mockRejectedValue(new Error('boom'));

    await renderSubsection();

    expect(
      screen.getByText('Failed to load your recent off-site copies'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No off-site copies yet')).not.toBeInTheDocument();

    uploadsMock.mockResolvedValue([upload({})]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });
    expect(
      screen.getByText('monize-backup-daily-2026-09-14-9f3c1a2b4d5e.mzbe'),
    ).toBeInTheDocument();
  });

  it('draws each status group and carries the reason a copy failed', async () => {
    uploadsMock.mockResolvedValue([
      upload({ id: 'a', status: 'uploaded' }),
      upload({ id: 'b', status: 'uploading' }),
      upload({
        id: 'c',
        status: 'failed',
        attempts: 3,
        lastError: 'connection reset',
      }),
      upload({ id: 'd', status: 'conflict' }),
      upload({ id: 'e', status: 'skipped-too-large', destination: 'email' }),
      upload({ id: 'f', status: 'skipped-unencrypted' }),
    ]);

    await renderSubsection();

    // Four groups, four colours: a verified copy, one in flight, a copy that
    // does not exist, and one this server deliberately did not make.
    expect(screen.getByText('Copied').className).toContain('bg-green-100');
    expect(screen.getByText('Sending').className).toContain('bg-gray-100');
    expect(screen.getByText('Failed').className).toContain('bg-red-100');
    expect(screen.getByText('Conflict').className).toContain('bg-red-100');
    expect(screen.getByText('Skipped: too large').className).toContain(
      'bg-amber-100',
    );
    expect(screen.getByText('Skipped: not encrypted').className).toContain(
      'bg-amber-100',
    );

    // A failure is only findable if its reason travels with it.
    expect(
      screen.getByText('Last error: connection reset'),
    ).toBeInTheDocument();
    // One emailed copy among six; the other five name the S3 destination.
    expect(screen.getAllByRole('cell', { name: 'Email' })).toHaveLength(1);
    expect(screen.getAllByRole('cell', { name: 'S3' })).toHaveLength(5);
    expect(screen.getAllByText('2.0 kB')).toHaveLength(6);
    // The recovery point's own date, in the reader's timezone and format.
    expect(screen.getAllByText('2026-09-14 02:05')).toHaveLength(6);
  });

  it('renders an unknown status as itself rather than guessing its colour', async () => {
    uploadsMock.mockResolvedValue([
      upload({
        // A newer server naming a state this build does not know is not a
        // reason to draw it as a success or as a failure.
        status: 'quarantined' as BackupOffsiteUpload['status'],
      }),
    ]);

    await renderSubsection();

    const badge = screen.getByText('quarantined');
    expect(badge.className).toContain('bg-gray-100');
  });
});
