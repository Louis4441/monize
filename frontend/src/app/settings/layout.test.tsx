import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import SettingsLayout from './layout';

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

let actingAsUserId: string | null = null;
vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => selector({ actingAsUserId }),
}));

describe('SettingsLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actingAsUserId = null;
  });

  it('renders children for a normal (non-delegate) user', () => {
    render(
      <SettingsLayout>
        <div data-testid="child">settings</div>
      </SettingsLayout>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('redirects a delegate away from settings', () => {
    actingAsUserId = 'owner-1';
    render(
      <SettingsLayout>
        <div data-testid="child">settings</div>
      </SettingsLayout>,
    );
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith('/dashboard');
  });
});
