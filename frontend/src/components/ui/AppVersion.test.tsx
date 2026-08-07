import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { AppVersion } from './AppVersion';
import { useWhatsNewStore } from '@/store/whatsNewStore';

describe('AppVersion', () => {
  beforeEach(() => {
    useWhatsNewStore.setState({ isOpen: false });
  });

  afterEach(() => {
    // Unmount before touching shared state: Testing Library's cleanup is
    // registered at import time and after-hooks run in reverse order, so it
    // runs after this one. See `test-hygiene.test.ts`.
    cleanup();
    vi.unstubAllEnvs();
    useWhatsNewStore.setState({ isOpen: false });
  });

  it('renders the version as a button with the release-notes tooltip', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.11.0');
    render(<AppVersion className="footer" />);

    const button = screen.getByRole('button', { name: /v1\.11\.0/ });
    expect(button).toHaveTextContent('v1.11.0');
    expect(button).toHaveAttribute('title', 'View release notes for v1.11.0');
  });

  it('opens the What\'s New modal when clicked', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.11.0');
    render(<AppVersion />);

    expect(useWhatsNewStore.getState().isOpen).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /v1\.11\.0/ }));
    expect(useWhatsNewStore.getState().isOpen).toBe(true);
  });

  it('applies the wrapper class', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '2.0.0');
    const { container } = render(<AppVersion className="text-center mt-6" />);

    expect(container.querySelector('p')).toHaveClass('text-center', 'mt-6');
    expect(screen.getByRole('button')).toHaveTextContent('v2.0.0');
  });

  it('renders nothing when the version is unavailable', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '');
    const { container } = render(<AppVersion />);
    expect(container).toBeEmptyDOMElement();
  });
});
