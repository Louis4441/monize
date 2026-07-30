/**
 * Guards for rendering a stored address as a link.
 *
 * The backend normalises what it stores, but a row is still data: an address
 * that arrived before the normaliser existed, through an import, or from a
 * provider is not guaranteed to be http(s), and a link built from an unchecked
 * string is a link that can run something -- `javascript:...` in an `href`
 * executes on click. Everything that turns a stored address into an anchor
 * goes through here first.
 */

/** The address if it is safe to link to, otherwise null. */
export function toSafeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * The address shortened for display: the hostname without a leading `www.`.
 * Falls back to the raw value, which is still shown, just not prettified.
 */
export function externalUrlLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}
