'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ScheduledInvestmentTransaction } from '@/types/scheduled-investment';
import { FREQUENCY_LABELS } from '@/types/scheduled-transaction';
import { scheduledInvestmentsApi } from '@/lib/scheduled-investments';
import { useDateFormat } from '@/hooks/useDateFormat';
import { getErrorMessage } from '@/lib/errors';

interface Props {
  items: ScheduledInvestmentTransaction[];
  onChanged: () => void;
  onEdit: (item: ScheduledInvestmentTransaction) => void;
}

export function ScheduledInvestmentList({ items, onChanged, onEdit }: Props) {
  const { formatDate } = useDateFormat();
  const [pending, setPending] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] =
    useState<ScheduledInvestmentTransaction | null>(null);

  const handlePost = async (item: ScheduledInvestmentTransaction) => {
    setPending(item.id);
    try {
      await scheduledInvestmentsApi.post(item.id);
      toast.success('Posted');
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, 'An error occurred'));
    } finally {
      setPending(null);
    }
  };

  const handleSkip = async (item: ScheduledInvestmentTransaction) => {
    setPending(item.id);
    try {
      await scheduledInvestmentsApi.skip(item.id);
      toast.success('Skipped to next occurrence');
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, 'An error occurred'));
    } finally {
      setPending(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await scheduledInvestmentsApi.delete(confirmDelete.id);
      toast.success('Deleted');
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, 'An error occurred'));
    } finally {
      setConfirmDelete(null);
    }
  };

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500 dark:text-slate-400">
        No scheduled investments yet. Create one to set up recurring buys, dividends, or DRIP.
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500 dark:text-slate-400">
            <tr>
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Account</th>
              <th className="py-2 pr-4">Action</th>
              <th className="py-2 pr-4">Security</th>
              <th className="py-2 pr-4">Frequency</th>
              <th className="py-2 pr-4">Next due</th>
              <th className="py-2 pr-4">Auto-post</th>
              <th className="py-2 pr-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                className="border-t border-slate-200 dark:border-slate-700"
              >
                <td className="py-2 pr-4">{item.name}</td>
                <td className="py-2 pr-4">{item.account?.name ?? '-'}</td>
                <td className="py-2 pr-4">{item.action}</td>
                <td className="py-2 pr-4">{item.security?.symbol ?? '-'}</td>
                <td className="py-2 pr-4">{FREQUENCY_LABELS[item.frequency]}</td>
                <td className="py-2 pr-4">{formatDate(item.nextDueDate)}</td>
                <td className="py-2 pr-4">{item.autoPost ? 'Yes' : 'No'}</td>
                <td className="py-2 pr-4 text-right space-x-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handlePost(item)}
                    disabled={pending === item.id || !item.isActive}
                  >
                    Post now
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleSkip(item)}
                    disabled={pending === item.id || !item.isActive}
                  >
                    Skip
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onEdit(item)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmDelete(item)}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete !== null}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete scheduled investment"
        message={`Are you sure you want to delete "${confirmDelete?.name}"?`}
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}
