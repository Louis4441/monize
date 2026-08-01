'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { createLogger } from '@/lib/logger';
import { gemStrategyApi } from '@/lib/gem-strategy';
import { GemAssetRole, GemRange, GemStrategyReport as GemStrategyReportData } from '@/types/gem-strategy';
import { GEM_DEFAULT_RANGE, warningCodes } from '@/lib/gem-strategy-view';
import { GemStrategyHeader } from './GemStrategyHeader';
import { GemStrategyTabs, GemTab } from './GemStrategyTabs';
import { GemWarningsBanner } from './GemWarningsBanner';
import { GemSignalCard } from './GemSignalCard';
import { GemPortfolioCard } from './GemPortfolioCard';
import { GemTransferCard } from './GemTransferCard';
import { GemAssetsCard } from './GemAssetsCard';
import { GemPerformanceChart } from './GemPerformanceChart';
import { GemNextActionCard } from './GemNextActionCard';
import { GemAllocationCard } from './GemAllocationCard';
import { GemReasoningSection } from './GemReasoningSection';
import { GemSignalHistoryTable } from './GemSignalHistoryTable';
import { GemPortfolioPanel } from './GemPortfolioPanel';
import { GemBacktestPanel } from './GemBacktestPanel';
import { GemSettingsForm } from './GemSettingsForm';
import { GemStrategyFooter } from './GemStrategyFooter';

const logger = createLogger('GemStrategyReport');

/** Rows of signal history shown on the overview before "see full history". */
const OVERVIEW_HISTORY_ROWS = 5;

function GemReportSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-36 w-full" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

/**
 * The GEM strategy report. Answers, in reading order: what the current signal is,
 * why the strategy picked that instrument, whether the real portfolio matches it,
 * and which single operation to carry out -- all from one server-side read model,
 * with the strategy itself evaluated server-side.
 */
export function GemStrategyReport() {
  const t = useTranslations('strategies');
  const router = useRouter();
  const [range, setRange] = useState<GemRange>(GEM_DEFAULT_RANGE);
  const [tab, setTab] = useState<GemTab>('overview');
  const [isSaving, setIsSaving] = useState(false);
  // The scenario on screen. Undefined means "whichever the server picks", which
  // is the user's first -- and the only one until they create a second.
  const [strategyId, setStrategyId] = useState<string | undefined>(undefined);

  const {
    data,
    isLoading,
    error,
    reload,
    setData: setReport,
  } = useReportData<GemStrategyReportData>(
    () => gemStrategyApi.getReport(range, strategyId),
    [range, strategyId],
  );

  /**
   * Every mutation here answers with the refreshed report, so the response is
   * adopted rather than triggering a second read of the same thing.
   */
  const adopt = setReport;

  /**
   * A mutation that changed *which* scenario is on screen -- creating one,
   * deleting one -- also moves the page to whichever the server decided on.
   * That re-runs the loader, which is the point: the id has to stick, or the
   * next range change would fall back to the user's first scenario.
   */
  const adoptScenario = useCallback(
    (report: GemStrategyReportData) => {
      setReport(report);
      setStrategyId(report.strategy.id ?? undefined);
    },
    [setReport],
  );

  const codes = useMemo(() => warningCodes(data?.warnings), [data?.warnings]);
  const winnerRole = useMemo<GemAssetRole | null>(
    () => data?.signal?.target?.role ?? null,
    [data?.signal],
  );
  const symbolByRole = useMemo(
    () => new Map((data?.assets ?? []).map((asset) => [asset.role, asset.symbol])),
    [data?.assets],
  );

  const handleMarkExecuted = useCallback(async () => {
    const signalId = data?.signal?.id;
    if (!signalId) return;
    setIsSaving(true);
    try {
      adopt(await gemStrategyApi.markExecuted(signalId, range, strategyId));
      toast.success(t('gem.action.markExecutedSuccess'));
    } catch (err) {
      logger.error('Failed to mark the GEM operation as executed:', err);
      toast.error(t('gem.action.markExecutedError'));
    } finally {
      setIsSaving(false);
    }
  }, [adopt, data?.signal?.id, range, strategyId, t]);

  const handleAddTransactions = useCallback(() => {
    router.push('/investments');
  }, [router]);

  const handleCreateScenario = useCallback(
    async (name: string) => {
      setIsSaving(true);
      try {
        const report = await gemStrategyApi.createStrategy(name, range);
        adoptScenario(report);
        setTab('settings');
        toast.success(t('gem.scenarios.created', { name: report.strategy.name }));
      } catch (err) {
        logger.error('Failed to create a GEM scenario:', err);
        toast.error(t('gem.scenarios.createError'));
      } finally {
        setIsSaving(false);
      }
    },
    [adoptScenario, range, t],
  );

  const handleDeleteScenario = useCallback(
    async (id: string) => {
      setIsSaving(true);
      try {
        adoptScenario(await gemStrategyApi.deleteStrategy(id, range));
        setTab('overview');
        toast.success(t('gem.scenarios.deleted'));
      } catch (err) {
        logger.error('Failed to delete a GEM scenario:', err);
        toast.error(t('gem.scenarios.deleteError'));
      } finally {
        setIsSaving(false);
      }
    },
    [adoptScenario, range, t],
  );

  /**
   * The save returns the strategy re-evaluated with its new configuration, so
   * the page takes it as-is. The scenario id is deliberately left alone: the
   * save never moves the user to a different one, and the first save creates
   * the only scenario there is, which is what an unset id already resolves to.
   */
  const handleConfigSaved = adopt;

  if (error && !data) {
    return (
      <div className="px-4 pt-6 pb-8 sm:px-6 lg:px-12">
        <ReportError message={t('gem.error.loadFailed')} onRetry={reload} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="px-4 pt-6 pb-8 sm:px-6 lg:px-12">
        <GemReportSkeleton />
      </div>
    );
  }

  const { strategy, assets, signal, position, action, performance, history, backtest } = data;
  const signalUnavailable = signal === null;

  const panelProps = (panel: GemTab) => ({
    role: 'tabpanel' as const,
    id: `gem-panel-${panel}`,
    'aria-labelledby': `gem-tab-${panel}`,
    tabIndex: -1,
  });

  return (
    <main className="px-4 pt-6 pb-8 sm:px-6 lg:px-12">
      <GemStrategyHeader
        strategyId={strategy.id}
        strategyName={strategy.name}
        scenarios={data.strategies}
        onSelectScenario={setStrategyId}
        onCreateScenario={handleCreateScenario}
        onDeleteScenario={handleDeleteScenario}
        scenarioBusy={isSaving}
        cadence={strategy.cadence}
        nextEvaluationOn={strategy.nextEvaluationOn}
        daysUntilNextEvaluation={strategy.daysUntilNextEvaluation}
        onEditSettings={() => setTab('settings')}
      />

      <GemStrategyTabs active={tab} onChange={setTab} />

      <GemWarningsBanner
        warnings={data.warnings}
        lookbackMonths={strategy.lookbackMonths}
      />

      {tab === 'overview' && (
        <div {...panelProps('overview')} className="space-y-4">
          {/* Four summary cards: signal, portfolio fit, money to move, asset roster. */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <GemSignalCard
              signal={signal}
              nextEvaluationOn={strategy.nextEvaluationOn}
              daysUntilNextEvaluation={strategy.daysUntilNextEvaluation}
              firstRun={codes.has('FIRST_RUN')}
              failed={codes.has('CALCULATION_FAILED')}
            />
            <GemPortfolioCard position={position} noAccount={codes.has('NO_ACCOUNT')} />
            <GemTransferCard
              action={action}
              signalUnavailable={signalUnavailable}
              noAccount={codes.has('NO_ACCOUNT')}
            />
            <GemAssetsCard assets={assets} winnerRole={winnerRole} />
          </div>

          {/*
            Chart left / recommendation right on wide screens. On mobile the
            recommendation comes first (it is the actionable part); from the
            tablet breakpoint the chart leads, per the layout spec.
          */}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)] xl:items-start">
            <div className="order-2 md:order-1 xl:order-none">
              <GemPerformanceChart
                performance={performance}
                assets={assets}
                winnerRole={winnerRole}
                range={range}
                onRangeChange={setRange}
                isLoading={isLoading}
              />
            </div>
            <div className="order-1 space-y-4 md:order-2 xl:order-none">
              <GemNextActionCard
                action={action}
                signalUnavailable={signalUnavailable}
                noAccount={codes.has('NO_ACCOUNT')}
                onMarkExecuted={handleMarkExecuted}
                onAddTransactions={handleAddTransactions}
                isSaving={isSaving}
              />
              <GemAllocationCard
                signal={signal}
                winnerRole={winnerRole}
                cadence={strategy.cadence}
              />
            </div>
          </div>

          <GemReasoningSection signal={signal} lookbackMonths={strategy.lookbackMonths} />

          <GemSignalHistoryTable
            history={history}
            limit={OVERVIEW_HISTORY_ROWS}
            onShowAll={() => setTab('signals')}
            symbolByRole={symbolByRole}
            lookbackMonths={strategy.lookbackMonths}
          />
        </div>
      )}

      {tab === 'signals' && (
        <div {...panelProps('signals')}>
          <GemSignalHistoryTable
            history={history}
            symbolByRole={symbolByRole}
            lookbackMonths={strategy.lookbackMonths}
          />
        </div>
      )}

      {tab === 'portfolio' && (
        <div {...panelProps('portfolio')} className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <GemPortfolioPanel
            position={position}
            noAccount={codes.has('NO_ACCOUNT')}
            noPosition={codes.has('NO_POSITION')}
          />
          <GemNextActionCard
            action={action}
            signalUnavailable={signalUnavailable}
            noAccount={codes.has('NO_ACCOUNT')}
            onMarkExecuted={handleMarkExecuted}
            onAddTransactions={handleAddTransactions}
            isSaving={isSaving}
          />
        </div>
      )}

      {tab === 'backtest' && (
        <div {...panelProps('backtest')}>
          <GemBacktestPanel backtest={backtest} />
        </div>
      )}

      {tab === 'settings' && (
        <div {...panelProps('settings')}>
          {/* Keyed on the scenario: react-hook-form reads its defaults once,
              at mount, so switching scenarios with the tab open would otherwise
              leave the previous scenario's values under the new one's name. */}
          <GemSettingsForm
            key={strategy.id ?? 'unsaved'}
            strategy={strategy}
            assets={assets}
            range={range}
            onSaved={handleConfigSaved}
          />
        </div>
      )}

      <GemStrategyFooter strategy={strategy} />
    </main>
  );
}
