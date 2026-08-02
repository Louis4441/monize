import {
  useState,
  useEffect,
  useCallback,
  useRef,
  DependencyList,
} from "react";
import { createLogger } from "@/lib/logger";

const logger = createLogger("useReportData");

interface UseReportDataResult<T> {
  /** The fetched data, or null before the first successful load. */
  data: T | null;
  /** True while a fetch is in flight (including the initial load). */
  isLoading: boolean;
  /**
   * Error from the most recent failed fetch, or null. Reports previously
   * swallowed fetch errors and rendered an empty state; surfacing this lets
   * the UI show a proper error message instead.
   */
  error: Error | null;
  /** Manually re-run the fetcher (e.g. after a mutation or a retry button). */
  reload: () => void;
  /**
   * Adopt data a mutation already returned, instead of fetching it again. An
   * endpoint that answers with the refreshed report has done the work the next
   * fetch would repeat, so re-running it is a round trip that can only produce
   * the same thing -- or, if something changed in between, a surprise. Any
   * fetch still in flight is retired: this value is the newer one.
   *
   * Pass the `requestKey` the value was produced *for* to have it discarded
   * when the selection has moved on since. Without a key it is adopted
   * unconditionally, which is the behaviour every caller that does not pass a
   * `requestKey` has always had.
   */
  setData: (value: T, producedFor?: string) => void;
  /**
   * Adopt a value and **declare** the request key it belongs to, rather than
   * matching it against the current one.
   *
   * For a mutation that changes the selection itself -- creating or deleting
   * the thing being selected -- there is no earlier key to match: the response
   * *is* the new selection, and the state that would carry its key has not
   * rendered yet. Matching there drops a correct response; leaving it unkeyed
   * stamps it with the outgoing key, so the next render calls it stale and
   * fetches again. Both are wrong; declaring the key is the third option.
   *
   * Use `setData` for a mutation within the current selection. Use this only
   * where the mutation moved the selection.
   */
  adoptAs: (value: T, key: string) => void;
  /**
   * The `requestKey` the current `data` belongs to, or null before the first
   * load. Compare it with the key you are rendering for: when they differ, the
   * data on screen describes a different request and must not be acted on.
   */
  dataKey: string | null;
}

export interface UseReportDataOptions {
  /**
   * Identity of the request the fetcher answers -- everything that selects
   * *what* is being loaded, not merely when. Supplying it makes the returned
   * data attributable, so a caller can refuse to act on a report that belongs
   * to a selection the user has already left.
   */
  requestKey?: string;
}

/**
 * Shared data-loading hook for the report components. Collapses the repeated
 * `setIsLoading(true); try { await api } catch { logger.error } finally
 * { setIsLoading(false) }` block into one place AND, critically, tracks an
 * error state that the reports never did -- so a failed fetch can render an
 * error message instead of silently showing an empty report.
 *
 * The fetcher is re-run whenever `deps` change (same contract as useEffect's
 * dependency array). A run counter guards against out-of-order responses: if
 * deps change mid-flight, only the latest run is allowed to commit state.
 */
export function useReportData<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  options: UseReportDataOptions = {},
): UseReportDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [dataKey, setDataKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Read through a ref so a key changing does not itself retrigger a fetch --
  // `deps` remains the only trigger, exactly as before.
  const requestKeyRef = useRef(options.requestKey);
  requestKeyRef.current = options.requestKey;

  // Keep the latest fetcher in a ref so changing its identity (common with
  // inline closures) does not by itself retrigger a fetch -- only `deps` and
  // explicit reloads do. This matches the manual loadData pattern it replaces.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const runIdRef = useRef(0);

  const run = useCallback(() => {
    const runId = ++runIdRef.current;
    const startedFor = requestKeyRef.current;
    setIsLoading(true);
    setError(null);
    fetcherRef
      .current()
      .then((result) => {
        if (runId !== runIdRef.current) return;
        setData(result);
        setDataKey(startedFor ?? null);
        setError(null);
      })
      .catch((err: unknown) => {
        if (runId !== runIdRef.current) return;
        logger.error("Failed to load report data:", err);
        // `dataKey` is deliberately left alone: it describes the data that
        // is actually held, and a failed load did not produce any. Stamping it
        // with the key that failed would tell the caller the old report now
        // belongs to the new selection -- the precise claim this exists to
        // prevent.
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (runId !== runIdRef.current) return;
        setIsLoading(false);
      });
  }, []);

  const replace = useCallback((value: T, producedFor?: string) => {
    // A response produced for a selection the user has since left is not the
    // newer value, it is a different one: adopting it would put scenario A's
    // report on screen under scenario B's selection, and the next action would
    // then be aimed at whichever of the two the caller happened to read.
    if (producedFor !== undefined && producedFor !== requestKeyRef.current) {
      return;
    }
    // Retire whatever is in flight: it was started earlier than this value was
    // produced, so letting it commit would put the stale answer back.
    runIdRef.current += 1;
    setData(value);
    setDataKey(requestKeyRef.current ?? null);
    setError(null);
    setIsLoading(false);
  }, []);

  /**
   * The key `adoptAs` last supplied, so the dependency change it causes does
   * not immediately re-fetch what it just delivered.
   *
   * Moving the selection is what makes the caller's `deps` change, so the
   * effect below fires on the very next render -- for a report the server has
   * already returned in full. That round trip can only produce the same thing,
   * and when it fails it replaces a successful create or delete with an error
   * screen.
   *
   * Only ever set for a key that differs from the current one. Setting it for
   * the key already selected would strand it: the deps do not change, so the
   * effect never runs to consume it, and the *next* genuine navigation back to
   * that key would be skipped and show whatever was on screen. Reachable when
   * a delete falls back to the scenario already selected.
   */
  const adoptedKeyRef = useRef<string | null>(null);

  const adoptAs = useCallback((value: T, key: string) => {
    runIdRef.current += 1;
    adoptedKeyRef.current = key === requestKeyRef.current ? null : key;
    setData(value);
    setDataKey(key);
    setError(null);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (
      adoptedKeyRef.current !== null &&
      adoptedKeyRef.current === requestKeyRef.current
    ) {
      adoptedKeyRef.current = null;
      return;
    }
    adoptedKeyRef.current = null;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    data,
    dataKey,
    isLoading,
    error,
    reload: run,
    setData: replace,
    adoptAs,
  };
}
