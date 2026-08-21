import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { BootSplashRemover } from './BootSplashRemover';
import { BOOT_SPLASH_ID } from '@/components/layout/BootSplash';

describe('BootSplashRemover', () => {
  beforeEach(() => {
    document.getElementById(BOOT_SPLASH_ID)?.remove();
  });

  it('removes the boot splash element on mount', () => {
    const splash = document.createElement('div');
    splash.id = BOOT_SPLASH_ID;
    document.body.appendChild(splash);

    render(<BootSplashRemover />);

    expect(document.getElementById(BOOT_SPLASH_ID)).toBeNull();
  });

  it('is a no-op when no boot splash exists', () => {
    expect(() => render(<BootSplashRemover />)).not.toThrow();
  });
});
