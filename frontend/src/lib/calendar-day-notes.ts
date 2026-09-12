import apiClient from './api';
import { DayNote } from '@/types/calendar';
import { dedupe, invalidateCache } from './apiCache';

/**
 * The calendar's day notes.
 *
 * `calendar:` is its own cache family and is deliberately NOT dropped by
 * `invalidateBalanceCaches()`: a note moves no money, so a transaction write
 * cannot change one. Its own writes drop it, which is what the two functions
 * below do before returning.
 *
 * Keyed by range rather than by account scope or filters: a note belongs to the
 * day, not to what the reader is looking at on it.
 */
export const calendarDayNotesApi = {
  list: async (params: { startDate: string; endDate: string }): Promise<DayNote[]> => {
    const cacheKey = `calendar:day-notes:${params.startDate}:${params.endDate}`;
    return dedupe(
      cacheKey,
      async () => {
        const response = await apiClient.get<DayNote[]>('/calendar/day-notes', { params });
        return response.data;
      },
      30_000,
    );
  },

  /**
   * Write the note for one day, whole. The response is the STORED note --
   * adopt that, not the text that was sent, so `updatedAt` is the server's.
   */
  upsert: async (date: string, body: string): Promise<DayNote> => {
    const response = await apiClient.put<DayNote>(`/calendar/day-notes/${date}`, { body });
    invalidateCache('calendar:day-notes:');
    return response.data;
  },

  /** Idempotent: removing a day that holds no note succeeds. */
  remove: async (date: string): Promise<void> => {
    await apiClient.delete(`/calendar/day-notes/${date}`);
    invalidateCache('calendar:day-notes:');
  },
};
