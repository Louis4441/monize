'use client';

import { useCallback } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { RuleRunChanges } from '@/types/transaction-rule-run';

/** Names for the ids a change mentions; `undefined` means the id is not known. */
export interface RuleChangeNames {
  category: (id: string) => string | undefined;
  payee: (id: string) => string | undefined;
  tag: (id: string) => string | undefined;
}

export interface RuleChangeTextOptions {
  /** The change was written (the history), not planned (a preview): a created payee reads in the past tense. */
  done?: boolean;
}

/**
 * Turns the `{field: {before, after}}` a preview or a trace holds into one
 * sentence per changed field, using names and never raw ids. An id with no
 * name (deleted since) reads as such instead of leaking the id. A payee named
 * by text has no id until it exists: it reads by name, with a note when the
 * rule creates it. A description reads in quotes.
 */
export function useRuleChangeText(): (
  changes: RuleRunChanges,
  names: RuleChangeNames,
  options?: RuleChangeTextOptions,
) => string[] {
  const t = useTranslations('rules.run.change');
  const tw = useTranslations('rules.words');
  const format = useFormatter();

  return useCallback(
    (changes, names, options = {}) => {
      const lines: string[] = [];
      const one = (id: string | null, resolve: (id: string) => string | undefined) =>
        id === null ? t('none') : (resolve(id) ?? t('unknown'));

      if (changes.categoryId) {
        lines.push(
          t('category', {
            before: one(changes.categoryId.before, names.category),
            after: one(changes.categoryId.after, names.category),
          }),
        );
      }
      const creation = changes.payeeCreated === true ? (changes.payeeName?.after ?? null) : null;
      if (creation) {
        // One line: the payee row P becomes the payee the rule creates, never "none".
        const text = (name: string | null) => (name === null || name === '' ? t('none') : name);
        const before = changes.payeeId
          ? one(changes.payeeId.before, names.payee)
          : text(changes.payeeName?.before ?? null);
        lines.push(t('payeeNew', { before, name: creation }));
      } else if (changes.payeeId) {
        lines.push(
          t('payee', {
            before: one(changes.payeeId.before, names.payee),
            after: one(changes.payeeId.after, names.payee),
          }),
        );
      }
      if (changes.payeeName && !changes.payeeId && !creation) {
        const text = (name: string | null) => (name === null || name === '' ? t('none') : name);
        lines.push(t('payee', { before: text(changes.payeeName.before), after: text(changes.payeeName.after) }));
      }
      if (changes.payeeCreated === true && changes.payeeName?.after) {
        lines.push(t('payeeCreated', { done: options.done === true ? 'yes' : 'no', name: changes.payeeName.after }));
      }
      if (changes.description) {
        const text = (value: string | null) => (value === null || value.trim() === '' ? t('none') : tw('text', { value }));
        lines.push(t('description', { before: text(changes.description.before), after: text(changes.description.after) }));
      }
      if (changes.tagIds) {
        const before = new Set(changes.tagIds.before);
        const after = new Set(changes.tagIds.after);
        const list = (ids: string[]) =>
          format.list(
            ids.map((id) => names.tag(id) ?? t('unknown')),
            { type: 'conjunction' },
          );
        const added = changes.tagIds.after.filter((id) => !before.has(id));
        const removed = changes.tagIds.before.filter((id) => !after.has(id));
        if (added.length > 0) lines.push(t('tagsAdded', { tags: list(added) }));
        if (removed.length > 0) lines.push(t('tagsRemoved', { tags: list(removed) }));
      }
      return lines;
    },
    [t, tw, format],
  );
}
