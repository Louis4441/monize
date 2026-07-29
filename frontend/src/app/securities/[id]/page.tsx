'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PageLayout } from '@/components/layout/PageLayout';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { SecurityDetailHeader } from '@/components/securities/detail/SecurityDetailHeader';
import { SecuritySummaryCards } from '@/components/securities/detail/SecuritySummaryCards';
import { SecurityPositionState } from '@/components/securities/detail/SecurityPositionState';
import { SecurityChartSection } from '@/components/securities/detail/SecurityChartSection';
import { SecurityKeyInformation } from '@/components/securities/detail/SecurityKeyInformation';
import { SecurityAboutCard } from '@/components/securities/detail/SecurityAboutCard';
import { SecurityPerformanceCard } from '@/components/securities/detail/SecurityPerformanceCard';
import { SecurityPositionInfoCard } from '@/components/securities/detail/SecurityPositionInfoCard';
import { SecurityAccountsTable } from '@/components/securities/detail/SecurityAccountsTable';
import { SecurityBreakdownCard } from '@/components/securities/detail/SecurityBreakdownCard';
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
  Security,
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

/** `?tab=` if it names a real tab, so a link can point at one. */
function tabFromQuery(value: string | null): TabKey {
  return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : 'overview';
}

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
  const searchParams = useSearchParams();
  const securityId = params.id as string;

  const [detail, setDetail] = useState<SecurityDetail | null>(null);
  const [prices, setPrices] = useState<SecurityPrice[]>([]);
  const [trades, setTrades] = useState<SecurityHistoryTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Read once, from the link that opened the page: the dashboard's price
  // widgets point straight at the Price history tab. Later tab changes are the
  // user's, so this is an initial value rather than a synced one.
  const [tab, setTab] = useState<TabKey>(() =>
    tabFromQuery(searchParams.get('tab')),
  );
  const [chartMode, setChartMode] = useState<SecurityChartMode>('price');
  const [isEditing, setIsEditing] = useState(false);
  const [isFavouritePending, setIsFavouritePending] = useState(false);
  // Only for the caret beside the name; a failure costs the switcher, not the page.
  const [securities, setSecurities] = useState<Security[]>([]);

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

  useEffect(() => {
    let cancelled = false;
    investmentsApi
      .getSecurities()
      .then((list) => {
        if (!cancelled) setSecurities(list);
      })
      // The switcher simply does not render without a list; the page is fine.
      .catch(() => {
        if (!cancelled) setSecurities([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleToggleFavourite = useCallback(async () => {
    if (!detail) return;
    const next = !detail.security.isFavourite;
    setIsFavouritePending(true);
    try {
      await investmentsApi.setSecurityFavourite(detail.security.id, next);
      setDetail((current) =>
        current
          ? { ...current, security: { ...current.security, isFavourite: next } }
          : current,
      );
      toast.success(
        next ? t('toasts.favouriteAdded') : t('toasts.favouriteRemoved'),
      );
    } catch (err) {
      toast.error(getErrorMessage(err, t('toasts.favouriteFailed')));
    } finally {
      setIsFavouritePending(false);
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
          onToggleFavourite={handleToggleFavourite}
          isFavouritePending={isFavouritePending}
          securities={securities}
          onSelectSecurity={(id) => router.push(`/securities/${id}`)}
        />

        <div className="space-y-6">
          {/* Zero-filled cards would claim a position that is not there, so a
              closed or never-held security gets its own panel instead. */}
          {detail.accounts.length > 0 ? (
            <SecuritySummaryCards detail={detail} />
          ) : (
            <SecurityPositionState detail={detail} />
          )}

          {/* Two thirds chart, one third a column of two cards: what the
              instrument is, and what it is made of. The chart runs tall so that
              column has the room, and the breakdown's bars are capped and
              scrollable so an eleven-sector fund cannot outgrow it.
              `items-start` keeps the cards at their content height. */}
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
            <div className="space-y-6">
              <SecurityKeyInformation
                security={security}
                latestPrice={
                  quote
                    ? { price: quote.price, priceDate: quote.priceDate }
                    : null
                }
                prices={priceSeries}
              />
              <SecurityBreakdownCard security={security} />
            </div>
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
              {/* `items-start`: the three cards hold different amounts, and
                  stretching the short ones just pads them with blank space. */}
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
