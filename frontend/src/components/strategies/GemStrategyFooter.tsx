"use client";

import { useTranslations } from "next-intl";
import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { useDateFormat } from "@/hooks/useDateFormat";
import { externalUrlLabel, toSafeExternalUrl } from "@/lib/external-url";
import { GemStrategyMeta } from "@/types/gem-strategy";

interface GemStrategyFooterProps {
  strategy: GemStrategyMeta;
}

/**
 * Quiet information bar closing the report: the standing caveats about momentum
 * strategies on the left, provenance (rules source, price date) on the right.
 */
export function GemStrategyFooter({ strategy }: GemStrategyFooterProps) {
  const t = useTranslations("strategies");
  const { formatDate } = useDateFormat();
  // A stored address is data: it may predate any normalisation, or have come
  // from an import. Only http(s) becomes a link; anything else is not shown.
  const rulesSourceHref = toSafeExternalUrl(strategy.rulesSourceUrl);

  return (
    <footer className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-400">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-2">
          <InformationCircleIcon
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <ul className="space-y-0.5">
            <li>{t("gem.footer.pastResults")}</li>
            <li>{t("gem.footer.discipline")}</li>
            <li>{t("gem.footer.costs")}</li>
          </ul>
        </div>
        <div className="space-y-0.5 lg:text-right">
          <p>
            {rulesSourceHref ? (
              <>
                {t("gem.footer.rulesSourceLabel")}{" "}
                <a
                  href={rulesSourceHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
                >
                  {strategy.rulesSourceLabel ??
                    externalUrlLabel(rulesSourceHref)}
                </a>
              </>
            ) : (
              t("gem.footer.rulesSourceUnknown")
            )}
          </p>
          <p>
            {strategy.pricesAsOf
              ? t("gem.footer.pricesAsOf", {
                  date: formatDate(strategy.pricesAsOf),
                })
              : t("gem.footer.pricesUnknown")}
          </p>
        </div>
      </div>
    </footer>
  );
}
