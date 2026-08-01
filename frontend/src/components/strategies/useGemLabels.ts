'use client';

import { useTranslations } from 'next-intl';
import {
  GemAssetRole,
  GemCompositionDimension,
  GemCadence,
  GemHistoryAction,
  GemSignalState,
} from '@/types/gem-strategy';

/**
 * Anything the labels can name: a strategy role's instrument or a holding that
 * fills no role. Both carry a ticker and a name, which is all a label needs.
 */
type GemNamedAsset = { symbol: string | null; name: string | null };

/**
 * Localized labels for the GEM enumerations, resolved in one place so the cards,
 * chart legend and history table always name a role, signal state or cadence
 * the same way.
 */
export function useGemLabels() {
  const t = useTranslations('strategies');

  const roleLabel = (role: GemAssetRole): string =>
    t(`gem.roles.${role}` as Parameters<typeof t>[0]);

  const roleDescription = (role: GemAssetRole): string =>
    t(`gem.roleDescriptions.${role}` as Parameters<typeof t>[0]);

  const stateLabel = (state: GemSignalState): string =>
    t(`gem.states.${state}` as Parameters<typeof t>[0]);

  const actionLabel = (action: GemHistoryAction): string =>
    t(`gem.historyActions.${action}` as Parameters<typeof t>[0]);

  const cadenceLabel = (cadence: GemCadence): string =>
    t(`gem.cadences.${cadence}` as Parameters<typeof t>[0]);

  /** The breakdown a compliance comparison ran on ("country", "asset class"). */
  const dimensionLabel = (
    dimension: GemCompositionDimension | null,
  ): string =>
    dimension === null
      ? t('gem.common.unknown')
      : t(`gem.dimensions.${dimension}` as Parameters<typeof t>[0]);

  /**
   * Ticker for an instrument, falling back to the role name when the role has
   * no ETF assigned yet (so a legend or table cell never renders empty).
   */
  const assetLabel = (asset: GemNamedAsset | null | undefined): string => {
    if (!asset) return t('gem.common.unassigned');
    return asset.symbol ?? t('gem.common.unassigned');
  };

  /** "SPY -- SPDR S&P 500 ETF" when both parts are known, otherwise the ticker. */
  const assetFullLabel = (asset: GemNamedAsset | null | undefined): string => {
    if (!asset?.symbol) return t('gem.common.unassigned');
    return asset.name ? `${asset.name} (${asset.symbol})` : asset.symbol;
  };

  return {
    t,
    roleLabel,
    roleDescription,
    stateLabel,
    actionLabel,
    cadenceLabel,
    dimensionLabel,
    assetLabel,
    assetFullLabel,
  };
}
