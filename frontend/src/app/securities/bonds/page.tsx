'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { BondHistoryTab } from '@/components/bonds/BondHistoryTab';
import { BondOfferTab } from '@/components/bonds/BondOfferTab';
import { programLabel } from '@/components/securities/detail/bond-labels';
import { Modal } from '@/components/ui/Modal';
import { TabPanel, Tabs, type TabItem } from '@/components/ui/Tabs';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { useFormModal } from '@/hooks/useFormModal';
import { getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import type { CreateSecurityData } from '@/types/investment';
import type { BondProgramSummary, OfferSeries } from '@/types/bond';

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
  const tDetail = useTranslations('securityDetail');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => tabFromQuery(searchParams.get('tab')));
  const [adding, setAdding] = useState<BondProgramSummary | null>(null);
  const [isResolving, setIsResolving] = useState(false);
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

  // A security is a program, not a series: "Add to my portfolio" on a series
  // means its program. When the reader already holds a security for it, that
  // security is the answer (a purchase is recorded there, naming the series);
  // otherwise the creation flow opens with the program chosen, and the form
  // still lets the reader edit every field it filled in.
  const handleAdd = async (series: OfferSeries) => {
    if (isResolving) return;
    setIsResolving(true);
    try {
      const [programs, securities] = await Promise.all([
        investmentsApi.listBondPrograms(),
        investmentsApi.getSecurities(),
      ]);
      const program = programs.find(
        (p) =>
          p.issuerCountryCode === series.issuerCountryCode &&
          p.programCode === series.programCode,
      );
      if (program === undefined) {
        toast.error(t('offer.addFailed'));
        return;
      }
      const existing = securities.find((s) => s.bondProgramId === program.id);
      if (existing !== undefined) {
        router.push(`/securities/${existing.id}`);
        return;
      }
      setAdding(program);
      openCreate();
    } catch (error) {
      toast.error(getErrorMessage(error, t('offer.addFailed')));
    } finally {
      setIsResolving(false);
    }
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
          <BondOfferTab onAdd={handleAdd} allowFetch />
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
                    symbol: adding.programCode,
                    name: programLabel(tDetail, adding.programCode),
                    securityType: 'BOND',
                    currencyCode: adding.currency,
                    bondProgramId: adding.id,
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
