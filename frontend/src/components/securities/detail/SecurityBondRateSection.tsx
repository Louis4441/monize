"use client";

import { useTranslations } from "next-intl";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from "@/components/ui/Table";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import type {
  BondLotValuation,
  BondRateRule,
  BondRateScheduleEntry,
  BondRateSource,
} from "@/types/bond";

interface SecurityBondRateSectionProps {
  lots: BondLotValuation[];
}

const RATE_SOURCE_VARIANT: Record<BondRateSource, BadgeVariant> = {
  TERMS: "blue",
  ANNOUNCED: "green",
  DERIVED: "gray",
  PROJECTED: "amber",
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How the rate is set, in words, and the rate of every period of each lot
 * (spec 13). The rule is read from the first lot: every lot of one security
 * shares the instrument's terms. The schedule differs per lot (its periods
 * start on the purchase date), so each lot has its own table under a heading
 * when there are several.
 */
export function SecurityBondRateSection({
  lots,
}: SecurityBondRateSectionProps) {
  const t = useTranslations("securityDetail");
  const { formatDate } = useDateFormat();
  const { formatPercentTrimmed } = useNumberFormat();

  if (lots.length === 0) return null;
  const rule = lots[0].valuation.rateRule;

  // Rates are fractions; the formatter takes percent units.
  const pct = (fraction: string) =>
    formatPercentTrimmed(Number(fraction) * 100);
  const benchmarkName = (id: string) =>
    t.has(`bond.benchmarks.${id}`) ? t(`bond.benchmarks.${id}`) : id;
  // A step series is keyed by a day, a monthly one by YYYY-MM (shown as stored).
  const observationLabel = (key: string) =>
    YMD.test(key) ? formatDate(key) : key;

  const ruleLines = (r: BondRateRule): string[] => {
    if (r.type === "FIXED") {
      return r.annualRate === null
        ? []
        : [t("bond.rate.rule.fixed", { rate: pct(r.annualRate) })];
    }
    if (r.benchmarkId === null || r.addend === null) return [];
    const benchmark = benchmarkName(r.benchmarkId);
    const addend = pct(r.addend);
    const lines =
      r.firstPeriodRate === null
        ? [t("bond.rate.rule.every", { benchmark, addend })]
        : [
            t("bond.rate.rule.firstThen", {
              firstRate: pct(r.firstPeriodRate),
              benchmark,
              addend,
            }),
          ];
    if (r.benchmarkFloor !== null && Number(r.benchmarkFloor) === 0) {
      lines.push(t("bond.rate.rule.floorZero", { benchmark }));
    }
    return lines;
  };

  const how = (entry: BondRateScheduleEntry) => {
    const b = entry.benchmark;
    if (b === null || entry.addend === null) {
      return (
        <span className="text-gray-500 dark:text-gray-400">
          {t("bond.rate.how.stated")}
        </span>
      );
    }
    const benchmark = benchmarkName(b.benchmarkId);
    const observation = observationLabel(b.observation);
    if (b.value === null) {
      return (
        <span className="text-gray-500 dark:text-gray-400">
          {t("bond.rate.how.missing", { benchmark, observation })}
        </span>
      );
    }
    const wasFloored =
      b.flooredValue !== null && Number(b.flooredValue) !== Number(b.value);
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {t("bond.rate.how.observed", {
            benchmark,
            observation,
            value: pct(b.value),
            addend: pct(entry.addend),
          })}
        </span>
        {wasFloored && b.flooredValue !== null && (
          <span className="text-gray-500 dark:text-gray-400">
            {t("bond.rate.how.floored", {
              floor: pct(b.flooredValue),
            })}
          </span>
        )}
        {entry.rateSource === "PROJECTED" && (
          <Badge variant="amber">{t("bond.lots.projected")}</Badge>
        )}
      </span>
    );
  };

  const unknown = (
    <span className="text-gray-500 dark:text-gray-400">
      {t("bond.unknown")}
    </span>
  );

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t("bond.rate.title")}
      </h4>
      <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
        {ruleLines(rule).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {lots.map((lot, lotIndex) => {
        const v = lot.valuation;
        return (
          <div
            key={`${lot.purchaseDate}-${lot.quantity}-${lotIndex}`}
            className="space-y-1"
          >
            {lots.length > 1 && (
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                {t("bond.rate.lotHeading", {
                  date: formatDate(lot.purchaseDate),
                })}
              </p>
            )}
            <div className="overflow-x-auto">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <Th>{t("bond.rate.columns.period")}</Th>
                    <Th>{t("bond.rate.columns.dates")}</Th>
                    <Th>{t("bond.rate.columns.rate")}</Th>
                    <Th>{t("bond.rate.columns.source")}</Th>
                    <Th>{t("bond.rate.columns.how")}</Th>
                  </tr>
                </thead>
                <tbody className={TABLE_BODY_CLASS}>
                  {v.rateSchedule.map((entry) => {
                    const isCurrent = v.currentPeriod?.index === entry.index;
                    return (
                      <tr
                        key={entry.index}
                        aria-current={isCurrent ? "true" : undefined}
                        className={
                          isCurrent
                            ? "bg-blue-50 dark:bg-blue-900/20"
                            : undefined
                        }
                      >
                        <Td className="whitespace-nowrap">
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <span>{entry.index}</span>
                            {isCurrent && (
                              <Badge variant="blue">
                                {t("bond.rate.current")}
                              </Badge>
                            )}
                          </span>
                        </Td>
                        <Td className="whitespace-nowrap">
                          {t("bond.rate.range", {
                            start: formatDate(entry.start),
                            end: formatDate(entry.end),
                          })}
                        </Td>
                        <Td className="whitespace-nowrap">
                          {entry.annualRate === null
                            ? unknown
                            : pct(entry.annualRate)}
                        </Td>
                        <Td className="whitespace-nowrap">
                          {entry.rateSource === null ? (
                            unknown
                          ) : (
                            <Badge
                              variant={RATE_SOURCE_VARIANT[entry.rateSource]}
                            >
                              {t(`bond.rateSource.${entry.rateSource}`)}
                            </Badge>
                          )}
                        </Td>
                        <Td>{how(entry)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
