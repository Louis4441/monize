'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { KeyValueList, type KeyValueRow } from '@/components/ui/KeyValueList';
import { payeesApi } from '@/lib/payees';
import { getErrorMessage } from '@/lib/errors';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { externalUrlLabel, toSafeExternalUrl } from '@/lib/external-url';
import { mailtoHref, mapsUrl, telHref } from '@/lib/contact-links';
import { useMapProvider } from '@/hooks/useMapProvider';
import {
  CONTACT_LOOKUP_FIELDS,
  type ContactLookupField,
  type PayeeDetail,
} from '@/types/payee';

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
  const [applyingRefinements, setApplyingRefinements] = useState(false);
  /**
   * Fuller values the lookup found for fields the payee already holds -- the
   * branch's full address behind a stored "Toronto". The server does not write
   * these (INV-PAYEE-001: a lookup never overwrites the user's value), so they
   * are shown here and applied only if the user says so, as their own edit.
   */
  const [refinements, setRefinements] = useState<
    Partial<Record<ContactLookupField, string>>
  >({});

  const { payee, stats, largestTransaction, overpaymentForAccounts } = detail;

  // Fills only the contact fields still empty (the server's UPDATE is
  // COALESCE per column); a stored value is replaced only by the user, from
  // the offer below or the edit form. Each reason gets its own message --
  // "could not look" must never read as "nothing found".
  const handleLookup = async () => {
    if (lookingUp) return;
    setLookingUp(true);
    try {
      const result = await payeesApi.lookupContactForPayee(payee.id);
      const offered = result.refinements ?? {};
      const offeredFields = CONTACT_LOOKUP_FIELDS.filter((field) => offered[field]);
      setRefinements(offered);
      if (result.reason === 'ok' && result.filled.length > 0) {
        toast.success(t('contactLookup.filled', { count: result.filled.length }));
      } else if (result.reason === 'ok' || result.reason === 'none') {
        // Only say "nothing new" when there genuinely is nothing: an offer on
        // screen is something new, it just is not something written.
        if (offeredFields.length === 0) toast(t('contactLookup.nothingNew'));
      } else if (result.reason === 'no_provider') {
        toast.error(t('contactLookup.noProvider'));
      } else {
        // 'failed', and any reason a future server adds: never silence one.
        toast.error(result.detail ?? t('contactLookup.failed'));
      }
      if (result.filled.length > 0) {
        await onContactLookedUp?.();
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('contactLookup.failed')));
    } finally {
      setLookingUp(false);
    }
  };

  // The user accepting an offer is an ordinary payee edit, through the
  // ordinary update endpoint -- which is why it may replace a stored value
  // when the lookup itself may not.
  const applyRefinements = async () => {
    if (applyingRefinements) return;
    setApplyingRefinements(true);
    try {
      await payeesApi.update(payee.id, refinements);
      setRefinements({});
      toast.success(t('contactLookup.refinementApplied'));
      await onContactLookedUp?.();
    } catch (error) {
      toast.error(getErrorMessage(error, t('contactLookup.refinementFailed')));
    } finally {
      setApplyingRefinements(false);
    }
  };

  const offeredFields = CONTACT_LOOKUP_FIELDS.filter((field) => refinements[field]);
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
    {
      // Keyed on the source, not the timestamp: an attempt that found nothing
      // stamps the date and leaves the source null, and there is nothing to
      // badge about that.
      key: 'contactLookup',
      label: t('keyInfo.contactLookup'),
      value:
        payee.contactLookupSource && payee.contactLookupAt ? (
          <Badge variant="blue">
            {t('keyInfo.contactLookupValue', {
              date: formatDate(payee.contactLookupAt),
            })}
          </Badge>
        ) : null,
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
      {offeredFields.length > 0 && (
        <div
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-900/30"
          role="status"
        >
          <p className="text-gray-700 dark:text-gray-200">
            {t('contactLookup.refinementIntro')}
          </p>
          <dl className="mt-2 space-y-2">
            {offeredFields.map((field) => (
              <div key={field}>
                <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                  {t(`keyInfo.${field}`)}
                </dt>
                <dd className="whitespace-pre-line text-gray-900 dark:text-gray-100">
                  {refinements[field]}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={applyRefinements}
              disabled={applyingRefinements}
            >
              {t('contactLookup.refinementApply')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRefinements({})}
              disabled={applyingRefinements}
            >
              {t('contactLookup.refinementDismiss')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
