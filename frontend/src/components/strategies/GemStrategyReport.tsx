"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import toast from "react-hot-toast";
import { useReportData } from "@/hooks/useReportData";
import { ReportError } from "@/components/reports/ReportError";
import { UnsavedChangesDialog } from "@/components/ui/UnsavedChangesDialog";
import { Skeleton } from "@/components/ui/LoadingSkeleton";
import { createLogger } from "@/lib/logger";
import { gemStrategyApi } from "@/lib/gem-strategy";
import {
  GemAssetRole,
  GemRange,
  GemStrategyReport as GemStrategyReportData,
} from "@/types/gem-strategy";
import { GEM_DEFAULT_RANGE, warningCodes } from "@/lib/gem-strategy-view";
import { GemStrategyHeader } from "./GemStrategyHeader";
import { GemStrategyTabs, GemTab } from "./GemStrategyTabs";
import { GemWarningsBanner } from "./GemWarningsBanner";
import { GemSignalCard } from "./GemSignalCard";
import { GemPortfolioCard } from "./GemPortfolioCard";
import { GemTransferCard } from "./GemTransferCard";
import { GemAssetsCard } from "./GemAssetsCard";
import { GemPerformanceChart } from "./GemPerformanceChart";
import { GemNextActionCard } from "./GemNextActionCard";
import { GemAllocationCard } from "./GemAllocationCard";
import { GemReasoningSection } from "./GemReasoningSection";
import { GemSignalHistoryTable } from "./GemSignalHistoryTable";
import { GemPortfolioPanel } from "./GemPortfolioPanel";
import { GemBacktestPanel } from "./GemBacktestPanel";
import { GemSettingsForm } from "./GemSettingsForm";
import { GemStrategyFooter } from "./GemStrategyFooter";

const logger = createLogger("GemStrategyReport");

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
  const t = useTranslations("strategies");
  const router = useRouter();
  const [range, setRange] = useState<GemRange>(GEM_DEFAULT_RANGE);
  const [tab, setTab] = useState<GemTab>("overview");
  const [isSaving, setIsSaving] = useState(false);
  // The scenario on screen. Undefined means "whichever the server picks", which
  // is the user's first -- and the only one until they create a second.
  const [strategyId, setStrategyId] = useState<string | undefined>(undefined);

  /**
   * What the report on screen is a report *of*: the scenario and the chart
   * range together. Everything the page can act on is scoped to this pair, so
   * it is the identity a response has to match before it may be adopted or
   * acted upon.
   */
  const requestKey = `${range}|${strategyId ?? ""}`;

  const {
    data,
    dataKey,
    isLoading,
    error,
    reload,
    setData: setReport,
    adoptAs,
  } = useReportData<GemStrategyReportData>(
    () => gemStrategyApi.getReport(range, strategyId),
    [range, strategyId],
    { requestKey },
  );

  /**
   * True while what is rendered does not describe the current selection.
   *
   * The hook keeps the previous report visible during a load, which is the
   * right thing to look at and the wrong thing to act on: between selecting
   * scenario B and its report arriving, the page still shows A -- A's signal
   * id on the button, A's settings in the form. Every mutation is disabled
   * until the two agree again, so an action can only ever be aimed at the
   * report the user is actually reading.
   */
  const isStaleSelection = isLoading || dataKey !== requestKey;

  /**
   * Every mutation here answers with the refreshed report, so the response is
   * adopted rather than triggering a second read of the same thing -- but only
   * when the selection it was produced for is still the one on screen. A
   * settings save for scenario A that lands after the user moved to B would
   * otherwise retire B's fetch and put A back under B's selection.
   */
  const adopt = useCallback(
    (report: GemStrategyReportData, producedFor: string = requestKey) =>
      setReport(report, producedFor),
    [setReport, requestKey],
  );

  /**
   * A mutation that changed *which* scenario is on screen -- creating one,
   * deleting one -- also moves the page to whichever the server decided on.
   * That re-runs the loader, which is the point: the id has to stick, or the
   * next range change would fall back to the user's first scenario.
   */
  const adoptScenario = useCallback(
    (report: GemStrategyReportData) => {
      // Keyed to the scenario the response *is*, not to the one that was
      // selected a moment ago. Adopting it unkeyed stamped it with the
      // previous render's key, so the very next render found `dataKey` behind
      // `requestKey`, called a complete and correct report stale, and fetched
      // it again -- and if that superfluous request failed, a successful
      // create or delete was replaced by an error screen.
      setStrategyId(report.strategy.id ?? undefined);
      adoptAs(report, `${range}|${report.strategy.id ?? ""}`);
    },
    [adoptAs, range],
  );

  const codes = useMemo(() => warningCodes(data?.warnings), [data?.warnings]);
  const winnerRole = useMemo<GemAssetRole | null>(
    () => data?.signal?.target?.role ?? null,
    [data?.signal],
  );
  const symbolByRole = useMemo(
    () =>
      new Map((data?.assets ?? []).map((asset) => [asset.role, asset.symbol])),
    [data?.assets],
  );

  const handleMarkExecuted = useCallback(async () => {
    const signalId = data?.signal?.id;
    // Never act on a report that is not the current selection's: the id on
    // screen may belong to the scenario the user has just left.
    if (!signalId || isStaleSelection) return;
    const producedFor = requestKey;
    setIsSaving(true);
    try {
      adopt(
        await gemStrategyApi.markExecuted(signalId, range, strategyId),
        producedFor,
      );
      toast.success(t("gem.action.markExecutedSuccess"));
    } catch (err) {
      logger.error("Failed to mark the GEM operation as executed:", err);
      toast.error(t("gem.action.markExecutedError"));
    } finally {
      setIsSaving(false);
    }
  }, [
    adopt,
    data?.signal?.id,
    isStaleSelection,
    range,
    requestKey,
    strategyId,
    t,
  ]);

  const handleAddTransactions = useCallback(() => {
    router.push("/investments");
  }, [router]);

  /**
   * Both scenario mutations report success to the switcher rather than
   * swallowing it.
   *
   * The switcher closed its modal after awaiting these, and because the errors
   * are caught here the child saw a resolved promise either way -- so a
   * rejected create closed the dialog and threw away the name the user had just
   * typed. Returning a boolean keeps the failure visible to the one component
   * that can act on it, without a second toast.
   */
  const handleCreateScenario = useCallback(
    async (name: string) => {
      setIsSaving(true);
      try {
        const report = await gemStrategyApi.createStrategy(name, range);
        adoptScenario(report);
        setTab("settings");
        toast.success(
          t("gem.scenarios.created", { name: report.strategy.name }),
        );
        return true;
      } catch (err) {
        logger.error("Failed to create a GEM scenario:", err);
        toast.error(t("gem.scenarios.createError"));
        return false;
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
        setTab("overview");
        toast.success(t("gem.scenarios.deleted"));
        return true;
      } catch (err) {
        logger.error("Failed to delete a GEM scenario:", err);
        toast.error(t("gem.scenarios.deleteError"));
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [adoptScenario, range, t],
  );

  /**
   * The selection a settings save was started under.
   *
   * A save is a slow round trip and the user can change scenario or range
   * while it runs. Recording the key when the form begins lets the response be
   * matched against it: for the selection it belongs to it is adopted, and for
   * any other it is dropped and the newer fetch stands.
   */
  /**
   * Unsaved settings edits, and the navigation waiting on them.
   *
   * Every control that changes tab, scenario or deletes the scenario unmounts
   * the settings form, and remounting it under a new key does not bring the
   * edits back. The form reports its dirty state up; those controls run
   * through `guarded`, which holds the action until the user has said what to
   * do with the edits.
   */
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<
    (() => void) | null
  >(null);
  const submitSettings = useRef<(() => void) | null>(null);

  const guarded = useCallback(
    (action: () => void) => () => {
      if (!settingsDirty) {
        action();
        return;
      }
      // Stored as a thunk, so the state setter does not call it.
      setPendingNavigation(() => action);
    },
    [settingsDirty],
  );

  const savingForKey = useRef<string | null>(null);
  const savingForStrategy = useRef<string | null>(null);
  const handleSettingsSaving = useCallback(
    (saving: boolean) => {
      // Taken from the report the form is *rendering*, not from whatever is
      // selected when the save lands. The two are the same now that a stale
      // form is unmounted, and reading the rendered one keeps it true even if
      // that ever changes: an origin derived from the current selection would
      // stamp scenario A's save with scenario B's key.
      savingForKey.current = saving
        ? `${range}|${data?.strategy.id ?? ""}`
        : null;
      savingForStrategy.current = saving ? (data?.strategy.id ?? null) : null;
      setIsSaving(saving);
    },
    [range, data?.strategy.id],
  );

  /**
   * The save returns the strategy re-evaluated with its new configuration, so
   * the page takes it as-is -- provided the user is still looking at what was
   * saved. The scenario id is deliberately left alone: the save never moves the
   * user to a different one, and the first save creates the only scenario there
   * is, which is what an unset id already resolves to.
   */
  const handleConfigSaved = useCallback(
    (report: GemStrategyReportData) => {
      // The response has to be of the scenario that was saved. `updateConfig`
      // answers with the strategy it wrote, so a mismatch means the two have
      // drifted and neither is safe to show.
      if (
        savingForStrategy.current &&
        report.strategy.id !== savingForStrategy.current
      ) {
        return;
      }
      adopt(report, savingForKey.current ?? requestKey);
    },
    [adopt, requestKey],
  );

  // A failed load of a *new* selection cannot fall back to the old report.
  //
  // Keeping the previous one visible is right while the next is on its way and
  // wrong once it has failed: the page would then present scenario A, with A's
  // signal and A's numbers, as though it were the B the user asked for -- and
  // the actions on it would be aimed at A. `dataKey` is what tells the two
  // situations apart, because the hook stamps a failure with the key it was
  // loading rather than leaving the previous one in place.
  if (error && (!data || dataKey !== requestKey)) {
    return (
      <div className="px-4 pt-6 pb-8 sm:px-6 lg:px-12">
        <ReportError message={t("gem.error.loadFailed")} onRetry={reload} />
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

  const {
    strategy,
    assets,
    signal,
    position,
    action,
    performance,
    history,
    backtest,
  } = data;
  const signalUnavailable = signal === null;

  const panelProps = (panel: GemTab) => ({
    role: "tabpanel" as const,
    id: `gem-panel-${panel}`,
    "aria-labelledby": `gem-tab-${panel}`,
    tabIndex: -1,
  });

  return (
    <main className="px-4 pt-6 pb-8 sm:px-6 lg:px-12">
      <GemStrategyHeader
        strategyId={strategy.id}
        strategyName={strategy.name}
        scenarios={data.strategies}
        onSelectScenario={(id: string) => guarded(() => setStrategyId(id))()}
        onCreateScenario={handleCreateScenario}
        onDeleteScenario={async (id: string) => {
          // Deleting is the one guarded action that answers the child: the
          // confirmation stays open until it knows. Holding the edits means
          // the delete has not happened, so it reports failure and the
          // unsaved-changes dialog is what the user deals with next.
          if (settingsDirty) {
            guarded(() => void handleDeleteScenario(id))();
            return false;
          }
          return handleDeleteScenario(id);
        }}
        scenarioBusy={isSaving || isStaleSelection}
        cadence={strategy.cadence}
        nextEvaluationOn={strategy.nextEvaluationOn}
        daysUntilNextEvaluation={strategy.daysUntilNextEvaluation}
        onEditSettings={guarded(() => setTab("settings"))}
      />

      <GemStrategyTabs
        active={tab}
        onChange={(next: GemTab) => guarded(() => setTab(next))()}
      />

      <GemWarningsBanner
        warnings={data.warnings}
        lookbackMonths={strategy.lookbackMonths}
      />

      {tab === "overview" && (
        <div {...panelProps("overview")} className="space-y-4">
          {/* Four summary cards: signal, portfolio fit, money to move, asset roster. */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <GemSignalCard
              signal={signal}
              nextEvaluationOn={strategy.nextEvaluationOn}
              daysUntilNextEvaluation={strategy.daysUntilNextEvaluation}
              firstRun={codes.has("FIRST_RUN")}
              failed={codes.has("CALCULATION_FAILED")}
            />
            <GemPortfolioCard
              position={position}
              noAccount={codes.has("NO_ACCOUNT")}
            />
            <GemTransferCard
              action={action}
              signalUnavailable={signalUnavailable}
              noAccount={codes.has("NO_ACCOUNT")}
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
                noAccount={codes.has("NO_ACCOUNT")}
                onMarkExecuted={handleMarkExecuted}
                onAddTransactions={handleAddTransactions}
                isSaving={isSaving || isStaleSelection}
              />
              <GemAllocationCard
                signal={signal}
                winnerRole={winnerRole}
                cadence={strategy.cadence}
              />
            </div>
          </div>

          <GemReasoningSection
            signal={signal}
            lookbackMonths={strategy.lookbackMonths}
          />

          <GemSignalHistoryTable
            history={history}
            limit={OVERVIEW_HISTORY_ROWS}
            onShowAll={guarded(() => setTab("signals"))}
            symbolByRole={symbolByRole}
            lookbackMonths={strategy.lookbackMonths}
          />
        </div>
      )}

      {tab === "signals" && (
        <div {...panelProps("signals")}>
          <GemSignalHistoryTable
            history={history}
            symbolByRole={symbolByRole}
            lookbackMonths={strategy.lookbackMonths}
          />
        </div>
      )}

      {tab === "portfolio" && (
        <div
          {...panelProps("portfolio")}
          className="grid gap-4 lg:grid-cols-2 lg:items-start"
        >
          <GemPortfolioPanel
            position={position}
            noAccount={codes.has("NO_ACCOUNT")}
            noPosition={codes.has("NO_POSITION")}
          />
          <GemNextActionCard
            action={action}
            signalUnavailable={signalUnavailable}
            noAccount={codes.has("NO_ACCOUNT")}
            onMarkExecuted={handleMarkExecuted}
            onAddTransactions={handleAddTransactions}
            isSaving={isSaving || isStaleSelection}
          />
        </div>
      )}

      {tab === "backtest" && (
        <div {...panelProps("backtest")}>
          <GemBacktestPanel backtest={backtest} />
        </div>
      )}

      {tab === "settings" && (
        <div {...panelProps("settings")}>
          {isStaleSelection ? (
            /* The whole form goes, not just its submit button. Disabling the
               action cards was not enough here: the form kept rendering the
               scenario the user had just left, with its instrument pickers,
               its one-click fill and its save all live, so a submit sent the
               old scenario's id and the response could then be adopted under
               the new selection. There is no version of this form that is
               safe to interact with while it describes something other than
               what is selected. */
            <Skeleton className="h-96 w-full" />
          ) : (
            /* Keyed on the scenario: react-hook-form reads its defaults once,
               at mount, so switching scenarios with the tab open would
               otherwise leave the previous scenario's values under the new
               one's name. */
            <GemSettingsForm
              key={strategy.id ?? "unsaved"}
              strategy={strategy}
              assets={assets}
              range={range}
              onSaved={handleConfigSaved}
              onDirtyChange={setSettingsDirty}
              submitRef={submitSettings}
              onSavingChange={handleSettingsSaving}
            />
          )}
        </div>
      )}

      <GemStrategyFooter strategy={strategy} />

      {/* The repository's own dialog rather than a second bespoke flow.
          "Save" submits the form and stays put: navigating on the strength of
          a submit that has not resolved would discard the edits anyway if the
          server refused them. */}
      <UnsavedChangesDialog
        isOpen={pendingNavigation !== null}
        onSave={() => {
          setPendingNavigation(null);
          submitSettings.current?.();
        }}
        onDiscard={() => {
          const action = pendingNavigation;
          setSettingsDirty(false);
          setPendingNavigation(null);
          action?.();
        }}
        onCancel={() => setPendingNavigation(null)}
      />
    </main>
  );
}
