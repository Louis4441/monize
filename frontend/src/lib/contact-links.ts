/**
 * Guards for turning a payee's stored contact details into links.
 *
 * Deliberate siblings of `toSafeExternalUrl` in `external-url.ts` rather than a
 * loosening of it: that guard rejects everything but http(s) precisely so a
 * stored `javascript:...` cannot become a runnable `href`, and widening it to
 * admit `tel:` would admit far more than that. These build the one scheme each
 * caller needs, from a value each one has checked itself.
 *
 * Every value is a stored row -- possibly imported, possibly predating any
 * normaliser -- so nothing here trusts its input.
 */

/** Which maps application the viewer's device will open. */
export type MapPlatform = 'ios' | 'android' | 'other';

/**
 * The viewer's platform, for choosing a maps URL scheme.
 *
 * User-agent sniffing is the wrong tool for feature detection, but this is not
 * feature detection: `geo:` and `maps.apple.com` are the handoffs each platform
 * registers a default app for, and nothing in the DOM reports which one the
 * device honours. `other` is the safe answer -- a web map opens everywhere.
 */
export function detectMapPlatform(
  userAgent: string | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.userAgent,
): MapPlatform {
  if (!userAgent) return 'other';
  // iPadOS 13+ reports a desktop Safari UA, distinguishable by touch support.
  if (/iPad|iPhone|iPod/.test(userAgent)) return 'ios';
  if (/Macintosh/.test(userAgent) && typeof navigator !== 'undefined') {
    if (navigator.maxTouchPoints > 1) return 'ios';
  }
  if (/Android/.test(userAgent)) return 'android';
  return 'other';
}

/**
 * A multi-line address as a single query string. Newlines and runs of
 * whitespace collapse to one separator, because a maps query is one line and an
 * encoded newline is just noise in it.
 */
export function addressQuery(address: string): string {
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MapsUrlInput {
  latitude: number | null;
  longitude: number | null;
  address: string;
  /** Injectable for tests; defaults to the current device. */
  platform?: MapPlatform;
}

/**
 * A URL that opens the viewer's default maps application at the payee.
 *
 * Coordinates are preferred where they exist because they are unambiguous --
 * the geocoder already decided which "1 Main Street" this is -- with the
 * address carried alongside as the pin's label. Where the lookup found nothing,
 * the address is still handed over as a search, so a payee with an
 * un-geocodable address remains one tap from directions rather than dead text.
 */
export function mapsUrl({
  latitude,
  longitude,
  address,
  platform,
}: MapsUrlInput): string | null {
  const query = addressQuery(address);
  const hasPoint =
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude);
  if (!query && !hasPoint) return null;

  const target = platform ?? detectMapPlatform();
  const label = encodeURIComponent(query);

  if (target === 'ios') {
    return hasPoint
      ? `https://maps.apple.com/?ll=${latitude},${longitude}${query ? `&q=${label}` : ''}`
      : `https://maps.apple.com/?q=${label}`;
  }
  if (target === 'android') {
    // geo:lat,lng?q=lat,lng(Label) is the documented form that drops a pin at
    // the coordinates rather than searching near them.
    return hasPoint
      ? `geo:${latitude},${longitude}?q=${latitude},${longitude}${query ? `(${label})` : ''}`
      : `geo:0,0?q=${label}`;
  }
  return hasPoint
    ? `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`
    : `https://www.openstreetmap.org/search?query=${label}`;
}

/**
 * A `tel:` href for a stored phone number, or null when it holds no number.
 *
 * Dialable characters only: a stored value may carry spaces, brackets, dashes
 * or a trailing "ext. 12", none of which belong in the href, and one that turns
 * out to hold no digits at all ("call the shop") must not become a link that
 * opens the dialer on nothing.
 */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const leadingPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  return `tel:${leadingPlus ? '+' : ''}${digits}`;
}

/**
 * A `mailto:` href for a stored email address, or null when the value is not
 * one.
 *
 * The shape check is deliberately the same shallow one the form applies rather
 * than a full RFC parse; what it is really for is rejecting a value carrying
 * whitespace or a newline, which is how a header would be injected into the
 * composed message.
 */
export function mailtoHref(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return `mailto:${encodeURIComponent(trimmed)}`;
}
