'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { baseInvestmentAction } from '@/lib/investment-actions';
import { expectedSeriesCode, programSeries } from '@/lib/bond-series';
import { getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import type { InvestmentAction, Security } from '@/types/investment';
import type { BondInstrumentSummary, BondProgramSummary } from '@/types/bond';

/** An acquisition names the series bought; a removal names the series it leaves. */
export type BondSeriesKind = 'acquire' | 'remove';

/**
 * Whether an action moves shares of a program-linked security, and which way
 * (spec `bond-program-securities.md` 2.3). A combined TRANSFER and the legs of
 * a posted transfer move lots with their series, so they name none.
 */
export function bondSeriesKind(action: InvestmentAction): BondSeriesKind | null {
  switch (baseInvestmentAction(action)) {
    case 'BUY':
    case 'REINVEST':
    case 'ADD_SHARES':
      return 'acquire';
    case 'SELL':
    case 'REMOVE_SHARES':
      return 'remove';
    default:
      return null;
  }
}

/** The select's value for "fetch the expected series", never a series id. */
const FETCH_VALUE = '__fetch__';

/** The errors the server raises about the series of a share-moving row. */
export const BOND_SERIES_ERROR_CODES = [
  'SERIES_NOT_IN_PROGRAM',
  'SERIES_NOT_DETERMINED',
  'REMOVAL_EXCEEDS_SERIES',
] as const;

interface AcquisitionData {
  key: string;
  program: BondProgramSummary | null;
  instruments: BondInstrumentSummary[];
}

interface RemovalData {
  key: string;
  series: Array<{ instrumentId: string; seriesCode: string }>;
}

export interface BondSeriesOptions {
  kind: BondSeriesKind;
  options: Array<{ value: string; label: string }>;
  /**
   * The series that prefills an acquisition: the one stored for the date. '' when
   * none is stored (the server then infers it, or refuses and says so).
   */
  suggestedId: string;
  isLoading: boolean;
  /** The lists could not be read; that is not "no series". */
  loadFailed: boolean;
  retry: () => void;
  /** The series to offer to fetch: the date's code, when it is not stored. */
  fetchCode: string | null;
  /** The issuing country the fetch is addressed to. */
  fetchCountryCode: string | null;
  /** Adds a just-fetched series to the list and re-reads the catalog. */
  addInstrument: (instrument: BondInstrumentSummary) => void;
}

/**
 * The series a share-moving row of a program-linked security can name.
 *
 * An acquisition lists the program's stored series (in the program's currency)
 * and expects the one whose code the date gives; a removal lists the series
 * the security's lots are in. Each answer is kept with the key that produced it
 * so a lookup for another security or date is never shown as this one's, and a
 * failed read is a failure, never an empty list. Returns null when the
 * security is not program-linked or the action names no series.
 */
export function useBondSeriesOptions(
  security: Security | null | undefined,
  kind: BondSeriesKind | null,
  date: string,
): BondSeriesOptions | null {
  const t = useTranslations('investments');
  const tSec = useTranslations('securities');
  const programId = security?.bondProgramId ?? null;
  const securityId = security?.id ?? null;
  const active = programId !== null && securityId !== null && kind !== null;

  const [acquisition, setAcquisition] = useState<AcquisitionData | null>(null);
  const [removal, setRemoval] = useState<RemovalData | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // One request per (kind, security, program): the date only picks from the list.
  const key = `${kind}|${securityId}|${programId}`;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const failed = () => {
      if (!cancelled) setFailedKey(key);
    };
    if (kind === 'acquire') {
      Promise.all([investmentsApi.listBondPrograms(), investmentsApi.listBondInstruments()])
        .then(([programs, instruments]) => {
          if (cancelled) return;
          const program = programs.find((p) => p.id === programId) ?? null;
          setAcquisition({
            key,
            program,
            instruments:
              program === null
                ? []
                : programSeries(
                    instruments,
                    program.programCode,
                    program.currency,
                    program.issuerCountryCode,
                  ),
          });
          setFailedKey(null);
        })
        .catch(failed);
    } else {
      investmentsApi
        .getSecurityBondValuation(securityId as string)
        .then((valuation) => {
          if (cancelled) return;
          const seen = new Map<string, string>();
          for (const lot of valuation.lots) {
            if (!seen.has(lot.instrumentId)) {
              seen.set(lot.instrumentId, lot.valuation.seriesCode);
            }
          }
          setRemoval({
            key,
            series: [...seen.entries()]
              .map(([instrumentId, seriesCode]) => ({ instrumentId, seriesCode }))
              .sort((a, b) => a.seriesCode.localeCompare(b.seriesCode)),
          });
          setFailedKey(null);
        })
        .catch(failed);
    }
    return () => {
      cancelled = true;
    };
  }, [active, kind, key, securityId, programId, attempt]);

  const acq = acquisition?.key === key ? acquisition : null;
  const rem = removal?.key === key ? removal : null;
  const expected =
    acq?.program != null ? expectedSeriesCode(acq.program.programCode, date) : null;
  const storedExpected =
    expected === null
      ? undefined
      : acq?.instruments.find((i) => i.seriesCode === expected);

  const options = useMemo(() => {
    if (kind === 'remove') {
      return [
        { value: '', label: t('transactionForm.bondSeries.oldestFirst') },
        ...(rem?.series ?? []).map((s) => ({ value: s.instrumentId, label: s.seriesCode })),
      ];
    }
    const list = [
      { value: '', label: t('transactionForm.bondSeries.fromDate') },
      ...(acq?.instruments ?? []).map((i) => ({ value: i.id, label: i.seriesCode })),
    ];
    if (expected !== null && storedExpected === undefined && acq?.program != null) {
      list.push({
        value: FETCH_VALUE,
        label: tSec('form.bondFetchAction', { code: expected }),
      });
    }
    return list;
  }, [kind, rem, acq, expected, storedExpected, t, tSec]);

  if (!active) return null;
  const loaded = kind === 'acquire' ? acq !== null : rem !== null;
  return {
    kind,
    options,
    suggestedId: storedExpected?.id ?? '',
    isLoading: !loaded && failedKey !== key,
    loadFailed: !loaded && failedKey === key,
    retry: () => {
      setFailedKey(null);
      setAttempt((n) => n + 1);
    },
    fetchCode: storedExpected === undefined ? expected : null,
    fetchCountryCode: acq?.program?.issuerCountryCode ?? null,
    addInstrument: (instrument) => {
      // Shown at once, then the catalog is re-read so it is the server's list.
      setAcquisition((current) =>
        current === null || current.instruments.some((i) => i.id === instrument.id)
          ? current
          : {
              ...current,
              instruments: [...current.instruments, instrument].sort((a, b) =>
                a.seriesCode.localeCompare(b.seriesCode),
              ),
            },
      );
      setAttempt((n) => n + 1);
    },
  };
}

interface BondSeriesSelectProps {
  series: BondSeriesOptions;
  /** The series shown and sent: the reader's pick, else the date's suggestion. */
  value: string;
  onChange: (bondInstrumentId: string) => void;
  /** The server's refusal about the series, said where the reader picks it. */
  error?: string;
}

/**
 * The series select of the investment transaction form. For an acquisition the
 * last option fetches the series the date expects from the official source when
 * the catalog does not hold it; the series fetched is then selected.
 */
export function BondSeriesSelect({ series, value, onChange, error }: BondSeriesSelectProps) {
  const t = useTranslations('investments');
  const tSec = useTranslations('securities');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Set synchronously, so two changes in one tick cannot both send.
  const inFlight = useRef(false);

  const handleFetch = async () => {
    const code = series.fetchCode;
    if (inFlight.current || code === null || series.fetchCountryCode === null) return;
    inFlight.current = true;
    setFetching(true);
    setFetchError(null);
    try {
      const result = await investmentsApi.fetchBondSeries(series.fetchCountryCode, code);
      series.addInstrument(result);
      onChange(result.id);
    } catch (err) {
      setFetchError(getErrorMessage(err, tSec('form.bondFetchFailed')));
    } finally {
      inFlight.current = false;
      setFetching(false);
    }
  };

  return (
    <div>
      <Select
        label={t('transactionForm.bondSeries.label')}
        options={series.options}
        value={value}
        disabled={fetching}
        onChange={(e) => {
          if (e.target.value === FETCH_VALUE) {
            void handleFetch();
            return;
          }
          setFetchError(null);
          onChange(e.target.value);
        }}
        error={error}
      />
      {fetching && series.fetchCode !== null && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400" role="status">
          {tSec('form.bondFetching', { code: series.fetchCode })}
        </p>
      )}
      {fetchError !== null && (
        <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {fetchError}
        </p>
      )}
      {series.isLoading && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400" role="status">
          {t('transactionForm.bondSeries.loading')}
        </p>
      )}
      {series.loadFailed && (
        <div role="alert" className="mt-1 flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            {t('transactionForm.bondSeries.loadFailed')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={series.retry}>
            {t('transactionForm.bondSeries.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
