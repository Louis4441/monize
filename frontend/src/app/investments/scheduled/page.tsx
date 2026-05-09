'use client';

import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { useFormModal } from '@/hooks/useFormModal';
import { ScheduledInvestmentForm } from '@/components/scheduled-investments/ScheduledInvestmentForm';
import { ScheduledInvestmentList } from '@/components/scheduled-investments/ScheduledInvestmentList';
import { scheduledInvestmentsApi } from '@/lib/scheduled-investments';
import { accountsApi } from '@/lib/accounts';
import { ScheduledInvestmentTransaction } from '@/types/scheduled-investment';
import { Account } from '@/types/account';
import { getErrorMessage } from '@/lib/errors';

export default function ScheduledInvestmentsPage() {
  return (
    <ProtectedRoute>
      <ScheduledInvestmentsContent />
    </ProtectedRoute>
  );
}

function ScheduledInvestmentsContent() {
  const [items, setItems] = useState<ScheduledInvestmentTransaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const {
    showForm,
    editingItem,
    openCreate,
    openEdit,
    close,
    isEditing,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<ScheduledInvestmentTransaction>();

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [scheduled, allAccounts] = await Promise.all([
        scheduledInvestmentsApi.getAll(),
        accountsApi.getAll(),
      ]);
      setItems(scheduled);
      setAccounts(allAccounts);
    } catch (err) {
      toast.error(getErrorMessage(err, 'An error occurred'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageLayout>
      <PageHeader
        title="Scheduled Investments"
        subtitle="Recurring buys, dividends, DRIP, and contribution+buy schedules"
        actions={
          <Button onClick={() => openCreate()}>New scheduled investment</Button>
        }
      />

      {isLoading ? (
        <LoadingSpinner />
      ) : (
        <ScheduledInvestmentList
          items={items}
          onChanged={load}
          onEdit={openEdit}
        />
      )}

      <Modal isOpen={showForm} onClose={close} maxWidth="2xl" {...modalProps}>
        <h2 className="text-lg font-semibold mb-4">
          {isEditing
            ? 'Edit scheduled investment'
            : 'New scheduled investment'}
        </h2>
        <ScheduledInvestmentForm
          accounts={accounts}
          scheduled={editingItem ?? undefined}
          onSuccess={() => {
            close();
            void load();
          }}
          onCancel={close}
          onDirtyChange={setFormDirty}
          submitRef={formSubmitRef}
        />
      </Modal>

      <UnsavedChangesDialog {...unsavedChangesDialog} />
    </PageLayout>
  );
}
