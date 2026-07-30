'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/format';
import { MnyImportResult } from '@/lib/import-mny';

interface MnyVerificationReportProps {
  result: MnyImportResult;
  /** Base currency of the file, used to format the report's money columns. */
  currencyCode: string;
  filename: string;
  onDone: () => void;
}

/**
 * What was imported, and whether it reconciles.
 *
 * The banner is the point of this screen. Both PR #192 testers said the same
 * thing: a 56-account, 30-year migration is impossible to trust without being
 * told, per account, that the balance Monize now holds equals the balance
 * computed from the Money file. "All 56 accounts match" is the answer; the table
 * is there for the cases where it is not.
 *
 * The JSON download exists for the same reason -- a user chasing a discrepancy
 * needs the numbers, not a screenshot.
 */
export function MnyVerificationReport({
  result,
  currencyCode,
  filename,
  onDone,
}: MnyVerificationReportProps) {
  const t = useTranslations('import');

  const mismatches = result.verification.filter((line) => !line.matches);
  const allMatch = mismatches.length === 0 && result.verification.length > 0;

  const downloadReport = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename.replace(/\.mny$/i, '')}-import-report.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div
        className={`rounded-lg border p-4 mb-6 ${
          allMatch
            ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
            : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
        }`}
      >
        <h2
          className={`text-lg font-semibold ${
            allMatch
              ? 'text-green-800 dark:text-green-300'
              : 'text-amber-800 dark:text-amber-300'
          }`}
        >
          {t('mnyComplete.heading')}
        </h2>
        <p
          className={`mt-1 text-sm ${
            allMatch
              ? 'text-green-700 dark:text-green-300'
              : 'text-amber-800 dark:text-amber-300'
          }`}
        >
          {allMatch
            ? t('mnyComplete.allMatch', { count: result.verification.length })
            : t('mnyComplete.someDiffer', { count: mismatches.length })}
        </p>
      </div>

      {/* What was created */}
      <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile
          label={t('mnyComplete.counts.accounts')}
          value={result.accountsCreated}
        />
        <Tile
          label={t('mnyComplete.counts.transactions')}
          value={result.transactionsCreated}
        />
        <Tile
          label={t('mnyComplete.counts.transfers')}
          value={result.transfersLinked}
        />
        <Tile
          label={t('mnyComplete.counts.splits')}
          value={result.splitsCreated}
        />
        <Tile
          label={t('mnyComplete.counts.payees')}
          value={result.payeesCreated}
        />
        <Tile
          label={t('mnyComplete.counts.categories')}
          value={result.categoriesCreated}
        />
      </div>

      {result.existingDataRemoved && (
        <p className="mb-6 text-sm text-muted-foreground">
          {t('mnyComplete.existingDataRemoved')}
        </p>
      )}

      {/* Per-account reconciliation */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-foreground mb-2">
          {t('mnyComplete.verificationHeading')}
        </h3>
        <div className="bg-card border border-border rounded-lg overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">
                  {t('mnyComplete.table.account')}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t('mnyComplete.table.transactions')}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t('mnyComplete.table.expected')}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t('mnyComplete.table.imported')}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t('mnyComplete.table.delta')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {result.verification.map((line) => (
                <tr key={line.accountName}>
                  <td className="px-3 py-2">
                    <span className="text-foreground">{line.accountName}</span>
                    {!line.matches && (
                      <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 rounded">
                        {t('mnyComplete.table.check')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {line.transactionCount}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {formatCurrency(line.expectedBalance, currencyCode)}
                  </td>
                  <td className="px-3 py-2 text-right text-foreground">
                    {formatCurrency(line.importedBalance, currencyCode)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-medium ${
                      line.matches
                        ? 'text-green-700 dark:text-green-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {formatCurrency(line.delta, currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-foreground mb-2">
            {t('mnyComplete.warningsHeading')}
          </h3>
          <ul className="bg-card border border-border rounded-lg divide-y divide-border text-sm">
            {result.warnings.map((warning) => (
              <li key={warning.code} className="px-4 py-2">
                <span className="text-foreground">
                  {t(`mnyWarnings.${warning.code}`, { count: warning.count })}
                </span>
                {warning.samples.length > 0 && (
                  <span className="block text-xs text-muted-foreground">
                    {warning.samples.join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={downloadReport}>
          {t('mnyComplete.downloadReport')}
        </Button>
        <Button onClick={onDone}>{t('mnyComplete.done')}</Button>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}
