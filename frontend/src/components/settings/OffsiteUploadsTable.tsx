'use client';

import { useTranslations } from 'next-intl';
import { ArchiveBoxIcon } from '@heroicons/react/24/outline';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  TABLE_BODY_CLASS,
  TABLE_CLASS,
  Td,
  Th,
} from '@/components/ui/Table';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type {
  BackupOffsiteUpload,
  BackupOffsiteUploadStatus,
} from '@/lib/backupApi';
import {
  formatDatetimeLocal,
  isoToDatetimeLocal,
  resolveTimezone,
} from '@/lib/utils';
import { usePreferencesStore } from '@/store/preferencesStore';

/**
 * How each durable status reads and which colour it wears.
 *
 * Four groups, because they ask four different things of the reader: a verified
 * copy is done, an in-flight one needs nothing, a `failed`/`conflict` row is an
 * off-machine copy that does not exist, and a `skipped-*` row is one this server
 * deliberately did not make. Collapsing the last two into one colour is how a
 * refused plaintext upload comes to read like a transient outage.
 */
const STATUS_META: Record<
  BackupOffsiteUploadStatus,
  { variant: BadgeVariant; labelKey: string }
> = {
  pending: { variant: 'gray', labelKey: 'statusPending' },
  uploading: { variant: 'gray', labelKey: 'statusUploading' },
  uploaded: { variant: 'green', labelKey: 'statusUploaded' },
  failed: { variant: 'red', labelKey: 'statusFailed' },
  conflict: { variant: 'red', labelKey: 'statusConflict' },
  'skipped-unencrypted': {
    variant: 'amber',
    labelKey: 'statusSkippedUnencrypted',
  },
  'skipped-too-large': { variant: 'amber', labelKey: 'statusSkippedTooLarge' },
};

const DESTINATION_LABEL_KEYS: Record<string, string> = {
  s3: 'destinationS3',
  email: 'destinationEmail',
};

const TIER_LABEL_KEYS: Record<string, string> = {
  daily: 'tierDaily',
  weekly: 'tierWeekly',
  monthly: 'tierMonthly',
};

/** The artifact's own name: the last segment of an S3 key, or the filename. */
function artifactName(objectKey: string): string {
  const segments = objectKey.split('/');
  return segments[segments.length - 1] || objectKey;
}

interface OffsiteUploadsTableProps {
  /** `null` while nothing has been read yet, or after a read that failed. */
  uploads: BackupOffsiteUpload[] | null;
  isLoading: boolean;
  /** A failed read, already localized. Never rendered as an empty list. */
  error: string | null;
  onRefresh: () => void;
}

/**
 * The ledger of recent off-machine copies, newest first.
 *
 * A failed read is not an empty ledger and is not "no copies were made": both
 * of those would tell the reader their backups are not leaving the machine,
 * which is the one answer this table must never guess. `lastError` rides on a
 * line of its own under the row it belongs to, because a copy that did not
 * happen is only findable if the reason travels with it.
 */
export function OffsiteUploadsTable({
  uploads,
  isLoading,
  error,
  onRefresh,
}: OffsiteUploadsTableProps) {
  const t = useTranslations('settings.backupRestore.offsite.uploads');
  const { formatBytes, formatNumber } = useNumberFormat();
  const preferences = usePreferencesStore((s) => s.preferences);
  const timezone = resolveTimezone(preferences?.timezone);
  const dateFormat = preferences?.dateFormat || 'browser';
  const timeFormat = preferences?.timeFormat || '24h';

  const formatMoment = (iso: string): string =>
    formatDatetimeLocal(isoToDatetimeLocal(iso, timezone), dateFormat, timeFormat);

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('heading')}
        </h4>
        <Button
          variant="outline"
          size="sm"
          className="sm:ml-auto"
          onClick={onRefresh}
          disabled={isLoading}
        >
          {t('refreshButton')}
        </Button>
      </div>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {t('description')}
      </p>

      {isLoading && (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          {t('loading')}
        </p>
      )}

      {!isLoading && error && (
        <p
          role="alert"
          className="mt-3 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}

      {!isLoading && !error && uploads && uploads.length === 0 && (
        <EmptyState
          icon={<ArchiveBoxIcon />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      )}

      {!isLoading && !error && uploads && uploads.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <Th>{t('columns.artifact')}</Th>
                <Th>{t('columns.destination')}</Th>
                <Th>{t('columns.tier')}</Th>
                <Th>{t('columns.copied')}</Th>
                <Th align="right">{t('columns.size')}</Th>
                <Th>{t('columns.status')}</Th>
                <Th align="right">{t('columns.attempts')}</Th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY_CLASS}>
              {uploads.map((upload) => {
                // An unrecognised status is rendered as itself rather than
                // guessed at: a newer server naming a state this build does not
                // know is not a reason to colour it success or failure.
                const status = STATUS_META[upload.status];
                const destinationKey =
                  DESTINATION_LABEL_KEYS[upload.destination];
                const tierKey = TIER_LABEL_KEYS[upload.tier];
                return (
                  <tr key={upload.id}>
                    <Td className="break-all font-mono text-xs">
                      {artifactName(upload.objectKey)}
                      {upload.lastError && (
                        <span className="mt-1 block font-sans text-xs break-words text-red-600 dark:text-red-400">
                          {t('errorLabel', { message: upload.lastError })}
                        </span>
                      )}
                    </Td>
                    <Td>
                      {destinationKey ? t(destinationKey) : upload.destination}
                    </Td>
                    <Td>{tierKey ? t(tierKey) : upload.tier}</Td>
                    <Td className="whitespace-nowrap">
                      {formatMoment(upload.createdAt)}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {formatBytes(upload.sizeBytes)}
                    </Td>
                    <Td>
                      <Badge variant={status?.variant ?? 'gray'}>
                        {status ? t(status.labelKey) : upload.status}
                      </Badge>
                    </Td>
                    <Td align="right">{formatNumber(upload.attempts, 0)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
