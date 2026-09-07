'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useAuthStore } from '@/store/authStore';
import {
  listSharedBundles,
  purgeExpiredSharedBundles,
} from '@/lib/share-inbox';
import { SHARE_PAGE_PATH, sharePageUrl } from '@/lib/share-target';

/**
 * The way back to a share whose redirect did not survive.
 *
 * The worker stashes files whether or not anyone is signed in, and the sign-in
 * that follows can lose the `returnTo` (an OIDC round trip, or the user simply
 * opening Monize from the launcher instead of following the redirect). Without
 * this banner those files would sit on the device until they expired, with
 * nothing on any screen pointing at them.
 *
 * It also runs the purge from the app, so a stash ages out on the ordinary
 * path rather than waiting for the worker to be woken by another share.
 */
export function ShareInboxNotice() {
  const t = useTranslations('share');
  const pathname = usePathname();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const viewerUserId = useAuthStore((state) => state.user?.id);
  const [pending, setPending] = useState<{ id: string; count: number } | null>(
    null,
  );
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  // Re-reads on navigation as well as on sign-in: consuming a share on /share
  // removes it, and this banner is mounted in the shell above the route that
  // did so.
  //
  // The read is an async callback declared inside the effect rather than a
  // `useCallback` the effect calls: every state update then lands in a
  // callback after a suspension, which is what keeps this off the synchronous
  // effect path the set-state-in-effect rule forbids.
  // The purge rides along inside this one gate deliberately. It is a lifetime
  // sweep rather than an access check, so the reader's id is not what entitles
  // it -- but hoisting it out of the gate would run it on `/share`, where an
  // expired bundle is deliberately still readable so the screen can say
  // "expired" instead of "nothing here". Waiting for the reader costs nothing:
  // the worker sweeps on activate and on every share as well.
  useEffect(() => {
    if (!isAuthenticated || !viewerUserId || pathname === SHARE_PAGE_PATH) return;
    let alive = true;

    void (async () => {
      await purgeExpiredSharedBundles();
      const bundles = await listSharedBundles(viewerUserId);
      if (!alive) return;
      const newest = bundles[0];
      // Only files that are actually usable are worth interrupting for: a
      // share whose every file was refused has nothing to offer on review.
      const usable = newest?.files.filter((file) => file.key).length ?? 0;
      setPending(
        newest && usable > 0 ? { id: newest.id, count: usable } : null,
      );
    })();

    return () => {
      alive = false;
    };
  }, [isAuthenticated, viewerUserId, pathname]);

  // Never over the review screen itself, which is already showing the share.
  if (!isAuthenticated || !pending || pathname === SHARE_PAGE_PATH) return null;
  if (dismissedId === pending.id) return null;

  return (
    <div className="border-b border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2 sm:px-6 lg:px-8">
        <p className="min-w-0 flex-1 truncate text-sm text-blue-900 dark:text-blue-100">
          {t('noticeTitle', { count: pending.count })}
        </p>
        <Link
          href={sharePageUrl(pending.id)}
          className="shrink-0 text-sm font-semibold text-blue-900 underline focus-visible:outline-2 focus-visible:outline-offset-2 dark:text-blue-100"
        >
          {t('noticeAction')}
        </Link>
        <button
          type="button"
          onClick={() => setDismissedId(pending.id)}
          aria-label={t('noticeDismiss')}
          className="shrink-0 rounded p-1 text-blue-900 hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-offset-2 motion-reduce:transition-none dark:text-blue-100 dark:hover:bg-blue-900"
        >
          <XMarkIcon aria-hidden className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
