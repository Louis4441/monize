'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { getErrorMessage } from '@/lib/errors';
import { CALENDAR_DAY_NOTE_MAX_LENGTH } from '@/lib/calendar-day-note';
import type { DayNote } from '@/types/calendar';

interface CalendarDayNoteProps {
  /** The day the panel is showing, `YYYY-MM-DD`. */
  date: string;
  /** The stored note for that day, if there is one. */
  note?: DayNote;
  onSave: (date: string, body: string) => Promise<unknown>;
  onDelete: (date: string) => Promise<unknown>;
  /** Told whenever a draft appears or goes, so the grid can ask before leaving. */
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * The reader's own note on one day: read it, write it, remove it.
 *
 * The calendar's only write path, and it moves no money -- which is why it is
 * the one place here that posts anything at all (design I9). The text is stored
 * and rendered as plain text through `LinkifiedText`, never as markup, so a
 * body that looks like a tag reads as the characters that were typed.
 *
 * The edit captures its date when editing starts (I12): a save that lands after
 * the reader has moved to another day is discarded rather than adopted into
 * whatever is on screen now, and the list refetch is what shows it on the day
 * it belongs to.
 */
export function CalendarDayNote({
  date,
  note,
  onSave,
  onDelete,
  onDirtyChange,
}: CalendarDayNoteProps) {
  const t = useTranslations('calendar');
  const common = useTranslations('common');

  const [editing, setEditing] = useState<{ originDate: string; draft: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // The panel moved to another day while an editor was open: the draft belongs
  // to the day it was opened for, so it does not follow. Handled as information
  // from the previous render rather than an effect.
  const [renderedDate, setRenderedDate] = useState(date);
  if (renderedDate !== date) {
    setRenderedDate(date);
    if (editing !== null && editing.originDate !== date) {
      setEditing(null);
      setError(null);
      onDirtyChange(false);
    }
  }

  const startEditing = useCallback(() => {
    setEditing({ originDate: date, draft: note?.body ?? '' });
    setError(null);
    onDirtyChange(false);
  }, [date, note, onDirtyChange]);

  const cancelEditing = useCallback(() => {
    setEditing(null);
    setError(null);
    onDirtyChange(false);
  }, [onDirtyChange]);

  const handleChange = useCallback(
    (value: string) => {
      setEditing((current) =>
        current === null ? current : { ...current, draft: value },
      );
      onDirtyChange(value !== (note?.body ?? ''));
    },
    [note, onDirtyChange],
  );

  const handleSave = useCallback(async () => {
    if (editing === null) return;
    const { originDate, draft } = editing;
    const body = draft.trim();
    // A blank body is not a delete: removing a note is Delete, which says so.
    if (body.length === 0) return;

    setIsSaving(true);
    setError(null);
    try {
      await onSave(originDate, body);
      onDirtyChange(false);
      // Adopted only while the panel still shows the day the edit was for.
      setEditing((current) => (current?.originDate === originDate ? null : current));
    } catch (caught) {
      // The draft is kept: a failed save is a reason to try again, not a reason
      // to lose what was written.
      setError(getErrorMessage(caught, t('notes.saveFailed')));
    } finally {
      setIsSaving(false);
    }
  }, [editing, onSave, onDirtyChange, t]);

  const handleDelete = useCallback(async () => {
    setConfirmingDelete(false);
    setIsSaving(true);
    setError(null);
    try {
      await onDelete(date);
      setEditing(null);
      onDirtyChange(false);
    } catch (caught) {
      setError(getErrorMessage(caught, t('notes.deleteFailed')));
    } finally {
      setIsSaving(false);
    }
  }, [date, onDelete, onDirtyChange, t]);

  if (editing !== null) {
    return (
      <section className="mb-3 border-b border-gray-200 pb-3 dark:border-gray-700">
        <label
          className="block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
          htmlFor={`day-note-${date}`}
        >
          {t('notes.title')}
        </label>
        <textarea
          id={`day-note-${date}`}
          rows={3}
          value={editing.draft}
          maxLength={CALENDAR_DAY_NOTE_MAX_LENGTH}
          onChange={(event) => handleChange(event.target.value)}
          className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm focus-visible:border-blue-500 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:focus-visible:border-blue-400 dark:focus-visible:ring-blue-400"
        />
        {error !== null && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving || editing.draft.trim().length === 0}
          >
            {common('save')}
          </Button>
          <Button variant="secondary" size="sm" onClick={cancelEditing} disabled={isSaving}>
            {common('cancel')}
          </Button>
          {note && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
              disabled={isSaving}
            >
              {common('delete')}
            </Button>
          )}
        </div>

        <ConfirmDialog
          isOpen={confirmingDelete}
          title={t('notes.deleteTitle')}
          message={t('notes.deleteMessage')}
          confirmLabel={common('delete')}
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      </section>
    );
  }

  return (
    <section
      className="mb-3 border-b border-gray-200 pb-3 dark:border-gray-700"
      aria-label={t('notes.title')}
    >
      <h4 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('notes.title')}
      </h4>
      {note ? (
        <>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-gray-100">
            <LinkifiedText text={note.body} />
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={startEditing}>
              {common('edit')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
              disabled={isSaving}
            >
              {common('delete')}
            </Button>
          </div>
        </>
      ) : (
        <Button variant="secondary" size="sm" className="mt-1" onClick={startEditing}>
          {t('notes.add')}
        </Button>
      )}

      {error !== null && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <ConfirmDialog
        isOpen={confirmingDelete}
        title={t('notes.deleteTitle')}
        message={t('notes.deleteMessage')}
        confirmLabel={common('delete')}
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </section>
  );
}
