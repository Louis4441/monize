import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { CalendarDayNote } from './CalendarDayNote';
import calendarNs from '@/i18n/messages/en/calendar.json';
import { CALENDAR_DAY_NOTE_MAX_LENGTH } from '@/lib/calendar-day-note';
import type { DayNote } from '@/types/calendar';

const onSave = vi.fn();
const onDelete = vi.fn();
const onDirtyChange = vi.fn();

function note(overrides: Partial<DayNote> = {}): DayNote {
  return {
    date: '2026-06-10',
    body: 'Rent is due, call the landlord',
    updatedAt: '2026-06-09T12:00:00.000Z',
    ...overrides,
  };
}

function renderNote(props: Partial<React.ComponentProps<typeof CalendarDayNote>> = {}) {
  return render(
    <CalendarDayNote
      date="2026-06-10"
      onSave={onSave}
      onDelete={onDelete}
      onDirtyChange={onDirtyChange}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  onSave.mockResolvedValue(note());
  onDelete.mockResolvedValue(undefined);
});

describe('CalendarDayNote', () => {
  describe('a day with no note (table E)', () => {
    it('offers to add one', () => {
      renderNote();

      expect(screen.getByRole('button', { name: calendarNs.notes.add })).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('saves the body the reader typed, for the day it was opened on', async () => {
      renderNote();

      fireEvent.click(screen.getByRole('button', { name: calendarNs.notes.add }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Dentist at 9' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      expect(onSave).toHaveBeenCalledWith('2026-06-10', 'Dentist at 9');
    });

    it('stops the reader at the stored cap rather than letting the save report it', () => {
      renderNote();

      fireEvent.click(screen.getByRole('button', { name: calendarNs.notes.add }));
      expect(screen.getByRole('textbox')).toHaveAttribute(
        'maxLength',
        String(CALENDAR_DAY_NOTE_MAX_LENGTH),
      );
    });

    it('refuses to send a blank body: clearing a note is Delete', () => {
      renderNote();

      fireEvent.click(screen.getByRole('button', { name: calendarNs.notes.add }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  describe('a day with a note (table E)', () => {
    it('shows the body, and offers Edit and Delete', () => {
      renderNote({ note: note() });

      expect(screen.getByText(/Rent is due/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it('renders a body that looks like markup as the characters that were typed', () => {
      renderNote({ note: note({ body: '<script>alert(1)</script>' }) });

      expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
      expect(document.querySelector('script')).toBeNull();
    });

    it('asks before deleting, and deletes the day it is showing', async () => {
      renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(screen.getByText(calendarNs.notes.deleteMessage)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]);
      });

      expect(onDelete).toHaveBeenCalledWith('2026-06-10');
    });

    it('opens the editor on the stored body', () => {
      renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

      expect(screen.getByRole('textbox')).toHaveValue('Rent is due, call the landlord');
    });
  });

  describe('a draft belongs to the day it was opened for (I12)', () => {
    it('tells its host when there is a draft to lose, and when there is not', () => {
      renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed' } });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);

      // Typing the stored body back is not a change to lose.
      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: 'Rent is due, call the landlord' },
      });
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });

    it('drops the editor when the panel moves to another day', () => {
      const { rerender } = renderNote();

      fireEvent.click(screen.getByRole('button', { name: calendarNs.notes.add }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'For the tenth' } });

      rerender(
        <CalendarDayNote
          date="2026-06-11"
          onSave={onSave}
          onDelete={onDelete}
          onDirtyChange={onDirtyChange}
        />,
      );

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });

    it('does not adopt a save that lands after the panel has moved on', async () => {
      let resolveSave: ((value: DayNote) => void) | undefined;
      onSave.mockImplementationOnce(
        () => new Promise<DayNote>((resolve) => { resolveSave = resolve; }),
      );

      const { rerender } = renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Tenth' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      rerender(
        <CalendarDayNote
          date="2026-06-11"
          note={note({ date: '2026-06-11', body: 'Eleventh' })}
          onSave={onSave}
          onDelete={onDelete}
          onDirtyChange={onDirtyChange}
        />,
      );

      await act(async () => {
        resolveSave?.(note({ body: 'Tenth' }));
      });

      // The eleventh's own note is what is on screen; the tenth's response went
      // to the list, not to this panel.
      expect(screen.getByText('Eleventh')).toBeInTheDocument();
      expect(screen.queryByText('Tenth')).not.toBeInTheDocument();
      expect(onSave).toHaveBeenCalledWith('2026-06-10', 'Tenth');
    });

    it('keeps the draft and shows the error when a save fails', async () => {
      onSave.mockRejectedValue(new Error('offline'));
      renderNote();

      fireEvent.click(screen.getByRole('button', { name: calendarNs.notes.add }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep me' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      // `getErrorMessage` prefers what the server said and falls back to the
      // catalog line; either way the reason sits beside the form.
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('offline'));
      expect(screen.getByRole('textbox')).toHaveValue('Keep me');
    });
  });
});
