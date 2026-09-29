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

/**
 * Turns the `{field: {before, after}}` a preview or a trace holds into one
 * sentence per changed field, using names and never raw ids. An id with no
 * name (deleted since) reads as such instead of leaking the id.
 */
export function useRuleChangeText(): (changes: RuleRunChanges, names: RuleChangeNames) => string[] {
  const t = useTranslations('rules.run.change');
  const format = useFormatter();

  return useCallback(
    (changes, names) => {
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
      if (changes.payeeId) {
        lines.push(
          t('payee', {
            before: one(changes.payeeId.before, names.payee),
            after: one(changes.payeeId.after, names.payee),
          }),
        );
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
    [t, format],
  );
}
