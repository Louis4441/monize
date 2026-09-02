'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { getErrorMessage } from '@/lib/errors';

interface PayeeContactLookupToggleProps {
  disabled?: boolean;
}

/**
 * Opt-in for the automatic payee contact lookup. The payee form reads the same
 * `payeeContactLookupEnabled` preference from the store, so the switch takes
 * effect on the next payee immediately (optimistic), reverting on save error.
 */
export function PayeeContactLookupToggle({ disabled = false }: PayeeContactLookupToggleProps) {
  const t = useTranslations('settings.aiSettings.payeeLookup');
  const preferences = usePreferencesStore((s) => s.preferences);
  const updatePreferencesStore = usePreferencesStore((s) => s.updatePreferences);
  const enabled = preferences?.payeeContactLookupEnabled ?? false;
  const [saving, setSaving] = useState(false);

  const handleToggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    updatePreferencesStore({ payeeContactLookupEnabled: next });
    try {
      const updated = await userSettingsApi.updatePreferences({
        payeeContactLookupEnabled: next,
      });
      updatePreferencesStore(updated);
      toast.success(next ? t('enabled') : t('disabled'));
    } catch (error) {
      updatePreferencesStore({ payeeContactLookupEnabled: !next });
      toast.error(getErrorMessage(error, t('saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="md" className="mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('title')}
      </h2>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('subtitle')}</p>
        <ToggleSwitch
          checked={enabled}
          onChange={handleToggle}
          disabled={disabled || saving}
          label={t('toggleLabel')}
        />
      </div>
    </Card>
  );
}
