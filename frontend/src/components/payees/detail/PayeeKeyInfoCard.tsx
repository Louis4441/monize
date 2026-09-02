'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { KeyValueList, type KeyValueRow } from '@/components/ui/KeyValueList';
import { payeesApi } from '@/lib/payees';
import { getErrorMessage } from '@/lib/errors';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { externalUrlLabel, toSafeExternalUrl } from '@/lib/external-url';
import { mailtoHref, mapsUrl, telHref } from '@/lib/contact-links';
import { useMapProvider } from '@/hooks/useMapProvider';
import { ContactLookupDialog } from './ContactLookupDialog';
import type { ContactLookupField, PayeeContactSuggestion, PayeeDetail } from '@/types/payee';

interface PayeeKeyInfoCardProps {
  detail: PayeeDetail;
  /**
   * Hierarchical category labels ("Parent: Child"), so the default category
   * reads the same here as it does in the payee list and the filter dropdowns.
   * A bare leaf name is ambiguous -- several parents can own a "Fees".
   */
  categoryLabelMap: Map<string, string>;
  /** Narrow the register to one day (for the largest transaction). */
  onSelectDate: (date: string) => void;
  /** Open an account's detail page (for the overpayment designation). */
  onSelectAccount: (accountId: string) => void;
  /**
   * Called after an on-demand contact lookup wrote to the payee, so the page
   * reloads the detail it is rendering from.
   */
  onContactLookedUp?: () => void | Promise<void>;
}

/**
 * The reference facts about the payee, beside the chart. Rows without a value
 * are dropped by `KeyValueList`, so a fresh payee shows a short list rather
 * than a column of dashes.
 */
export function PayeeKeyInfoCard({
  detail,
  categoryLabelMap,
  onSelectDate,
  onSelectAccount,
  onContactLookedUp,
}: PayeeKeyInfoCardProps) {
  const t = useTranslations('payeeDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const mapProvider = useMapProvider();
  const [lookingUp, setLookingUp] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * The candidates the lookup returned, held open in the confirmation
   * dialogue. The lookup writes nothing (INV-PAYEE-001), so this is the whole
   * of what it produced until the user confirms; more than one entry means the
   * name matched more than one organisation or branch and they pick.
   */
  const [candidates, setCandidates] = useState<PayeeContactSuggestion[]>([]);

  const { payee, stats, largestTransaction, overpaymentForAccounts } = detail;

  // Proposes; it does not save. Each reason gets its own message -- "could not
  // look" must never read as "nothing found" -- and an answer opens the
  // confirmation dialogue rather than writing anything.
  const handleLookup = async () => {
    if (lookingUp) return;
    setLookingUp(true);
    try {
      const result = await payeesApi.lookupContactForPayee(payee.id);
      if (result.reason === 'ok' && result.suggestions.length > 0) {
        setCandidates(result.suggestions);
      } else if (result.reason === 'ok' || result.reason === 'none') {
        toast(t('contactLookup.nothingNew'));
      } else if (result.reason === 'no_provider') {
        toast.error(t('contactLookup.noProvider'));
      } else {
        // 'failed', and any reason a future server adds: never silence one.
        toast.error(result.detail ?? t('contactLookup.failed'));
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('contactLookup.failed')));
    } finally {
      setLookingUp(false);
    }
  };

  // The confirmation is an ordinary payee edit, through the ordinary update
  // endpoint -- which is why it may replace a stored value when the lookup
  // itself may not.
  const applyConfirmed = async (
    values: Partial<Record<ContactLookupField, string>>,
  ) => {
    if (saving) return;
    setSaving(true);
    try {
      await payeesApi.update(payee.id, values);
      setCandidates([]);
      toast.success(
        t('contactLookup.applied', { count: Object.keys(values).length }),
      );
      await onContactLookedUp?.();
    } catch (error) {
      toast.error(getErrorMessage(error, t('contactLookup.applyFailed')));
    } finally {
      setSaving(false);
    }
  };

  const websiteUrl = toSafeExternalUrl(payee.website);
  // Each contact value is turned into a link by its own guard, and a value the
  // guard rejects still renders as text rather than disappearing -- a stored
  // "call the shop" is worth showing even though it cannot be dialled.
  const addressLink = payee.address
    ? mapsUrl({ address: payee.address, provider: mapProvider })
    : null;
  const phoneLink = telHref(payee.phone);
  const emailLink = mailtoHref(payee.email);

  const rows: KeyValueRow[] = [
    {
      key: 'defaultCategory',
      label: t('keyInfo.defaultCategory'),
      // The map wins over the relation's own name: it carries the parent, and
      // the relation only ever holds the leaf.
      value: payee.defaultCategoryId
        ? (categoryLabelMap.get(payee.defaultCategoryId) ??
          payee.defaultCategory?.name ??
          null)
        : null,
    },
    {
      key: 'status',
      label: t('keyInfo.status'),
      value: payee.isActive ? t('keyInfo.active') : t('keyInfo.inactive'),
    },
    {
      key: 'created',
      label: t('keyInfo.created'),
      value: payee.createdAt ? formatDate(payee.createdAt) : null,
    },
    {
      key: 'firstTransaction',
      label: t('keyInfo.firstTransaction'),
      value: stats.firstTransactionDate ? formatDate(stats.firstTransactionDate) : null,
    },
    {
      key: 'lastTransaction',
      label: t('keyInfo.lastTransaction'),
      value: stats.lastTransactionDate ? formatDate(stats.lastTransactionDate) : null,
    },
    {
      key: 'aliases',
      label: t('keyInfo.aliases'),
      value: stats.aliasCount > 0 ? stats.aliasCount.toLocaleString() : null,
    },
    {
      key: 'largestTransaction',
      label: t('keyInfo.largestTransaction'),
      value: largestTransaction ? (
        <button
          type="button"
          onClick={() => onSelectDate(largestTransaction.transactionDate)}
          className="text-right text-blue-600 hover:underline dark:text-blue-400"
        >
          {t('keyInfo.largestValue', {
            amount: formatCurrency(
              Math.abs(largestTransaction.amount),
              largestTransaction.currencyCode,
            ),
            date: formatDate(largestTransaction.transactionDate),
          })}
        </button>
      ) : null,
    },
    {
      key: 'overpaymentFor',
      label: t('keyInfo.overpaymentFor'),
      value:
        overpaymentForAccounts.length > 0 ? (
          <span className="inline-flex flex-wrap justify-end gap-x-2">
            {overpaymentForAccounts.map((account) => (
              <button
                key={account.accountId}
                type="button"
                onClick={() => onSelectAccount(account.accountId)}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {account.accountName}
              </button>
            ))}
          </span>
        ) : null,
    },
    {
      key: 'website',
      label: t('keyInfo.website'),
      value: websiteUrl ? (
        <a
          href={websiteUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={websiteUrl}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          {externalUrlLabel(websiteUrl)}
        </a>
      ) : null,
    },
    {
      key: 'address',
      label: t('keyInfo.address'),
      value: payee.address ? (
        addressLink ? (
          <a
            href={addressLink}
            target="_blank"
            rel="noopener noreferrer"
            className="whitespace-pre-line text-blue-600 hover:underline dark:text-blue-400"
          >
            {payee.address}
          </a>
        ) : (
          <span className="whitespace-pre-line">{payee.address}</span>
        )
      ) : null,
    },
    {
      key: 'phone',
      label: t('keyInfo.phone'),
      value: payee.phone ? (
        phoneLink ? (
          <a
            href={phoneLink}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {payee.phone}
          </a>
        ) : (
          payee.phone
        )
      ) : null,
    },
    {
      key: 'email',
      label: t('keyInfo.email'),
      value: payee.email ? (
        emailLink ? (
          <a
            href={emailLink}
            className="break-all text-blue-600 hover:underline dark:text-blue-400"
          >
            {payee.email}
          </a>
        ) : (
          payee.email
        )
      ) : null,
    },
    {
      key: 'notes',
      label: t('keyInfo.notes'),
      value: payee.notes || null,
    },
  ];

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('keyInfo.title')}
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleLookup}
          disabled={lookingUp}
        >
          {lookingUp ? t('contactLookup.inProgress') : t('contactLookup.button')}
        </Button>
      </div>
      <KeyValueList rows={rows} />
      <ContactLookupDialog
        isOpen={candidates.length > 0}
        payee={payee}
        suggestions={candidates}
        saving={saving}
        onCancel={() => setCandidates([])}
        onConfirm={applyConfirmed}
      />
    </div>
  );
}
