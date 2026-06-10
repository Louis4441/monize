'use client';

import { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import { LOCALE_COOKIE, SUPPORTED_LOCALES } from '@/i18n/config';

/**
 * Compact language picker for unauthenticated screens (login/register).
 * Visitors on a shared machine would otherwise be stuck with the locale
 * cookie left behind by the previous user. The choice is persisted in the
 * cookie only; once registered, OnboardingPreferences saves it to the
 * user's preferences.
 */
export function AuthLanguageSwitcher() {
  const t = useTranslations('auth.languageSwitcher');
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleChange = (next: string) => {
    Cookies.set(LOCALE_COOKIE, next, { sameSite: 'lax', expires: 365 });
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div className="flex items-center justify-center gap-1.5">
      <svg
        className="h-4 w-4 text-gray-400 dark:text-gray-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"
        />
      </svg>
      <select
        aria-label={t('label')}
        value={locale}
        onChange={(e) => handleChange(e.target.value)}
        disabled={isPending}
        className="bg-transparent text-sm text-gray-500 dark:text-gray-400 rounded cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}
