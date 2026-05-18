'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';

/**
 * Settings (and its subpages) are owner-only. A delegate acting as an owner
 * must not reach Settings -- they manage nothing here and read-through of the
 * owner's profile/security would be inappropriate. Redirect them away.
 */
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const actingAsUserId = useAuthStore((s) => s.actingAsUserId);
  const isDelegateView = !!actingAsUserId;

  useEffect(() => {
    if (isDelegateView) {
      router.replace('/dashboard');
    }
  }, [isDelegateView, router]);

  if (isDelegateView) return null;

  return <>{children}</>;
}
