import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { isColorTheme } from '@/lib/color-themes';
import { buildManifest } from '@/lib/pwa-manifest';
import {
  COLOR_THEME_COOKIE,
  RESOLVED_THEME_COOKIE,
  isResolvedTheme,
} from '@/lib/pwa-theme';

// A hand-written route handler rather than Next's manifest.ts convention,
// for two reasons: the splash palette depends on the resolved-theme and
// colour-palette cookies (see lib/pwa-manifest.ts), and the browser only
// sends cookies on a manifest fetch when the <link rel="manifest"> carries
// crossorigin="use-credentials" -- which the convention's auto-generated
// link cannot express. layout.tsx renders that link explicitly.
export async function GET() {
  const cookieStore = await cookies();
  const rawTheme = cookieStore.get(RESOLVED_THEME_COOKIE)?.value;
  const rawColorTheme = cookieStore.get(COLOR_THEME_COOKIE)?.value;
  const theme = isResolvedTheme(rawTheme) ? rawTheme : null;
  const colorTheme = isColorTheme(rawColorTheme) ? rawColorTheme : null;

  return NextResponse.json(buildManifest(theme, colorTheme), {
    headers: {
      'Content-Type': 'application/manifest+json',
      // Let the browser revalidate on each manifest update check so a theme
      // change is picked up on the next launch rather than a cache lifetime.
      'Cache-Control': 'no-cache',
    },
  });
}
