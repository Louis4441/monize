import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import toast from 'react-hot-toast';
import { render, screen } from '@/test/render';
import { AboutSection } from './AboutSection';
import { useWhatsNewStore } from '@/store/whatsNewStore';
import { useAuthStore } from '@/store/authStore';
import { useDemoStore } from '@/store/demoStore';
import { updatesApi } from '@/lib/updatesApi';
import type { User } from '@/types/auth';

vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img {...props} />,
}));

vi.mock('@heroicons/react/24/outline', () => ({
  ArrowTopRightOnSquareIcon: (props: any) => <svg data-testid="external-icon" {...props} />,
  CheckCircleIcon: (props: any) => <svg data-testid="check-icon" {...props} />,
  ClipboardDocumentIcon: (props: any) => <svg data-testid="clipboard-icon" {...props} />,
  ExclamationTriangleIcon: (props: any) => <svg data-testid="warning-icon" {...props} />,
  ScaleIcon: (props: any) => <svg data-testid="scale-icon" {...props} />,
  ShieldCheckIcon: (props: any) => <svg data-testid="shield-icon" {...props} />,
  SparklesIcon: (props: any) => <svg data-testid="sparkles-icon" {...props} />,
  TagIcon: (props: any) => <svg data-testid="tag-icon" {...props} />,
}));

vi.mock('@/lib/updatesApi', () => ({
  updatesApi: {
    getStatus: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const REPO_URL = 'https://github.com/kenlasko/monize';

const adminUser = { id: 'u1', role: 'admin', authProvider: 'local' } as User;
const regularUser = { id: 'u2', role: 'user', authProvider: 'local' } as User;

const upToDateStatus = {
  currentVersion: '1.13.0',
  latestVersion: '1.13.0',
  updateAvailable: false,
  releaseUrl: null,
  releaseName: null,
  publishedAt: null,
  checkedAt: null,
  dismissed: false,
  disabled: false,
  error: null,
};

/** Async on mount (update status): render inside act so the effect settles. */
async function renderAbout() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AboutSection />);
  });
  return result!;
}

describe('AboutSection', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.13.0');
    useWhatsNewStore.setState({ isOpen: false, backendVersion: undefined });
    useAuthStore.setState({ user: null, isAuthenticated: false });
    useDemoStore.setState({ isDemoMode: false });
    vi.mocked(updatesApi.getStatus).mockResolvedValue(upToDateStatus);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('renders the section heading and the running version', async () => {
    await renderAbout();

    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'v1.13.0' })).toHaveAttribute(
      'title',
      'View release notes for v1.13.0',
    );
  });

  it('falls back to an unknown version when the build did not inject one', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '');
    await renderAbout();

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^v/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /What's new/ }),
    ).toBeInTheDocument();
  });

  it('keeps the tour anchor on the version label', async () => {
    const { container } = await renderAbout();

    expect(
      container.querySelector('[data-tour-id="settings-app-version"]'),
    ).toBeInTheDocument();
  });

  it('opens the What\'s New modal from the version label', async () => {
    await renderAbout();

    expect(useWhatsNewStore.getState().isOpen).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'v1.13.0' }));
    expect(useWhatsNewStore.getState().isOpen).toBe(true);
  });

  it('opens the What\'s New modal from the labelled row', async () => {
    await renderAbout();

    fireEvent.click(
      screen.getByRole('button', { name: /What's new in v1\.13\.0/ }),
    );
    expect(useWhatsNewStore.getState().isOpen).toBe(true);
  });

  it('links out to releases, licence and security policy', async () => {
    await renderAbout();

    expect(screen.getByText('All releases').closest('a')).toHaveAttribute(
      'href',
      `${REPO_URL}/releases`,
    );
    expect(screen.getByText('Licence').closest('a')).toHaveAttribute(
      'href',
      `${REPO_URL}/blob/main/LICENSE`,
    );
    expect(screen.getByText('Security policy').closest('a')).toHaveAttribute(
      'href',
      `${REPO_URL}/security/policy`,
    );
  });

  it('opens every external link in a new tab with safe rel attributes', async () => {
    await renderAbout();

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  describe('API version mismatch', () => {
    it('stays quiet when the API reports the same version', async () => {
      useWhatsNewStore.setState({ backendVersion: '1.13.0' });
      await renderAbout();

      expect(screen.queryByText('API version')).not.toBeInTheDocument();
    });

    it('warns when the API reports a different version', async () => {
      useWhatsNewStore.setState({ backendVersion: '1.12.0' });
      await renderAbout();

      expect(screen.getByText('API version')).toBeInTheDocument();
      expect(screen.getByText('v1.12.0')).toBeInTheDocument();
      expect(
        screen.getByText(/running different versions/),
      ).toBeInTheDocument();
    });
  });

  describe('update status', () => {
    it('is not requested or shown for non-admins', async () => {
      useAuthStore.setState({ user: regularUser, isAuthenticated: true });
      await renderAbout();

      expect(updatesApi.getStatus).not.toHaveBeenCalled();
      expect(screen.queryByText('Updates')).not.toBeInTheDocument();
    });

    it('shows "up to date" for an admin on the latest release', async () => {
      useAuthStore.setState({ user: adminUser, isAuthenticated: true });
      await renderAbout();

      expect(updatesApi.getStatus).toHaveBeenCalled();
      expect(screen.getByText('Up to date')).toBeInTheDocument();
    });

    it('shows the newer version and a link to its release', async () => {
      useAuthStore.setState({ user: adminUser, isAuthenticated: true });
      vi.mocked(updatesApi.getStatus).mockResolvedValue({
        ...upToDateStatus,
        latestVersion: '1.14.0',
        updateAvailable: true,
        releaseUrl: `${REPO_URL}/releases/tag/v1.14.0`,
      });
      await renderAbout();

      expect(screen.getByText('v1.14.0 available')).toBeInTheDocument();
      expect(screen.getByText('View release').closest('a')).toHaveAttribute(
        'href',
        `${REPO_URL}/releases/tag/v1.14.0`,
      );
    });

    it('reports an update generically when GitHub gave no version', async () => {
      useAuthStore.setState({ user: adminUser, isAuthenticated: true });
      vi.mocked(updatesApi.getStatus).mockResolvedValue({
        ...upToDateStatus,
        latestVersion: null,
        updateAvailable: true,
      });
      await renderAbout();

      expect(
        screen.getByText('A newer version is available'),
      ).toBeInTheDocument();
    });

    it('hides the row when update checking is disabled', async () => {
      useAuthStore.setState({ user: adminUser, isAuthenticated: true });
      vi.mocked(updatesApi.getStatus).mockResolvedValue({
        ...upToDateStatus,
        disabled: true,
      });
      await renderAbout();

      expect(screen.queryByText('Updates')).not.toBeInTheDocument();
    });

    it('fails silently when the status request errors', async () => {
      useAuthStore.setState({ user: adminUser, isAuthenticated: true });
      vi.mocked(updatesApi.getStatus).mockRejectedValue(new Error('offline'));
      await renderAbout();
      await act(async () => {});

      expect(screen.queryByText('Updates')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    });
  });

  describe('diagnostics', () => {
    it('copies a plain-text report to the clipboard', async () => {
      useAuthStore.setState({ user: adminUser, isAuthenticated: true });
      useWhatsNewStore.setState({ backendVersion: '1.13.0' });
      await renderAbout();

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Copy diagnostics/ }),
        );
      });

      expect(writeText).toHaveBeenCalledTimes(1);
      const report = writeText.mock.calls[0][0] as string;
      expect(report).toContain('UI version: 1.13.0');
      expect(report).toContain('API version: 1.13.0');
      expect(report).toContain('Locale: en');
      expect(report).toContain('Demo mode: no');
      expect(report).toContain('Auth provider: local');
      expect(report).toContain('Browser: ');
      expect(toast.success).toHaveBeenCalledWith(
        'Diagnostics copied to clipboard',
      );
    });

    it('records an unknown API version when the backend never reported one', async () => {
      await renderAbout();

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Copy diagnostics/ }),
        );
      });

      expect(writeText.mock.calls[0][0]).toContain('API version: unknown');
    });

    it('toasts an error when the clipboard is unavailable', async () => {
      writeText.mockRejectedValueOnce(new Error('denied'));
      await renderAbout();

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Copy diagnostics/ }),
        );
      });

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'Could not copy diagnostics to the clipboard',
        ),
      );
    });
  });
});
