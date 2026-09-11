'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Td, Th, TABLE_BODY_CLASS, TABLE_CLASS } from '@/components/ui/Table';
import { backupApi, StoredBackup, StoredBackupsReport } from '@/lib/backupApi';
import { getErrorMessage } from '@/lib/errors';
import { downloadBlob } from '@/lib/download';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  formatDatetimeLocal,
  isoToDatetimeLocal,
  resolveTimezone,
} from '@/lib/utils';
import { usePreferencesStore } from '@/store/preferencesStore';

interface StoredBackupsSubsectionProps {
  /**
   * Hands the chosen artifact to the restore form above, as the `File` a user
   * would have picked themselves. Restoring is deliberately not done here: the
   * refusals that make a restore safe -- the warning, the encrypted-backup
   * password, the account password or the OIDC round trip, and the summary
   * dialogue afterwards -- belong to one workflow, and a second copy of it
   * beside this table is how the two drift apart.
   */
  onRestore: (file: File) => void;
}

/**
 * The automatic backups this server is holding for the signed-in user.
 *
 * **Present only when there is something to say.** The schedule is an operator
 * setting on an admin-only endpoint, so this reader cannot be asked whether it
 * is armed -- the listing answers it instead (`enabled`), and a deployment that
 * runs no automatic backups renders no section at all. The one exception is a
 * folder that still holds artifacts after the schedule was turned off: those
 * are recoverable data, and the only screen that can hand them back is this
 * one, so it stays for as long as they exist.
 *
 * **Folded away by default.** The heading stays visible, so nothing about the
 * feature is hidden; what folds is a file listing most visits to Settings have
 * no use for. The fold is not persisted per reader the way the foldable
 * Settings *sections* are (`settingsSectionStore`): those record a preference
 * about a panel of controls, and this is a data table inside one.
 */
export function StoredBackupsSubsection({
  onRestore,
}: StoredBackupsSubsectionProps) {
  const t = useTranslations('settings.backupRestore.storedBackups');
  const { formatBytes } = useNumberFormat();
  const preferences = usePreferencesStore((s) => s.preferences);
  const timezone = resolveTimezone(preferences?.timezone);
  const dateFormat = preferences?.dateFormat || 'browser';
  const timeFormat = preferences?.timeFormat || '24h';

  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<StoredBackupsReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // A failed read is not "no backups", and it is not "the schedule is off"
  // either. Both of those would be answered by hiding this section, which is
  // the one thing that must not happen on an error: it would tell the reader
  // their server is holding nothing.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which row is working, and at what. The action is part of it so a restore's
  // fetch does not relabel the Download button beside it.
  const [busy, setBusy] = useState<{
    filename: string;
    action: 'download' | 'restore';
  } | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      setReport(await backupApi.listStoredBackups());
    } catch (error) {
      setReport(null);
      setLoadError(getErrorMessage(error, t('loadFailed')));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  // The element's own `toggle` event fires for the state change React just
  // made, so the summary's click and that event both arrive for one expand.
  // Compared against a ref rather than `open`, which is still the previous
  // render's value when the second of the two lands.
  const openRef = useRef(false);
  const handleToggle = (next: boolean) => {
    if (openRef.current === next) return;
    openRef.current = next;
    setOpen(next);
    // Re-read on every expand: the schedule writes and retention deletes while
    // this page is open, and a list that is wrong about which artifacts exist
    // is worse than one that takes a moment to arrive.
    if (next) load();
  };

  const handleDownload = async (backup: StoredBackup) => {
    setBusy({ filename: backup.filename, action: 'download' });
    try {
      const file = await backupApi.downloadStoredBackup(backup.filename);
      downloadBlob(file, backup.filename);
    } catch (error) {
      toast.error(getErrorMessage(error, t('downloadFailed')));
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async (backup: StoredBackup) => {
    setBusy({ filename: backup.filename, action: 'restore' });
    try {
      onRestore(await backupApi.downloadStoredBackup(backup.filename));
    } catch (error) {
      toast.error(getErrorMessage(error, t('downloadFailed')));
    } finally {
      setBusy(null);
    }
  };

  const formatModified = (iso: string): string =>
    formatDatetimeLocal(
      isoToDatetimeLocal(iso, timezone),
      dateFormat,
      timeFormat,
    );

  // Nothing scheduled and nothing on disk: the feature is not part of this
  // deployment, so the section is not part of this page.
  if (report && !report.enabled && report.backups.length === 0) return null;
  // Nothing known yet. Rendering a heading here would put a section on screen
  // that the first answer may take straight back off again.
  if (!report && !loadError) return null;

  const backups = report?.backups ?? [];

  return (
    <div className="mb-6 pb-6 border-b border-gray-200 dark:border-gray-700">
      <details
        open={open}
        // React does not manage `open` for us, so a toggle the summary's own
        // click handler did not produce (Chrome expands a `<details>` to show a
        // find-in-page match) would otherwise leave this state disagreeing with
        // the DOM.
        onToggle={(event) => handleToggle(event.currentTarget.open)}
      >
        <summary
          className="cursor-pointer"
          data-testid="stored-backups-summary"
          onClick={(event) => {
            // Cancels the element's own activation behaviour so `open` moves
            // only through this state. Enter and Space on a focused summary
            // dispatch a click too, so the keyboard path comes with it.
            event.preventDefault();
            handleToggle(!open);
          }}
        >
          <h3 className="inline text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('heading')}
          </h3>
        </summary>

        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {t('description')}
        </p>

        <div className="mt-4">
          {isLoading && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('loading')}
            </p>
          )}

          {!isLoading && loadError && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-red-600 dark:text-red-400">
                {loadError}
              </p>
              <Button variant="outline" size="sm" onClick={load}>
                {t('retryButton')}
              </Button>
            </div>
          )}

          {!isLoading && !loadError && backups.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('empty')}
            </p>
          )}

          {!isLoading && !loadError && backups.length > 0 && (
            <div className="overflow-x-auto">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <Th>{t('columns.filename')}</Th>
                    <Th>{t('columns.modified')}</Th>
                    <Th align="right">{t('columns.size')}</Th>
                    <Th align="right">
                      <span className="sr-only">{t('columns.actions')}</span>
                    </Th>
                  </tr>
                </thead>
                <tbody className={TABLE_BODY_CLASS}>
                  {backups.map((backup) => (
                    <tr key={backup.filename}>
                      <Td className="break-all font-mono text-xs">
                        {backup.filename}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {formatModified(backup.modifiedAt)}
                      </Td>
                      <Td align="right" className="whitespace-nowrap">
                        {formatBytes(backup.size)}
                      </Td>
                      <Td align="right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => handleDownload(backup)}
                          >
                            {busy?.filename === backup.filename &&
                            busy.action === 'download'
                              ? t('workingButton')
                              : t('downloadButton')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => handleRestore(backup)}
                          >
                            {busy?.filename === backup.filename &&
                            busy.action === 'restore'
                              ? t('workingButton')
                              : t('restoreButton')}
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
