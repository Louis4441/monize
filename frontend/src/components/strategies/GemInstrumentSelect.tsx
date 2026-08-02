"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useClickOutside } from "@/hooks/useClickOutside";
import { cn } from "@/lib/utils";
import { Security } from "@/types/investment";
import {
  GEM_SUGGESTION_REGIONS,
  GemSuggestedSecurity,
  GemSuggestionRegion,
  listingKey,
} from "@/lib/gem-suggested-securities";

interface GemInstrumentSelectProps {
  /** The role being assigned; only used to build stable element ids. */
  role: string;
  /** Accessible name for the control, and the visible field label. */
  label: string;
  /** Assigned security id, or '' for a role left unassigned. */
  value: string;
  /** Instruments the portfolio already holds and can be pointed at. */
  securities: Security[];
  /** Suggested instruments for this role, one per region. */
  suggestions: readonly GemSuggestedSecurity[];
  onChange: (securityId: string) => void;
  /** Chosen a suggestion: the caller opens the create form prefilled from it. */
  onPickSuggestion: (suggestion: GemSuggestedSecurity) => void;
  disabled?: boolean;
  error?: string;
}

/**
 * The instrument for one GEM role: a dropdown over what the portfolio already
 * holds, with the suggested ETFs for that role pinned above it.
 *
 * The suggestions are the point. A strategy needs five specific kinds of fund
 * and a portfolio that has never run one offers nothing to select, which left
 * the only path through a create form the investor had to know what to type
 * into. Here the fund is named -- per region, because the same index trades as
 * a different listing in the US and in Europe -- and picking one opens the
 * create form already filled in, where the exchange and currency can still be
 * corrected to whatever the broker actually trades.
 *
 * There is no search box: the list is five suggestions plus the securities of
 * one portfolio, and the whole thing fits on screen.
 */
export function GemInstrumentSelect({
  role,
  label,
  value,
  securities,
  suggestions,
  onChange,
  onPickSuggestion,
  disabled = false,
  error,
}: GemInstrumentSelectProps) {
  const t = useTranslations("strategies");
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useClickOutside(wrapperRef, () => setIsOpen(false), {
    enabled: isOpen,
    onEscape: () => {
      setIsOpen(false);
      triggerRef.current?.focus();
    },
  });

  const labelId = `gem-instrument-label-${role}`;
  const selected = securities.find((security) => security.id === value);
  const regionLabel = (region: GemSuggestionRegion): string =>
    t(`gem.settingsForm.regions.${region}` as Parameters<typeof t>[0]);

  const choose = (securityId: string) => {
    onChange(securityId);
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const pick = (suggestion: GemSuggestedSecurity) => {
    setIsOpen(false);
    onPickSuggestion(suggestion);
  };

  /**
   * Each suggestion paired with the instrument the portfolio already holds for
   * it, when there is one.
   *
   * A suggestion the user already owns used to be dropped from this group
   * entirely, on the reasoning that it needs no creating. What that produced is
   * the opposite of the intent: the fund this role should point at was the one
   * fund the picker said nothing about, buried somewhere in "Your instruments"
   * among everything else the portfolio holds, while the recommendations on
   * offer were exactly the instruments Monize did not have yet. The advice
   * disappeared the moment it became actionable in one click.
   *
   * So both stay, and `owned` decides what picking one does: select the
   * instrument, or open the create form prefilled from the suggestion.
   */
  const offered = suggestions.map((suggestion) => ({
    suggestion,
    // Listing identity, not ticker: the same symbol on another exchange or in
    // another trading currency is a different instrument, and reusing it would
    // quietly defeat the region the user picked.
    owned: securities.find(
      (security) => listingKey(security) === listingKey(suggestion),
    ),
  }));

  return (
    <div ref={wrapperRef} className="relative">
      <label
        id={labelId}
        className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        {label}
      </label>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-labelledby={labelId}
        className={cn(
          "block w-full rounded-md border px-3 py-2 text-left text-sm shadow-sm",
          "bg-white text-gray-900 dark:bg-gray-700 dark:text-gray-100",
          "focus:outline-none focus:ring-2 focus:ring-blue-500",
          "disabled:cursor-not-allowed disabled:opacity-60",
          error
            ? "border-red-500 dark:border-red-500"
            : "border-gray-300 dark:border-gray-600",
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "truncate",
              !selected && "text-gray-400 dark:text-gray-400",
            )}
          >
            {selected
              ? t("gem.settingsForm.instrumentOption", {
                  symbol: selected.symbol,
                  name: selected.name,
                })
              : t("gem.settingsForm.noInstrument")}
          </span>
          <svg
            className={cn(
              "h-5 w-5 shrink-0 text-gray-400 transition-transform",
              isOpen && "rotate-180",
            )}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      </button>

      {isOpen && (
        <div
          role="listbox"
          aria-labelledby={labelId}
          className={cn(
            "absolute z-20 mt-1 w-full rounded-md bg-white shadow-lg dark:bg-gray-800 dark:shadow-gray-700/50",
            "ring-1 ring-black/5 dark:ring-gray-600",
            "scrollbar-slim max-h-80 overflow-y-auto py-1",
          )}
        >
          {offered.length > 0 && (
            <>
              <p className="px-3 pt-1 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t("gem.settingsForm.suggestedHeading")}
              </p>
              {GEM_SUGGESTION_REGIONS.map((region) => {
                const inRegion = offered.filter(
                  ({ suggestion }) => suggestion.region === region,
                );
                if (inRegion.length === 0) return null;
                return (
                  <div key={region}>
                    <p className="px-3 py-1 text-xs text-gray-400 dark:text-gray-500">
                      {regionLabel(region)}
                    </p>
                    {inRegion.map(({ suggestion, owned }) => (
                      <button
                        key={`${suggestion.region}-${suggestion.symbol}`}
                        type="button"
                        role="option"
                        aria-selected={owned ? owned.id === value : false}
                        onClick={() =>
                          owned ? choose(owned.id) : pick(suggestion)
                        }
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                          "hover:bg-gray-100 dark:hover:bg-gray-700",
                          owned?.id === value &&
                            "bg-gray-50 dark:bg-gray-700/50",
                        )}
                      >
                        {owned ? (
                          <CheckIcon
                            className={cn(
                              "h-4 w-4 shrink-0",
                              owned.id === value
                                ? "text-blue-600 dark:text-blue-400"
                                : "text-gray-400",
                            )}
                            aria-hidden="true"
                          />
                        ) : (
                          <PlusIcon
                            className="h-4 w-4 shrink-0 text-gray-400"
                            aria-hidden="true"
                          />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-gray-900 dark:text-gray-100">
                            {owned ? owned.symbol : suggestion.symbol}
                          </span>
                          <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                            {owned
                              ? t("gem.settingsForm.suggestedOwned", {
                                  name: owned.name,
                                })
                              : t("gem.settingsForm.suggestedListing", {
                                  name: suggestion.name,
                                  exchange: suggestion.exchange ?? "",
                                })}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })}
              <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
            </>
          )}

          <p className="px-3 pt-1 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t("gem.settingsForm.ownedHeading")}
          </p>
          <button
            type="button"
            role="option"
            aria-selected={value === ""}
            onClick={() => choose("")}
            className={cn(
              "block w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700",
              value === ""
                ? "font-medium text-gray-900 dark:text-gray-100"
                : "text-gray-600 dark:text-gray-300",
            )}
          >
            {t("gem.settingsForm.noInstrument")}
          </button>
          {securities.map((security) => (
            <button
              key={security.id}
              type="button"
              role="option"
              aria-selected={security.id === value}
              onClick={() => choose(security.id)}
              className={cn(
                "block w-full truncate px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700",
                security.id === value
                  ? "font-medium text-gray-900 dark:text-gray-100"
                  : "text-gray-600 dark:text-gray-300",
              )}
            >
              {t("gem.settingsForm.instrumentOption", {
                symbol: security.symbol,
                name: security.name,
              })}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
