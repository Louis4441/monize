'use client';

import { useTranslations } from 'next-intl';
import { GemAssetRef, GemAssetRole } from '@/types/gem-strategy';
import { GEM_ROLE_COLOURS, GEM_ROLE_ORDER } from '@/lib/gem-strategy-view';
import { GemCard, GemDonut, GemSecurityLink, GemSwatch } from './GemPrimitives';
import { useGemLabels } from './useGemLabels';

interface GemAssetsCardProps {
  assets: GemAssetRef[];
  /** Role the current signal allocates to, highlighted as the GEM winner. */
  winnerRole: GemAssetRole | null;
}

/**
 * The strategy's asset roster: how many roles the strategy uses and which
 * instrument fills each. The colours set here are the ones the chart, the
 * reasoning bars and the history table reuse.
 */
export function GemAssetsCard({ assets, winnerRole }: GemAssetsCardProps) {
  const t = useTranslations('strategies');
  const { roleLabel } = useGemLabels();

  // Roles come from the server; fall back to the canonical order so an
  // incomplete configuration still lists every role it is missing.
  const byRole = new Map(assets.map((asset) => [asset.role, asset]));
  const roles = GEM_ROLE_ORDER.filter((role) => byRole.has(role));
  const displayRoles = roles.length > 0 ? roles : GEM_ROLE_ORDER;

  const segments = displayRoles.map((role) => ({
    key: role,
    percent: 100 / displayRoles.length,
    colour: GEM_ROLE_COLOURS[role],
  }));

  return (
    <GemCard title={t('gem.assets.title')} hint={t('gem.assets.hint')}>
      <div className="flex items-center gap-4">
        <GemDonut
          segments={segments}
          centreValue={displayRoles.length}
          centreLabel={t('gem.assets.centreLabel')}
          ariaLabel={t('gem.assets.donutAriaLabel', { count: displayRoles.length })}
          size={80}
          thickness={10}
        />
        <ul className="min-w-0 flex-1 space-y-1 text-xs">
          {displayRoles.map((role) => {
            const asset = byRole.get(role);
            const isWinner = role === winnerRole;
            return (
              <li key={role} className="flex items-center gap-2">
                <GemSwatch colour={GEM_ROLE_COLOURS[role]} />
                <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
                  {roleLabel(role)}
                  {asset?.symbol ? (
                    <GemSecurityLink
                      securityId={asset.securityId}
                      className="text-gray-500 dark:text-gray-400"
                    >
                      {' '}
                      ({asset.symbol})
                    </GemSecurityLink>
                  ) : (
                    <span className="text-gray-500 dark:text-gray-400">
                      {' '}
                      {t('gem.assets.unmapped')}
                    </span>
                  )}
                </span>
                {isWinner && (
                  <span className="shrink-0 font-medium text-gray-500 dark:text-gray-400">
                    {t('gem.assets.winnerMarker')}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </GemCard>
  );
}
