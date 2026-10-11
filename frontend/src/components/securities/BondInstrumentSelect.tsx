'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { getErrorMessage } from '@/lib/errors';
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
  /**
   * The one catalog country issuing in the form's currency, the country a
   * series fetch is addressed to; null when the catalog is not loaded or the
   * currency maps to none or several countries.
   */
  fetchCountryCode: string | null;
  /** True when the loaded catalog holds this series code (any currency). */
  hasSeries: (seriesCode: string) => boolean;
  /** Adds a just-fetched instrument to the list and re-reads the catalog. */
  addInstrument: (instrument: BondInstrumentSummary) => void;
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

  const countriesInCurrency = [
    ...new Set(
      (instruments ?? [])
        .filter((b) => b.currencyCode === currency)
        .map((b) => b.issuerCountryCode),
    ),
  ];

  return {
    options,
    effectiveBondId,
    fetchCountryCode: countriesInCurrency.length === 1 ? countriesInCurrency[0] : null,
    hasSeries: (seriesCode) =>
      (instruments ?? []).some(
        (b) => b.seriesCode.toUpperCase() === seriesCode.toUpperCase(),
      ),
    addInstrument: (instrument) => {
      // Shown at once, then the catalog is re-read so it is the server's list.
      setInstruments((list) =>
        list === null || list.some((b) => b.id === instrument.id)
          ? list
          : [...list, instrument],
      );
      setAttempt((n) => n + 1);
    },
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

/** A bond series code: three letters (the product) and four digits (month and year), e.g. EDO1136. */
const SERIES_CODE = /^[A-Za-z]{3}\d{4}$/;

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
  const tBonds = useTranslations('bonds');
  const [search, setSearch] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Set synchronously, so two clicks in one tick cannot both send.
  const inFlight = useRef(false);

  const code = search.trim().toUpperCase();
  const canFetch =
    SERIES_CODE.test(code) &&
    picker.fetchCountryCode !== null &&
    !picker.hasSeries(code);

  const handleFetch = async () => {
    if (inFlight.current || picker.fetchCountryCode === null) return;
    inFlight.current = true;
    setFetching(true);
    setFetchError(null);
    try {
      const result = await investmentsApi.fetchBondSeries(
        picker.fetchCountryCode,
        code,
      );
      picker.addInstrument(result);
      onChange(result.id);
      setSearch('');
    } catch (err) {
      setFetchError(getErrorMessage(err, t('form.bondFetchFailed')));
    } finally {
      inFlight.current = false;
      setFetching(false);
    }
  };

  return (
    <div>
      <Select
        label={t('form.bondInstrumentLabel')}
        options={picker.options}
        value={picker.effectiveBondId}
        onChange={(e) => onChange(e.target.value)}
        error={error}
      />
      {/* A new tab: the form being filled in is not given up for the offer. */}
      <Link
        href="/investments/bonds"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
      >
        {tBonds('entry.seeOnSale')}
      </Link>
      <Input
        label={t('form.bondFetchSearchLabel')}
        placeholder={t('form.bondFetchSearchPlaceholder')}
        value={search}
        maxLength={7}
        onChange={(e) => {
          setSearch(e.target.value);
          setFetchError(null);
        }}
      />
      {(canFetch || fetching) && (
        <div className="mt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleFetch}
            disabled={fetching}
            isLoading={fetching}
          >
            {fetching
              ? t('form.bondFetching', { code })
              : t('form.bondFetchAction', { code })}
          </Button>
        </div>
      )}
      {fetchError !== null && (
        <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {fetchError}
        </p>
      )}
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
