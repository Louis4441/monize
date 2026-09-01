/**
 * Where a notification sends the reader.
 *
 * The server stores `target` as a same-origin path, and this checks it again
 * before anything routes to it: "the server promised" is not a mechanism on the
 * client, and `router.push` with an absolute URL is an open redirect. The check
 * refuses rather than normalises -- `//evil.example` looks like a path and is a
 * different origin, and a `target` we cannot vouch for is better dropped than
 * repaired into something the producer did not mean.
 *
 * The service worker applies the same rule to the `target` in a push payload
 * (`public/sw.js`), by resolving against the app's own origin -- it has a
 * `location` to resolve against and this does not.
 */
export function safeNotificationTarget(
  target: string | null | undefined,
): string | null {
  if (typeof target !== 'string' || target.length === 0) return null;
  // Protocol-relative (`//host`) is a different origin; a scheme (`https:`,
  // `javascript:`) is not a path at all. Both fail the leading-slash rule
  // except `//`, which is why it is named separately.
  if (!target.startsWith('/') || target.startsWith('//')) return null;
  // A backslash is a path separator to some URL parsers, so `/\evil.example`
  // can be read as protocol-relative.
  if (target.startsWith('/\\')) return null;
  return target;
}
