import { useCallback, useMemo, useRef, useState } from 'react';
import { useReportData } from '@/hooks/useReportData';
import { calendarDayNotesApi } from '@/lib/calendar-day-notes';
import type { DayNote } from '@/types/calendar';

/**
 * The reader's notes for the days one calendar grid covers.
 *
 * Keyed by the range and nothing else: a note belongs to the day, not to the
 * accounts a page is filtered to or the layers that happen to be on, so the
 * same note is on both calendars and switching a filter does not re-ask for it.
 *
 * A note is owner-only and the routes are not delegate-reachable, so an acting
 * delegate asks for nothing (`enabled: false`) rather than asking and rendering
 * the 403 as an empty day.
 */
export interface CalendarDayNotesState {
  byDay: ReadonlyMap<string, DayNote>;
  /**
   * The range's notes are actually in hand.
   *
   * False means the list is ABSENT -- not yet asked for, still in flight, failed,
   * or belonging to a range the reader has left -- which is a different thing
   * from a range that holds no note. A caller that offers to write a note reads
   * this first: "this day has none" is a claim only a loaded list can make, and
   * the write is a whole-body upsert that would replace a note the client never
   * saw.
   */
  loaded: boolean;
  isLoading: boolean;
  /** The list could not be loaded; the other layers are unaffected. */
  error: Error | null;
  isStale: boolean;
  reload: () => void;
  /** Write one day's note whole and refetch the range. */
  save: (date: string, body: string) => Promise<DayNote>;
  /** Remove one day's note and refetch the range. Idempotent on the server. */
  remove: (date: string) => Promise<void>;
  /** Told by the editor whether there is an unsaved draft. */
  setDraftDirty: (dirty: boolean) => void;
  /**
   * Do something that would take the draft off screen -- open another day, step
   * the month, close the panel -- asking first when there is one to lose.
   */
  requestChange: (action: () => void) => void;
  /** Spread onto a `ConfirmDialog`; open only while a change is being asked about. */
  confirmDiscard: {
    isOpen: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  };
}

export function useCalendarDayNotes(params: {
  startDate: string;
  endDate: string;
  enabled: boolean;
}): CalendarDayNotesState {
  const { startDate, endDate, enabled } = params;
  const requestKey = `${enabled ? 'on' : 'off'}:${startDate}:${endDate}`;

  const result = useReportData<DayNote[] | null>(
    async () => {
      if (!enabled) return null;
      return calendarDayNotesApi.list({ startDate, endDate });
    },
    [requestKey],
    { requestKey },
  );

  const byDay = useMemo(() => {
    const days = new Map<string, DayNote>();
    for (const note of result.data ?? []) days.set(note.date, note);
    return days;
  }, [result.data]);

  const { reload } = result;

  const save = useCallback(
    async (date: string, body: string) => {
      // The client's own write drops its `calendar:day-notes:` entries; the
      // refetch is what puts the stored note, with the server's `updatedAt`, on
      // screen.
      const saved = await calendarDayNotesApi.upsert(date, body);
      reload();
      return saved;
    },
    [reload],
  );

  const remove = useCallback(
    async (date: string) => {
      await calendarDayNotesApi.remove(date);
      reload();
    },
    [reload],
  );

  // A ref rather than state: the guard is read inside a callback at the moment
  // of the change, and re-rendering every cell because a character was typed
  // into the note would be a cost paid on every keystroke.
  const isDirtyRef = useRef(false);
  const [pending, setPending] = useState<{ run: () => void } | null>(null);

  const setDraftDirty = useCallback((dirty: boolean) => {
    isDirtyRef.current = dirty;
  }, []);

  const requestChange = useCallback((action: () => void) => {
    if (!isDirtyRef.current) {
      action();
      return;
    }
    setPending({ run: action });
  }, []);

  const confirmDiscard = useMemo(
    () => ({
      isOpen: pending !== null,
      onConfirm: () => {
        isDirtyRef.current = false;
        pending?.run();
        setPending(null);
      },
      // The draft survives a cancel: the change the reader asked for is the
      // thing dropped, not the text they were writing.
      onCancel: () => setPending(null),
    }),
    [pending],
  );

  const isStale = result.data !== null && result.dataKey !== requestKey;
  const loaded = result.data !== null && !isStale;

  return useMemo(
    () => ({
      byDay,
      loaded,
      isLoading: result.isLoading,
      error: result.error,
      isStale,
      reload,
      save,
      remove,
      setDraftDirty,
      requestChange,
      confirmDiscard,
    }),
    [
      byDay,
      loaded,
      result.isLoading,
      result.error,
      isStale,
      reload,
      save,
      remove,
      setDraftDirty,
      requestChange,
      confirmDiscard,
    ],
  );
}
