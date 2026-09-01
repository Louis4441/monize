'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { MapPinIcon } from '@heroicons/react/24/solid';
import { Card } from '@/components/ui/Card';
import { mapsUrl } from '@/lib/contact-links';
import {
  isDrawablePoint,
  MAP_TILE_ZOOM,
  TILE_SIZE,
  tilesAround,
} from '@/lib/map-tile-math';
import { mapTileUrl, payeesApi } from '@/lib/payees';
import type { Payee } from '@/types/payee';

interface PayeeLocationMapProps {
  payee: Payee;
  /** Reload the payee after a successful retry, so the map appears. */
  onRefreshed?: () => void;
}

/**
 * Where the payee is, as a static map.
 *
 * Three states, because "no address", "an address we could not locate" and "an
 * address we located" are three different facts and only the last has a point
 * to draw. Collapsing the middle one into the first would leave a user who
 * typed an address wondering why no map appeared; it is the one state where
 * retrying does anything, so it is the one that offers a retry.
 *
 * The tiles come from our own backend (`mapTileUrl`), never a tile provider
 * directly -- the same rule the payee's brand icon follows, and a hard
 * requirement under a nonce-based CSP that blocks third-party images.
 */
export function PayeeLocationMap({ payee, onRefreshed }: PayeeLocationMapProps) {
  const t = useTranslations('payeeDetail');
  const [refreshing, setRefreshing] = useState(false);

  // Nothing to show, and nothing to retry.
  if (!payee.address) return null;

  const href = mapsUrl({
    latitude: payee.latitude,
    longitude: payee.longitude,
    address: payee.address,
  });

  const handleRetry = async () => {
    setRefreshing(true);
    try {
      await payeesApi.refreshGeocode(payee.id);
      onRefreshed?.();
    } catch {
      toast.error(t('map.retryFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  if (!isDrawablePoint(payee)) {
    return (
      <Card padding="md">
        <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('map.title')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('map.notLocated')}
        </p>
        {/* Only offered once a lookup has actually run and come back empty --
            `geocodedAt` is what distinguishes that from never having tried. */}
        {payee.geocodedAt ? (
          <button
            type="button"
            onClick={handleRetry}
            disabled={refreshing}
            className="mt-2 text-sm text-blue-600 hover:underline focus-visible:outline-2 disabled:opacity-50 dark:text-blue-400"
          >
            {refreshing ? t('map.retrying') : t('map.retryLookup')}
          </button>
        ) : null}
      </Card>
    );
  }

  const tiles = tilesAround(payee.latitude, payee.longitude, MAP_TILE_ZOOM);

  return (
    <Card padding="md">
      <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('map.title')}
      </h3>
      {/* The map surface and the attribution are siblings, never nested: a
          link inside a link is invalid and the convention guard rejects it. */}
      <div className="relative h-48 overflow-hidden rounded-md bg-gray-100 dark:bg-gray-700">
        <a
          href={href ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('map.openInMaps')}
          className="absolute inset-0 block focus-visible:outline-2"
        >
          {/* Tiles are positioned relative to the marker point, which sits at
              the centre of the frame -- so the payee is always centred without
              measuring the container. */}
          <span className="absolute left-1/2 top-1/2 block">
            {tiles.map((tile) => (
              /* eslint-disable-next-line @next/next/no-img-element -- fixed 256px tiles from our own cached API; next/image would re-optimize bytes we already control and size */
              <img
                key={`${tile.z}/${tile.x}/${tile.y}`}
                src={mapTileUrl(tile.z, tile.x, tile.y)}
                alt=""
                aria-hidden="true"
                draggable={false}
                width={TILE_SIZE}
                height={TILE_SIZE}
                // A tile the backend could not fetch leaves background rather
                // than a broken-image icon.
                onError={(event) => {
                  event.currentTarget.style.visibility = 'hidden';
                }}
                className="absolute max-w-none"
                style={{ left: tile.left, top: tile.top }}
              />
            ))}
            <MapPinIcon
              className="absolute h-8 w-8 -translate-x-1/2 -translate-y-full text-red-600 drop-shadow"
              aria-hidden="true"
            />
          </span>
        </a>
        {/* Required by the OpenStreetMap tile licence wherever its tiles are
            shown. */}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-0 right-0 bg-white/80 px-1 text-[10px] text-gray-700 hover:underline focus-visible:outline-2 dark:bg-gray-900/80 dark:text-gray-300"
        >
          {t('map.attribution')}
        </a>
      </div>
    </Card>
  );
}
