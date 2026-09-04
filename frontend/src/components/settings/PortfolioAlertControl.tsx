'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { NumericInput } from '@/components/ui/NumericInput';
import { notificationPreferencesApi } from '@/lib/notification-preferences';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('PortfolioAlertControl');

const DEFAULT_PERCENT = 5;

/**
 * The opt-in daily portfolio-movement threshold
 * (`docs/specs/portfolio-movement-notifications.md`). Off by default; enabling
 * stores a percentage, disabling clears it (and the producer's baseline).
 *
 * A failed load is not "off": it disables the control and offers a retry, so an
 * outage is never rendered as the feature being unavailable.
 */
export function PortfolioAlertControl() {
  const t = useTranslations('settings.notifications.portfolioAlert');
  const [enabled, setEnabled] = useState(false);
  const [percent, setPercent] = useState<number | undefined>(DEFAULT_PERCENT);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoadFailed(false);
    notificationPreferencesApi
      .getPortfolioAlert()
      .then(({ movePercent }) => {
        setEnabled(movePercent != null);
        if (movePercent != null) setPercent(movePercent);
        setLoaded(true);
      })
      .catch((error) => {
        log.error('Could not load portfolio alert setting', error);
        setLoadFailed(true);
        setLoaded(true);
      });
  };

  useEffect(() => {
    let cancelled = false;
    notificationPreferencesApi
      .getPortfolioAlert()
      .then(({ movePercent }) => {
        if (cancelled) return;
        setEnabled(movePercent != null);
        if (movePercent != null) setPercent(movePercent);
        setLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        log.error('Could not load portfolio alert setting', error);
        setLoadFailed(true);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (nextPercent: number | null) => {
    setBusy(true);
    try {
      await notificationPreferencesApi.setPortfolioAlert(nextPercent);
      toast.success(t('saved'));
    } catch (error) {
      log.error('Could not save portfolio alert setting', error);
      toast.error(getErrorMessage(error, t('saveError')));
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = (next: boolean) => {
    setEnabled(next);
    // Enabling stores the current percent; disabling clears it.
    void save(next ? (percent ?? DEFAULT_PERCENT) : null).catch(() => {
      setEnabled(!next); // revert on failure
    });
  };

  if (!loaded) return null;

  if (loadFailed) {
    return (
      <div className="text-sm text-gray-600 dark:text-gray-300">
        <p>{t('loadError')}</p>
        <Button variant="secondary" size="sm" onClick={load} className="mt-2">
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {t('title')}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {t('description')}
          </p>
        </div>
        <ToggleSwitch
          checked={enabled}
          onChange={handleToggle}
          disabled={busy}
          label={t('enableLabel')}
        />
      </div>
      {enabled && (
        <div className="mt-3 flex items-end gap-2">
          <div>
            <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">
              {t('thresholdLabel')}
            </label>
            <NumericInput
              value={percent}
              onChange={setPercent}
              suffix="%"
              decimalPlaces={2}
              min={0.1}
              max={100}
              className="w-32"
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || percent == null}
            onClick={() => {
              if (percent != null) void save(percent).catch(() => {});
            }}
          >
            {t('save')}
          </Button>
        </div>
      )}
    </div>
  );
}
