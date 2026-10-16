'use client';

import { useCallback, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { createLogger } from '@/lib/logger';
import {
  NO_EXCLUSIONS,
  addExclusion,
  hasExclusions,
  selectionFilter,
  type Deselection,
  type SelectionExclusions,
} from '@/lib/receipt-selection';
import type { EmailReceiptBulkFilter } from '@/types/email-receipts';

const logger = createLogger('EmailReceiptsNarrowing');

/**
 * What a person took out of an "every email matching the filter" selection.
 * Each change asks the server how many emails the narrowed filter selects
 * (`bulk/count`), so the number shown is the number a command acts on. A count
 * that fails undoes the change rather than guessing; the newest change wins.
 * `filter` is what every command sends. `reset` clears it with the selection.
 */
export function useReceiptNarrowing(options: {
  base: Pick<EmailReceiptBulkFilter, 'status' | 'domain'>;
  /** The exclusions left no email: the selection is over. */
  onEmpty: () => void;
}) {
  const t = useTranslations('emailReceipts.receipts.bulk');
  const { base, onEmpty } = options;
  const [exclusions, setExclusions] = useState<SelectionExclusions>(NO_EXCLUSIONS);
  const [count, setCount] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const latest = useRef(0);

  const reset = useCallback(() => {
    latest.current += 1;
    setExclusions(NO_EXCLUSIONS);
    setCount(null);
    setPending(false);
  }, []);

  const change = useCallback(
    async (next: SelectionExclusions) => {
      const previous = exclusions;
      const request = ++latest.current;
      setExclusions(next);
      if (!hasExclusions(next)) {
        setCount(null);
        setPending(false);
        return;
      }
      setPending(true);
      try {
        const found = await emailReceiptsApi.receipts.bulkCount(selectionFilter(base, next));
        if (request !== latest.current) return;
        setCount(found);
        if (found === 0) {
          toast(t('noneLeft'));
          onEmpty();
        }
      } catch (error) {
        if (request !== latest.current) return;
        logger.error(error);
        setExclusions(previous);
        toast.error(t('narrowFailed'));
      } finally {
        if (request === latest.current) setPending(false);
      }
    },
    [exclusions, base, onEmpty, t],
  );

  const narrow = useCallback(
    (deselection: Deselection) => {
      const next = addExclusion(exclusions, deselection);
      if (next !== exclusions) void change(next);
    },
    [exclusions, change],
  );

  return {
    exclusions,
    /** The narrowed number; `null` while no exclusion is active or the first count is on its way. */
    count,
    pending,
    active: hasExclusions(exclusions),
    filter: selectionFilter(base, exclusions),
    narrow,
    /** Put back what a chip took out. */
    restore: (next: SelectionExclusions) => void change(next),
    reset,
  };
}
