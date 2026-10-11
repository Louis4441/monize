'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { investmentsApi } from '@/lib/investments';
import type { BondInstrumentSummary } from '@/types/bond';
import { programLabel } from './detail/bond-labels';

export interface BondInstrumentPicker {
  options: Array<{ value: string; label: string }>;
  /** The link that is submitted and shown ('' is "not linked"). */
  effectiveBondId: string;
  /** True while the catalog request is outstanding. */
  isLoading: boolean;
  /** True when the catalog request failed; that is not an empty catalog. */
  loadFailed: boolean;
  retry: () => void;
  /**
   * The stored link's currency when the form's currency no longer matches it.
   * The link is kept (never silently dropped) and the form refuses to save
   * until the reader sets the currency back or unlinks on purpose.
   */
  mismatchedLinkCurrency: string | null;
  /** The catalog is loaded, has series, and none is in the form's currency. */
  noSeriesInCurrency: boolean;
  /** The currencies the catalog does offer, sorted. */
  catalogCurrencies: string[];
}

/**
 * The bond catalog, fetched the first time the type is BOND, and the options
 * and link derived from it.
 *
 * A linked security's currency equals its instrument's, so only matching
 * instruments are offered. A selection the reader just made that no longer
 * matches after a currency change is dropped; the STORED link is never dropped
 * by a currency change (that would delete the engine's prices unannounced): it
 * stays selected and is reported as `mismatchedLinkCurrency`. With no catalog
 * loaded nothing can be judged, so the stored link stands and stays visible.
 */
export function useBondInstrumentPicker(
  isBond: boolean,
  currency: string,
  selectedBondId: string,
  storedBondId: string = '',
): BondInstrumentPicker {
  const t = useTranslations('securities');
  const tDetail = useTranslations('securityDetail');
  // Null is "not loaded (yet, or the request failed)", never an empty catalog.
  const [instruments, setInstruments] = useState<BondInstrumentSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isBond) return;
    let cancelled = false;
    investmentsApi
      .listBondInstruments()
      .then((list) => {
        if (cancelled) return;
        setInstruments(list);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isBond, attempt]);

  // The stored link in another currency than the form's: kept, flagged.
  const keptMismatch =
    storedBondId !== '' && selectedBondId === storedBondId
      ? (instruments ?? []).find(
          (b) => b.id === storedBondId && b.currencyCode !== currency,
        )
      : undefined;

  const options = useMemo(() => {
    const optionLabel = (b: BondInstrumentSummary) =>
      t('form.bondInstrumentOption', {
        series: b.seriesCode,
        country: b.issuerCountryCode,
        program: programLabel(tDetail, b.programCode),
      });
    const matching = (instruments ?? [])
      .filter((b) => b.currencyCode === currency)
      .map((b) => ({ value: b.id, label: optionLabel(b) }));
    if (keptMismatch) {
      matching.push({ value: keptMismatch.id, label: optionLabel(keptMismatch) });
    }
    const all = [{ value: '', label: t('form.bondInstrumentNone') }, ...matching];
    // The catalog has not loaded: keep the existing link visible rather than
    // letting the select blank it.
    if (instruments === null && selectedBondId) {
      all.push({ value: selectedBondId, label: t('form.bondInstrumentCurrent') });
    }
    return all;
  }, [instruments, currency, selectedBondId, keptMismatch, t, tDetail]);

  const effectiveBondId =
    selectedBondId &&
    (instruments === null ||
      instruments.some((b) => b.id === selectedBondId && b.currencyCode === currency) ||
      keptMismatch !== undefined)
      ? selectedBondId
      : '';

  const catalogCurrencies = [
    ...new Set((instruments ?? []).map((b) => b.currencyCode)),
  ].sort();

  return {
    options,
    effectiveBondId,
    mismatchedLinkCurrency: keptMismatch ? keptMismatch.currencyCode : null,
    noSeriesInCurrency:
      instruments !== null &&
      instruments.length > 0 &&
      !instruments.some((b) => b.currencyCode === currency),
    catalogCurrencies,
    isLoading: isBond && instruments === null && !loadFailed,
    loadFailed,
    retry: () => {
      setLoadFailed(false);
      setAttempt((n) => n + 1);
    },
  };
}

interface BondInstrumentSelectProps {
  picker: BondInstrumentPicker;
  /** The form's currency, named in the empty-state hint. */
  currency: string;
  onChange: (bondInstrumentId: string) => void;
  error?: string;
}

/** The bond series select, with a loading hint and a retryable failure. */
export function BondInstrumentSelect({
  picker,
  currency,
  onChange,
  error,
}: BondInstrumentSelectProps) {
  const t = useTranslations('securities');
  return (
    <div>
      <Select
        label={t('form.bondInstrumentLabel')}
        options={picker.options}
        value={picker.effectiveBondId}
        onChange={(e) => onChange(e.target.value)}
        error={error}
      />
      {picker.isLoading && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400" role="status">
          {t('form.bondInstrumentLoading')}
        </p>
      )}
      {picker.mismatchedLinkCurrency !== null && (
        <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {t('form.bondCurrencyLocked', {
            linkedCurrency: picker.mismatchedLinkCurrency,
          })}
        </p>
      )}
      {picker.noSeriesInCurrency && picker.mismatchedLinkCurrency === null && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('form.bondNoSeriesInCurrency', {
            currency,
            currencies: picker.catalogCurrencies.join(', '),
          })}
        </p>
      )}
      {picker.loadFailed && (
        <div role="alert" className="mt-1 flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            {t('form.bondInstrumentLoadFailed')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={picker.retry}>
            {t('form.bondInstrumentRetry')}
          </Button>
        </div>
      )}
    </div>
  );
}
