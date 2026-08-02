"use client";

import { useTranslations } from "next-intl";
import {
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import { GemWarning, GemWarningCode } from "@/types/gem-strategy";
import { GEM_ROLE_ORDER } from "@/lib/gem-strategy-view";
import { useGemLabels } from "./useGemLabels";

/**
 * Codes surfaced as a banner. `NO_ACCOUNT` and `NO_POSITION` are intentionally
 * absent: the portfolio and recommendation cards already explain those in place,
 * and repeating them here would say the same thing twice.
 */
const BANNER_CODES: GemWarningCode[] = [
  "CALCULATION_FAILED",
  "STALE_PRICES",
  "UNMAPPED_ROLE",
  "INCOMPLETE_HISTORY",
  "LEGACY_PERIODS",
  "FIRST_RUN",
];

const TONES: Record<
  "error" | "warning" | "info",
  { wrapper: string; icon: typeof XCircleIcon }
> = {
  error: {
    wrapper:
      "border-red-300 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-900/20 dark:text-red-300",
    icon: XCircleIcon,
  },
  warning: {
    wrapper:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-900/20 dark:text-amber-300",
    icon: ExclamationTriangleIcon,
  },
  info: {
    wrapper:
      "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-900/20 dark:text-blue-300",
    icon: InformationCircleIcon,
  },
};

function toneFor(code: GemWarningCode): "error" | "warning" | "info" {
  if (code === "CALCULATION_FAILED") return "error";
  if (code === "FIRST_RUN") return "info";
  return "warning";
}

interface GemWarningsBannerProps {
  warnings: GemWarning[];
  /** Momentum window, named by the incomplete-history warning. */
  lookbackMonths: number;
}

/**
 * Explains why parts of the report may be incomplete -- stale prices, a role
 * with no ETF assigned, missing history, a strategy that has never run. Rendered
 * above the cards so the caveat is read before the numbers.
 */
export function GemWarningsBanner({
  warnings,
  lookbackMonths,
}: GemWarningsBannerProps) {
  const t = useTranslations("strategies");
  const { roleLabel } = useGemLabels();

  const shown = BANNER_CODES.flatMap((code) =>
    warnings.filter((warning) => warning.code === code),
  );
  if (shown.length === 0) return null;

  return (
    <div className="mb-3 space-y-2">
      {shown.map((warning, index) => {
        const tone = TONES[toneFor(warning.code)];
        const Icon = tone.icon;
        // Listed in strategy order, whatever order the server sent them in.
        const roles = GEM_ROLE_ORDER.filter((role) =>
          (warning.roles ?? []).includes(role),
        );
        return (
          <div
            key={`${warning.code}-${index}`}
            role={warning.code === "CALCULATION_FAILED" ? "alert" : "status"}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${tone.wrapper}`}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              {t(`gem.warnings.${warning.code}` as Parameters<typeof t>[0], {
                months: lookbackMonths,
                count: warning.count ?? 0,
              })}
              {roles.length > 0 && (
                <span className="font-medium">
                  {" "}
                  {roles.map((role) => roleLabel(role)).join(", ")}
                </span>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}
