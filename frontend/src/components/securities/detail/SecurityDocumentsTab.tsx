'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import {
  ArrowTopRightOnSquareIcon,
  DocumentTextIcon,
} from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { useDateFormat } from '@/hooks/useDateFormat';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import { documentHost } from '@/lib/security-detail';
import { SecurityDocumentForm } from './SecurityDocumentForm';
import type {
  CreateSecurityDocumentData,
  Security,
  SecurityDocument,
} from '@/types/investment';

interface SecurityDocumentsTabProps {
  security: Security;
}

const TH =
  'px-3 py-2 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';
const TD = 'px-3 py-2 text-sm';

/**
 * The documents recorded against a security: a factsheet, a KIID, a prospectus,
 * an annual report.
 *
 * A plain table of what the columns actually hold, so type, name and date sort
 * the way a reader expects -- the reason these are real columns rather than a
 * JSON blob (discussion #964). The address column shows the host rather than the
 * whole URL: a factsheet link runs to a couple of hundred characters and none of
 * them tell you as much as "ishares.com" does.
 *
 * Links only for now. Uploading a file needs the attachments module widened
 * beyond transactions, which is its own change.
 */
export function SecurityDocumentsTab({ security }: SecurityDocumentsTabProps) {
  const t = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();

  const [documents, setDocuments] = useState<SecurityDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<SecurityDocument | undefined>();
  const [deleting, setDeleting] = useState<SecurityDocument | undefined>();

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setDocuments(await investmentsApi.getSecurityDocuments(security.id));
    } catch (err) {
      setError(getErrorMessage(err, t('documents.loadFailed')));
    } finally {
      setIsLoading(false);
    }
  }, [security.id, t]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(undefined);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditing(undefined);
  };

  const handleSubmit = async (data: CreateSecurityDocumentData) => {
    try {
      if (editing) {
        await investmentsApi.updateSecurityDocument(
          security.id,
          editing.id,
          data,
        );
        toast.success(t('documents.toasts.updated'));
      } else {
        await investmentsApi.createSecurityDocument(security.id, data);
        toast.success(t('documents.toasts.created'));
      }
      setIsFormOpen(false);
      setEditing(undefined);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t('documents.toasts.saveFailed')));
      // Rethrown so the form knows it failed and stays open with the values in it.
      throw err;
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await investmentsApi.deleteSecurityDocument(security.id, deleting.id);
      toast.success(t('documents.toasts.deleted'));
      setDeleting(undefined);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t('documents.toasts.deleteFailed')));
    }
  };

  const actionsFor = useCallback(
    (document: SecurityDocument): RowAction[] => [
      {
        key: 'edit',
        label: t('documents.actions.edit'),
        icon: 'edit',
        tone: 'primary',
        onClick: () => {
          setEditing(document);
          setIsFormOpen(true);
        },
      },
      {
        key: 'delete',
        label: t('documents.actions.delete'),
        icon: 'delete',
        tone: 'delete',
        destructive: true,
        onClick: () => setDeleting(document),
      },
    ],
    [t],
  );

  const rows = useMemo(
    () =>
      documents.map((document) => ({
        document,
        host: documentHost(document.url),
        actions: actionsFor(document),
      })),
    [documents, actionsFor],
  );

  const addButton = (
    <Button onClick={openCreate}>{t('documents.add')}</Button>
  );

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('documents.title')}
        </h3>
        {documents.length > 0 && addButton}
      </div>

      {error && (
        <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {documents.length === 0 ? (
        // Not an empty table with headers over nothing: a first-run state that
        // says what documents are for and offers the one action worth taking.
        <div className="py-10 text-center">
          <DocumentTextIcon
            className="mx-auto h-10 w-10 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
          <p className="mt-3 font-medium text-gray-900 dark:text-gray-100">
            {t('documents.empty.title')}
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500 dark:text-gray-400">
            {t('documents.empty.description')}
          </p>
          <div className="mt-4 flex justify-center">
            <Button onClick={openCreate}>{t('documents.empty.action')}</Button>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th scope="col" className={`${TH} text-left`}>
                  {t('documents.columns.type')}
                </th>
                <th scope="col" className={`${TH} text-left`}>
                  {t('documents.columns.name')}
                </th>
                <th
                  scope="col"
                  className={`${TH} hidden text-left sm:table-cell`}
                >
                  {t('documents.columns.date')}
                </th>
                <th
                  scope="col"
                  className={`${TH} hidden text-left md:table-cell`}
                >
                  {t('documents.columns.address')}
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  {t('documents.columns.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {rows.map(({ document, host, actions }) => (
                <tr
                  key={document.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <td
                    className={`${TD} whitespace-nowrap text-gray-500 dark:text-gray-400`}
                  >
                    {t(
                      `documents.types.${document.documentType}` as Parameters<
                        typeof t
                      >[0],
                    )}
                  </td>
                  <td className={`${TD} text-gray-900 dark:text-gray-100`}>
                    <div className="font-medium">{document.name}</div>
                    {document.notes && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {document.notes}
                      </div>
                    )}
                  </td>
                  <td
                    className={`${TD} hidden whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300 sm:table-cell`}
                  >
                    {document.documentDate
                      ? formatDate(document.documentDate)
                      : t('documents.noDate')}
                  </td>
                  <td
                    className={`${TD} hidden text-gray-500 dark:text-gray-400 md:table-cell`}
                  >
                    {host}
                  </td>
                  <td className={`${TD} text-right`}>
                    <div className="flex items-center justify-end gap-1">
                      {/* `noreferrer` as well as `noopener`: the destination is
                          a URL the user typed, and it has no business learning
                          which page they came from. */}
                      <a
                        href={document.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t('documents.actions.openNamed', {
                          name: document.name,
                        })}
                        title={document.url}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
                      >
                        <ArrowTopRightOnSquareIcon
                          className="h-4 w-4"
                          aria-hidden="true"
                        />
                        {t('documents.actions.open')}
                      </a>
                      <RowActions actions={actions} density="compact" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={isFormOpen}
        onClose={closeForm}
        maxWidth="lg"
        className="p-6"
        pushHistory
      >
        {isFormOpen && (
          <>
            <h2 className="mb-4 text-xl font-bold text-gray-900 dark:text-gray-100">
              {editing
                ? t('documents.form.editTitle')
                : t('documents.form.addTitle')}
            </h2>
            <SecurityDocumentForm
              document={editing}
              onSubmit={handleSubmit}
              onCancel={closeForm}
            />
          </>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!deleting}
        title={t('documents.delete.title')}
        message={t('documents.delete.message', { name: deleting?.name ?? '' })}
        confirmLabel={t('documents.actions.delete')}
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(undefined)}
      />
    </div>
  );
}
