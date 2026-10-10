'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { investmentsApi } from '@/lib/investments';
import type { BondInstrumentSummary } from '@/types/bond';

export interface BondInstrumentPicker {
  options: Array<{ value: string; label: string }>;
  /** The link that is submitted and shown ('' is "not linked"). */
  effectiveBondId: string;
  /** True while the catalog request is outstanding. */
  isLoading: boolean;
  /** True when the catalog request failed; that is not an empty catalog. */
  loadFailed: boolean;
  retry: () => void;
}

/**
 * The bond catalog, fetched the first time the type is BOND, and the options
 * and link derived from it.
 *
 * A linked security's currency equals its instrument's, so only matching
 * instruments are offered. A currency change that leaves the instrument
 * unmatched drops the link. With no catalog loaded nothing can be judged, so
 * the stored link stands and stays visible.
 */
export function useBondInstrumentPicker(
  isBond: boolean,
  currency: string,
  selectedBondId: string,
): BondInstrumentPicker {
  const t = useTranslations('securities');
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

  const options = useMemo(() => {
    const matching = (instruments ?? [])
      .filter((b) => b.currencyCode === currency)
      .map((b) => ({
        value: b.id,
        label: t('form.bondInstrumentOption', {
          series: b.seriesCode,
          country: b.issuerCountryCode,
          program: b.programCode,
        }),
      }));
    const all = [{ value: '', label: t('form.bondInstrumentNone') }, ...matching];
    // The catalog has not loaded: keep the existing link visible rather than
    // letting the select blank it.
    if (instruments === null && selectedBondId) {
      all.push({ value: selectedBondId, label: t('form.bondInstrumentCurrent') });
    }
    return all;
  }, [instruments, currency, selectedBondId, t]);

  const effectiveBondId =
    selectedBondId &&
    (instruments === null ||
      instruments.some((b) => b.id === selectedBondId && b.currencyCode === currency))
      ? selectedBondId
      : '';

  return {
    options,
    effectiveBondId,
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
  onChange: (bondInstrumentId: string) => void;
  error?: string;
}

/** The bond series select, with a loading hint and a retryable failure. */
export function BondInstrumentSelect({ picker, onChange, error }: BondInstrumentSelectProps) {
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
