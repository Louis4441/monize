import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import { Inter } from 'next/font/google';
import { Toaster } from 'react-hot-toast';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { BootSplash } from '@/components/layout/BootSplash';
import { BootSplashHider } from '@/components/providers/BootSplashHider';
import { OfflineFallbackSync } from '@/components/providers/OfflineFallbackSync';
import { PreferencesLoader } from '@/components/providers/PreferencesLoader';
import { ServiceWorkerRegistrar } from '@/components/providers/ServiceWorkerRegistrar';
import { PwaLifecycleHandler } from '@/components/providers/PwaLifecycleHandler';
import { isColorTheme } from '@/lib/color-themes';
import {
  COLOR_THEME_COOKIE,
  RESOLVED_THEME_COOKIE,
  bootPageColor,
  isResolvedTheme,
} from '@/lib/pwa-theme';
import { SwipeShell } from '@/components/layout/SwipeShell';
import { WhatsNewHost } from '@/components/whats-new/WhatsNewHost';
import { TourHost } from '@/components/tours/TourHost';
import { getLocaleDir } from '@/i18n/config';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

// theme-color follows the active palette and resolved mode from the cookies
// ThemeContext maintains (ThemeContext also re-pins the rendered meta tags at
// runtime). With no resolved-mode cookie the choice falls back to the system
// preference via a media-split pair.
export async function generateViewport(): Promise<Viewport> {
  const cookieStore = await cookies();
  const rawTheme = cookieStore.get(RESOLVED_THEME_COOKIE)?.value;
  const rawColorTheme = cookieStore.get(COLOR_THEME_COOKIE)?.value;
  const theme = isResolvedTheme(rawTheme) ? rawTheme : null;
  const colorTheme = isColorTheme(rawColorTheme) ? rawColorTheme : null;

  return {
    themeColor: theme
      ? bootPageColor(colorTheme, theme)
      : [
          {
            media: '(prefers-color-scheme: light)',
            color: bootPageColor(colorTheme, 'light'),
          },
          {
            media: '(prefers-color-scheme: dark)',
            color: bootPageColor(colorTheme, 'dark'),
          },
        ],
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
  };
}

export const metadata: Metadata = {
  title: 'Monize - Personal Finance Manager',
  description: 'Track your finances with ease',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Monize',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reading headers forces dynamic rendering so the per-request CSP nonce
  // from proxy.ts is available. Next.js automatically applies the nonce
  // to its generated inline scripts.
  const headersList = await headers();
  const httpsHeadersActive = headersList.get('x-https-headers-active') === 'true';
  const locale = await getLocale();
  const messages = await getMessages();
  const dir = getLocaleDir(locale);

  // Resolved theme and colour palette mirrored into cookies by ThemeContext.
  // Stamping the dark class and data-theme attribute here means the very
  // first paint -- the boot splash below, and the page background behind it
  // -- already wears the user's mode and palette, instead of flashing the
  // default light look until ThemeProvider mounts. ThemeProvider re-resolves
  // and corrects both after hydration if the cookies are stale.
  const cookieStore = await cookies();
  const rawTheme = cookieStore.get(RESOLVED_THEME_COOKIE)?.value;
  const rawColorTheme = cookieStore.get(COLOR_THEME_COOKIE)?.value;
  const bootTheme = isResolvedTheme(rawTheme) ? rawTheme : null;
  const bootColorTheme =
    isColorTheme(rawColorTheme) && rawColorTheme !== 'default'
      ? rawColorTheme
      : undefined;
  const tLayout = await getTranslations('layout');

  return (
    <html
      lang={locale}
      dir={dir}
      className={bootTheme === 'dark' ? 'dark' : undefined}
      data-theme={bootColorTheme}
      suppressHydrationWarning
    >
      <body className={inter.className}>
        {/* Rendered in the body and hoisted into <head> by React. The link is
            hand-written rather than generated from a manifest.ts because the
            splash palette depends on the resolved-theme cookie, and cookies
            only accompany a manifest fetch under crossorigin="use-credentials"
            (see app/manifest.webmanifest/route.ts). */}
        <link
          rel="manifest"
          href="/manifest.webmanifest"
          crossOrigin="use-credentials"
        />
        <BootSplash
          bootTheme={bootTheme}
          strings={{
            loading: tLayout('bootSplash.loading'),
            slowMessage: tLayout('bootSplash.slowMessage'),
            reload: tLayout('bootSplash.reload'),
          }}
        />
        <ServiceWorkerRegistrar />
        <PwaLifecycleHandler />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider>
            <BootSplashHider />
            <OfflineFallbackSync />
            <PreferencesLoader>
              <SwipeShell httpsHeadersActive={httpsHeadersActive}>
                {children}
              </SwipeShell>
            </PreferencesLoader>
            <WhatsNewHost />
            <TourHost />
            {/* Toast colours ride the theme variables so all colour themes
                in themes.css re-skin them; the chip stays dark in both modes
                (gray-800 is a surface every theme defines), and the semantic
                icon tints come from the @theme tokens. */}
            <Toaster
              position="top-right"
              toastOptions={{
                duration: 4000,
                style: {
                  background: 'var(--color-gray-800)',
                  color: 'var(--color-gray-100)',
                },
                success: {
                  duration: 3000,
                  iconTheme: {
                    primary: 'var(--color-success)',
                    secondary: 'var(--color-gray-100)',
                  },
                },
                error: {
                  duration: 4000,
                  iconTheme: {
                    primary: 'var(--color-danger)',
                    secondary: 'var(--color-gray-100)',
                  },
                },
              }}
            />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
