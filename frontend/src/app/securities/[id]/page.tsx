'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PageLayout } from '@/components/layout/PageLayout';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import { SecurityDetailHeader } from '@/components/securities/detail/SecurityDetailHeader';
import { SecuritySummaryCards } from '@/components/securities/detail/SecuritySummaryCards';
import { SecurityPositionState } from '@/components/securities/detail/SecurityPositionState';
import { SecurityChartSection } from '@/components/securities/detail/SecurityChartSection';
import { SecurityKeyInformation } from '@/components/securities/detail/SecurityKeyInformation';
import { SecurityAboutCard } from '@/components/securities/detail/SecurityAboutCard';
import { SecurityPerformanceCard } from '@/components/securities/detail/SecurityPerformanceCard';
import { SecurityPositionInfoCard } from '@/components/securities/detail/SecurityPositionInfoCard';
import { SecurityAccountsTable } from '@/components/securities/detail/SecurityAccountsTable';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import { roundToDecimals } from '@/lib/format';
import {
  toPriceSeries,
  buildQuantitySteps,
  type SecurityChartMode,
} from '@/lib/security-detail';
import type {
  CreateSecurityData,
  SecurityDetail,
  SecurityPrice,
  SecurityHistoryTransaction,
} from '@/types/investment';

const SecurityForm = dynamic(
  () =>
    import('@/components/securities/SecurityForm').then((m) => ({
      default: m.SecurityForm,
    })),
  { ssr: false },
);

const SecurityTransactionHistory = dynamic(
  () =>
    import('@/components/securities/SecurityTransactionHistory').then((m) => ({
      default: m.SecurityTransactionHistory,
    })),
  { ssr: false },
);

const SecurityPriceHistory = dynamic(
  () =>
    import('@/components/securities/SecurityPriceHistory').then((m) => ({
      default: m.SecurityPriceHistory,
    })),
  { ssr: false },
);

const TAB_KEYS = ['overview', 'transactions', 'prices'] as const;
type TabKey = (typeof TAB_KEYS)[number];

/**
 * How old the newest close may be and still describe "today's" move. Covers a
 * long weekend plus a public holiday, which is the normal gap between sessions.
 */
const STALE_QUOTE_DAYS = 4;

/** Whole days between an ISO `yyyy-MM-dd` and today. */
function daysSince(isoDate: string): number {
  const then = new Date(`${isoDate}T00:00:00`).getTime();
  const today = new Date();
  const midnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  return Math.round((midnight - then) / 86_400_000);
}

export default function SecurityDetailPage() {
  return (
    <ProtectedRoute>
      <SecurityDetailContent />
    </ProtectedRoute>
  );
}

function SecurityDetailContent() {
  const t = useTranslations('securityDetail');
  // The edit modal reuses the securities list's form, heading and toasts.
  const ts = useTranslations('securities');
  const params = useParams();
  const router = useRouter();
  const securityId = params.id as string;

  const [detail, setDetail] = useState<SecurityDetail | null>(null);
  const [prices, setPrices] = useState<SecurityPrice[]>([]);
  const [trades, setTrades] = useState<SecurityHistoryTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');
  const [chartMode, setChartMode] = useState<SecurityChartMode>('price');
  const [isEditing, setIsEditing] = useState(false);
  const [isWatchPending, setIsWatchPending] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // The detail is the page; prices and trades feed the chart and its
      // markers, so a failure in either costs the chart, never the page.
      const detailData = await investmentsApi.getSecurityDetail(securityId);
      const [priceData, historyData] = await Promise.all([
        investmentsApi.getSecurityPrices(securityId, 9999).catch(() => []),
        investmentsApi
          .getSecurityTransactionHistory(securityId)
          .catch(() => null),
      ]);
      setDetail(detailData);
      setPrices(priceData);
      setTrades(historyData?.transactions ?? []);
    } catch (err) {
      const message = getErrorMessage(err, t('loadFailed'));
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [securityId, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useOnUndoRedo(loadData);
  useOnAiAction(loadData);

  const priceSeries = useMemo(() => toPriceSeries(prices), [prices]);
  const quantitySteps = useMemo(() => buildQuantitySteps(trades), [trades]);

  // The newest close, plus how far it moved against the one before it. Derived
  // here rather than fetched: the page already holds the whole series, and the
  // quote endpoints answer for the portfolio rather than for one security.
  const quote = useMemo(() => {
    const latest = priceSeries[priceSeries.length - 1];
    if (!latest) return null;
    const previous = priceSeries[priceSeries.length - 2];
    const change = previous ? roundToDecimals(latest.close - previous.close, 6) : null;
    return {
      price: latest.close,
      priceDate: latest.date,
      change,
      changePercent:
        previous && previous.close !== 0 && change !== null
          ? roundToDecimals((change / previous.close) * 100, 2)
          : null,
      // A move is only "today's" if the quote it came from is fresh. Prices are
      // refreshed daily and there are no weekend closes, so anything within a
      // few days still counts as the latest session; older than that and the
      // header says "last move" instead of misdating it.
      isCurrent: daysSince(latest.date) <= STALE_QUOTE_DAYS,
    };
  }, [priceSeries]);

  const handleToggleWatch = useCallback(async () => {
    if (!detail) return;
    const next = !detail.security.isFavourite;
    setIsWatchPending(true);
    try {
      await investmentsApi.setSecurityFavourite(detail.security.id, next);
      setDetail((current) =>
        current
          ? { ...current, security: { ...current.security, isFavourite: next } }
          : current,
      );
      toast.success(
        next ? t('toasts.watchAdded') : t('toasts.watchRemoved'),
      );
    } catch (err) {
      toast.error(getErrorMessage(err, t('toasts.watchFailed')));
    } finally {
      setIsWatchPending(false);
    }
  }, [detail, t]);

  const handleEditSubmit = useCallback(
    async (data: CreateSecurityData) => {
      try {
        await investmentsApi.updateSecurity(securityId, data);
        toast.success(ts('page.toasts.updated'));
        setIsEditing(false);
        await loadData();
      } catch (err) {
        toast.error(getErrorMessage(err, ts('page.toasts.updateFailed')));
        // Rethrown so the form keeps the user's input and its error state.
        throw err;
      }
    },
    [securityId, loadData, ts],
  );

  const handleUpdatePrices = useCallback(async () => {
    if (!detail) return;
    try {
      const result = await investmentsApi.backfillSecurityPrices(
        detail.security.id,
      );
      if (!result.success) {
        toast.error(result.error || t('toasts.pricesFailed'));
        return;
      }
      toast.success(
        result.pricesLoaded
          ? t('toasts.pricesUpdated', { count: result.pricesLoaded })
          : t('toasts.noPricesFound'),
      );
      await loadData();
    } catch (err) {
      toast.error(getErrorMessage(err, t('toasts.pricesFailed')));
    }
  }, [detail, loadData, t]);

  const menuItems = useMemo<ActionMenuItem[]>(() => {
    if (!detail) return [];
    return [
      {
        id: 'transactions',
        label: t('actions.viewTransactions'),
        onSelect: () => setTab('transactions'),
      },
      {
        id: 'prices',
        label: t('actions.viewPrices'),
        onSelect: () => setTab('prices'),
      },
      {
        id: 'updatePrices',
        label: t('actions.updatePrices'),
        onSelect: () => {
          void handleUpdatePrices();
        },
      },
    ];
  }, [detail, handleUpdatePrices, t]);

  if (isLoading) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <LoadingSpinner text={t('loading')} />
        </main>
      </PageLayout>
    );
  }

  if (error || !detail) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <div
            role="alert"
            className="rounded-lg bg-white p-12 text-center shadow dark:bg-gray-800"
          >
            <h3 className="mb-2 text-lg font-medium text-gray-900 dark:text-gray-100">
              {error || t('notFound')}
            </h3>
            <div className="flex justify-center gap-3">
              {error && (
                <Button variant="outline" onClick={loadData}>
                  {t('error.retry')}
                </Button>
              )}
              <Button onClick={() => router.push('/securities')}>
                {t('backToSecurities')}
              </Button>
            </div>
          </div>
        </main>
      </PageLayout>
    );
  }

  const { security } = detail;
  const tabs = TAB_KEYS.map((key) => ({ key, label: t(`tabs.${key}`) }));

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <SecurityDetailHeader
          security={security}
          quote={quote}
          onBack={() => router.push('/securities')}
          onEdit={() => setIsEditing(true)}
          onToggleWatch={handleToggleWatch}
          isWatchPending={isWatchPending}
          menuItems={menuItems}
        />

        <div className="space-y-6">
          {/* Zero-filled cards would claim a position that is not there, so a
              closed or never-held security gets its own panel instead. */}
          {detail.accounts.length > 0 ? (
            <SecuritySummaryCards detail={detail} />
          ) : (
            <SecurityPositionState detail={detail} />
          )}

          {/* `items-start` so Key information keeps its natural height: it holds
              a handful of rows against a 420px chart, and stretching it to match
              left most of the card empty. */}
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <SecurityChartSection
                security={security}
                prices={priceSeries}
                quantitySteps={quantitySteps}
                trades={trades}
                isLoading={false}
                mode={chartMode}
                onModeChange={setChartMode}
              />
            </div>
            <SecurityKeyInformation
              security={security}
              latestPrice={
                quote ? { price: quote.price, priceDate: quote.priceDate } : null
              }
            />
          </div>

          <div>
            <Tabs
              tabs={tabs}
              value={tab}
              onChange={setTab}
              idPrefix="securityDetail"
              ariaLabel={t('tabs.ariaLabel')}
            />

            <TabPanel
              idPrefix="securityDetail"
              tabKey="overview"
              isActive={tab === 'overview'}
              className="mt-6 space-y-6"
            >
              {/* `items-start` again: the three cards hold different amounts,
                  and stretching the short ones just pads them with blank space. */}
              <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-5">
                <div className="lg:col-span-2">
                  <SecurityAboutCard security={security} />
                </div>
                <div className="lg:col-span-1">
                  <SecurityPerformanceCard prices={priceSeries} />
                </div>
                <div className="lg:col-span-2">
                  <SecurityPositionInfoCard detail={detail} />
                </div>
              </div>
              <SecurityAccountsTable detail={detail} />
            </TabPanel>

            <TabPanel
              idPrefix="securityDetail"
              tabKey="transactions"
              isActive={tab === 'transactions'}
              className="mt-6"
            >
              <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
                <SecurityTransactionHistory
                  security={security}
                  onChanged={loadData}
                  embedded
                />
              </div>
            </TabPanel>

            <TabPanel
              idPrefix="securityDetail"
              tabKey="prices"
              isActive={tab === 'prices'}
              className="mt-6"
            >
              <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
                <SecurityPriceHistory security={security} embedded />
              </div>
            </TabPanel>
          </div>
        </div>

        {/* The same edit form the securities list opens, so a security is edited
            one way wherever you reach it from. */}
        <Modal
          isOpen={isEditing}
          onClose={() => setIsEditing(false)}
          maxWidth="3xl"
          className="p-6"
          pushHistory
        >
          {isEditing && (
            <>
              <h2 className="mb-4 text-2xl font-bold text-gray-900 dark:text-gray-100">
                {ts('page.modalTitleEdit')}
              </h2>
              <SecurityForm
                security={security}
                onSubmit={handleEditSubmit}
                onCancel={() => setIsEditing(false)}
              />
            </>
          )}
        </Modal>
      </main>
    </PageLayout>
  );
}
