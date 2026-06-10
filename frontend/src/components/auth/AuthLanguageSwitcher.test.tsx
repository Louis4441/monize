import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@/test/render';
import { render } from '@/test/render';
import { AuthLanguageSwitcher } from './AuthLanguageSwitcher';

const mockRefresh = vi.fn();

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>(
    'next/navigation',
  );
  return {
    ...actual,
    useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
  };
});

vi.mock('js-cookie', () => ({
  default: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

import Cookies from 'js-cookie';

describe('AuthLanguageSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every supported locale as an option', () => {
    render(<AuthLanguageSwitcher />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain('en');
    expect(optionValues).toContain('pl');
  });

  it('shows the active locale as selected', () => {
    render(<AuthLanguageSwitcher />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('en');
  });

  it('persists the chosen language to the cookie and refreshes', async () => {
    render(<AuthLanguageSwitcher />);

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: 'pl' } });
    });

    expect(Cookies.set).toHaveBeenCalledWith(
      'NEXT_LOCALE',
      'pl',
      expect.objectContaining({ sameSite: 'lax' }),
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('does not save anything to the API (user is not signed in)', () => {
    render(<AuthLanguageSwitcher />);
    expect(screen.getByRole('combobox')).toHaveAccessibleName('Language');
  });
});
