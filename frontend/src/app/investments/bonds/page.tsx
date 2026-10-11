'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { BondHistoryTab } from '@/components/bonds/BondHistoryTab';
import { BondOfferTab } from '@/components/bonds/BondOfferTab';
import { Modal } from '@/components/ui/Modal';
import { TabPanel, Tabs, type TabItem } from '@/components/ui/Tabs';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { useFormModal } from '@/hooks/useFormModal';
import { getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import type { CreateSecurityData } from '@/types/investment';
import type { OfferSeries } from '@/types/bond';

const SecurityForm = dynamic(
  () => import('@/components/securities/SecurityForm').then((m) => m.SecurityForm),
  { ssr: false },
);

type TabKey = 'onSale' | 'history';

/** `?tab=` when it names a real tab, so a link can point at the history. */
function tabFromQuery(value: string | null): TabKey {
  return value === 'history' ? 'history' : 'onSale';
}

export default function BondsPage() {
  return (
    <ProtectedRoute>
      <BondsContent />
    </ProtectedRoute>
  );
}

function BondsContent() {
  const t = useTranslations('bonds');
  const tSec = useTranslations('securities');
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => tabFromQuery(searchParams.get('tab')));
  const [adding, setAdding] = useState<OfferSeries | null>(null);
  const {
    showForm,
    openCreate,
    close,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<never>();

  const tabs: readonly TabItem<TabKey>[] = [
    { key: 'onSale', label: t('page.tabs.onSale') },
    { key: 'history', label: t('page.tabs.history') },
  ];

  // The existing security creation flow, opened with the series chosen: the
  // type, the currency and the catalog link are the series', and the form still
  // lets the reader edit every one of them.
  const handleAdd = (series: OfferSeries) => {
    setAdding(series);
    openCreate();
  };

  const handleSubmit = async (data: CreateSecurityData) => {
    try {
      await investmentsApi.createSecurity(data);
      toast.success(tSec('page.toasts.created'));
      close();
    } catch (error) {
      toast.error(getErrorMessage(error, tSec('page.toasts.createFailed')));
      throw error;
    }
  };

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader title={t('page.title')} subtitle={t('page.subtitle')} />
        <Tabs
          tabs={tabs}
          value={tab}
          onChange={setTab}
          idPrefix="bonds"
          ariaLabel={t('page.tabsLabel')}
          className="mb-4"
        />
        <TabPanel idPrefix="bonds" tabKey="onSale" isActive={tab === 'onSale'} keepMounted>
          <BondOfferTab onAdd={handleAdd} />
        </TabPanel>
        <TabPanel idPrefix="bonds" tabKey="history" isActive={tab === 'history'} keepMounted>
          <BondHistoryTab initialProgram={searchParams.get('program')} />
        </TabPanel>

        <Modal
          isOpen={showForm}
          onClose={close}
          {...modalProps}
          maxWidth="3xl"
          title={tSec('page.modalTitleNew')}
          padding="md"
        >
          <SecurityForm
            defaults={
              adding === null
                ? undefined
                : {
                    symbol: adding.seriesCode,
                    name: adding.seriesCode,
                    securityType: 'BOND',
                    currencyCode: adding.currency,
                    bondInstrumentId: adding.instrumentId,
                  }
            }
            onSubmit={handleSubmit}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />
      </main>
    </PageLayout>
  );
}
