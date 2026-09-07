'use client';

import { useTranslations } from 'next-intl';
import {
  ArrowDownTrayIcon,
  PaperClipIcon,
} from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';

/**
 * What the user can do with a share, as buttons they press.
 *
 * There is deliberately no auto-advance, not even for a single file: the whole
 * point of the review screen is that a share never turns into a saved
 * transaction or an import on its own. Both destinations lead to a form the
 * user still has to submit.
 */
export function ShareDestinations({
  kind,
  fileCount,
  onAttach,
  onImport,
  onDiscard,
  busy = false,
}: {
  /** Which destination the accepted files support, decided by the caller. */
  kind: 'attachment' | 'statement';
  fileCount: number;
  onAttach: () => void;
  onImport: () => void;
  onDiscard: () => void;
  busy?: boolean;
}) {
  const t = useTranslations('share');

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('destinationsHeading')}
      </h2>

      {kind === 'attachment' ? (
        <DestinationRow
          icon={<PaperClipIcon aria-hidden className="h-5 w-5" />}
          label={t('newTransaction')}
          hint={t('newTransactionHint', { count: fileCount })}
          onClick={onAttach}
          disabled={busy}
        />
      ) : (
        <DestinationRow
          icon={<ArrowDownTrayIcon aria-hidden className="h-5 w-5" />}
          label={t('import')}
          hint={t('importHint')}
          onClick={onImport}
          disabled={busy}
        />
      )}

      <div>
        <Button variant="ghost" onClick={onDiscard} disabled={busy}>
          {t('discard')}
        </Button>
      </div>
    </div>
  );
}

function DestinationRow({
  icon,
  label,
  hint,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Button onClick={onClick} disabled={disabled} className="w-full sm:w-auto">
        <span className="mr-2 inline-flex">{icon}</span>
        {label}
      </Button>
      <p className="text-sm text-gray-600 dark:text-gray-400">{hint}</p>
    </div>
  );
}
