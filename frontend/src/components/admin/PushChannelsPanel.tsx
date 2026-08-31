'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import type { AdminPushConfig } from '@/lib/admin-notifications';

/**
 * One row per delivery channel this deployment could offer, with the state the
 * server reports rather than a guess.
 *
 * `available` is deliberately three-valued through its own copy: a channel can
 * be on, off by an administrator's decision, or unavailable because the
 * deployment never configured it. Collapsing the last two into "off" would send
 * an operator to flip a switch that is not the problem.
 */
export type ChannelState = 'on' | 'off' | 'unconfigured';

export interface ChannelRow {
  id: string;
  name: string;
  description: string;
  state: ChannelState;
  /** Why it is unavailable, when it is; rendered instead of the state pill. */
  unavailableNote?: string;
  toggle?: {
    label: string;
    checked: boolean;
    onChange: () => void;
    disabled?: boolean;
  };
}

interface PushChannelsPanelProps {
  channels: ChannelRow[];
}

const STATE_CLASS: Record<ChannelState, string> = {
  on: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  off: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  unconfigured:
    'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
};

export function PushChannelsPanel({ channels }: PushChannelsPanelProps) {
  const t = useTranslations('admin.notificationsPage');

  return (
    <div className={TABLE_BODY_CLASS}>
      {channels.map((channel) => (
        <div
          key={channel.id}
          className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-6"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {channel.name}
              </p>
              <span
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${STATE_CLASS[channel.state]}`}
              >
                {t(`channelState.${channel.state}`)}
              </span>
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {channel.description}
            </p>
            {channel.unavailableNote && (
              <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
                {channel.unavailableNote}
              </p>
            )}
          </div>

          {channel.toggle && (
            <button
              type="button"
              role="switch"
              aria-checked={channel.toggle.checked}
              aria-label={channel.toggle.label}
              disabled={channel.toggle.disabled}
              onClick={channel.toggle.onChange}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-900 ${
                channel.toggle.checked
                  ? 'bg-blue-600'
                  : 'bg-gray-200 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  channel.toggle.checked ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

interface VapidIdentityPanelProps {
  config: AdminPushConfig;
  isRotating: boolean;
  onRotate: () => void;
}

/**
 * This instance's push identity.
 *
 * The fingerprint, not the raw key, is what an operator compares between two
 * deployments -- and it is all that is needed to answer "are these the same
 * instance". The private half has no field on any shape the API returns.
 */
export function VapidIdentityPanel({
  config,
  isRotating,
  onRotate,
}: VapidIdentityPanelProps) {
  const t = useTranslations('admin.notificationsPage');

  if (!config.configured) {
    return (
      <div className="px-4 py-4 sm:px-6">
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {t('identity.missingEncryptionKey')}
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-4 sm:px-6">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t('identity.fingerprintLabel')}
          </dt>
          <dd className="mt-1 font-mono text-sm text-gray-900 dark:text-gray-100">
            {config.publicKeyFingerprint}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t('identity.generatedLabel')}
          </dt>
          <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
            {config.generatedAt
              ? new Date(config.generatedAt).toLocaleString()
              : '-'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t('identity.devicesLabel')}
          </dt>
          <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
            {t('identity.deviceCounts', {
              live: config.liveSubscriptionCount,
              disabled: config.disabledSubscriptionCount,
            })}
          </dd>
        </div>
      </dl>

      {config.keyUnreadable && (
        <p className="mt-4 text-sm text-amber-700 dark:text-amber-400">
          {t('identity.keyUnreadable')}
        </p>
      )}

      <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
        {t('identity.rotateDescription')}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={isRotating}
        onClick={onRotate}
      >
        {isRotating ? t('identity.rotatingButton') : t('identity.rotateButton')}
      </Button>
    </div>
  );
}
