'use client';

import { useEffect } from 'react';
import { BOOT_SPLASH_ID } from '@/components/layout/BootSplash';

// Removes the server-rendered boot splash once the client app has actually
// mounted. This sits inside ThemeProvider on purpose: the provider renders
// null until it has read localStorage, so this component's mount effect only
// fires on the commit that put the real app tree on screen.
export function BootSplashRemover() {
  useEffect(() => {
    document.getElementById(BOOT_SPLASH_ID)?.remove();
  }, []);

  return null;
}
