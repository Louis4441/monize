import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@/test/render';
import { useCalendarDayNotes } from './useCalendarDayNotes';
import type { DayNote } from '@/types/calendar';

const mockList = vi.fn();
const mockUpsert = vi.fn();
const mockRemove = vi.fn();
vi.mock('@/lib/calendar-day-notes', () => ({
  calendarDayNotesApi: {
    list: (...args: unknown[]) => mockList(...args),
    upsert: (...args: unknown[]) => mockUpsert(...args),
    remove: (...args: unknown[]) => mockRemove(...args),
  },
}));

function note(date: string, body = 'Call the landlord'): DayNote {
  return { date, body, updatedAt: '2026-06-09T12:00:00.000Z' };
}

function renderNotes(enabled = true) {
  return renderHook(() =>
    useCalendarDayNotes({ startDate: '2026-05-31', endDate: '2026-07-04', enabled }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([note('2026-06-10')]);
  mockUpsert.mockResolvedValue(note('2026-06-10', 'Saved'));
  mockRemove.mockResolvedValue(undefined);
});

describe('useCalendarDayNotes', () => {
  it('asks for the grid range once, keyed by nothing else', async () => {
    const { result } = renderNotes();

    await waitFor(() => expect(result.current.byDay.size).toBe(1));
    expect(mockList).toHaveBeenCalledWith({ startDate: '2026-05-31', endDate: '2026-07-04' });
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(result.current.byDay.get('2026-06-10')?.body).toBe('Call the landlord');
  });

  it('asks nothing in an acting-delegate session', async () => {
    const { result } = renderNotes(false);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockList).not.toHaveBeenCalled();
    expect(result.current.byDay.size).toBe(0);
  });

  it('refetches the range after its own write', async () => {
    const { result } = renderNotes();
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.save('2026-06-10', 'Saved');
    });

    expect(mockUpsert).toHaveBeenCalledWith('2026-06-10', 'Saved');
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('refetches the range after a delete', async () => {
    const { result } = renderNotes();
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.remove('2026-06-10');
    });

    expect(mockRemove).toHaveBeenCalledWith('2026-06-10');
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('keeps a failed list a failure, with the notes simply absent', async () => {
    mockList.mockRejectedValue(new Error('offline'));
    const { result } = renderNotes();

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.byDay.size).toBe(0);
    // An empty map is what a failure and an empty range have in common, so it
    // cannot be what a caller reads before offering to write one.
    expect(result.current.loaded).toBe(false);
  });

  it('separates a range that holds no note from a list it does not have', async () => {
    mockList.mockResolvedValue([]);
    const { result } = renderNotes();

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.byDay.size).toBe(0);
  });

  it('reports no list in an acting-delegate session, not an empty one', async () => {
    const { result } = renderNotes(false);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loaded).toBe(false);
  });

  describe('leaving a day with a draft', () => {
    it('runs the change straight away when there is nothing to lose', async () => {
      const { result } = renderNotes();
      await waitFor(() => expect(result.current.byDay.size).toBe(1));

      const action = vi.fn();
      act(() => result.current.requestChange(action));

      expect(action).toHaveBeenCalled();
      expect(result.current.confirmDiscard.isOpen).toBe(false);
    });

    it('asks first when a draft is open, and keeps it on cancel', async () => {
      const { result } = renderNotes();
      await waitFor(() => expect(result.current.byDay.size).toBe(1));

      act(() => result.current.setDraftDirty(true));
      const action = vi.fn();
      act(() => result.current.requestChange(action));

      expect(action).not.toHaveBeenCalled();
      expect(result.current.confirmDiscard.isOpen).toBe(true);

      act(() => result.current.confirmDiscard.onCancel());
      expect(action).not.toHaveBeenCalled();
      expect(result.current.confirmDiscard.isOpen).toBe(false);
    });

    it('runs the change once the reader confirms the draft goes', async () => {
      const { result } = renderNotes();
      await waitFor(() => expect(result.current.byDay.size).toBe(1));

      act(() => result.current.setDraftDirty(true));
      const action = vi.fn();
      act(() => result.current.requestChange(action));
      act(() => result.current.confirmDiscard.onConfirm());

      expect(action).toHaveBeenCalled();
      expect(result.current.confirmDiscard.isOpen).toBe(false);
    });
  });
});
