/**
 * Normalise a user-entered address to an absolute URL.
 *
 * Forms accept "apple.com" so nobody has to type a scheme, but a stored link
 * needs one: rendered into an anchor without it, the browser resolves it
 * relative to the current page and the link goes nowhere useful.
 *
 * https is the default, and an address that already names its scheme keeps it
 * -- someone who typed `http://` meant it, usually because the host offers
 * nothing else, and silently upgrading them produces a link that fails to
 * connect. Anything other than http/https is rejected by the DTO's `@IsUrl`
 * protocol whitelist before it reaches here, which is what stops a
 * `javascript:` address becoming a link that runs it.
 *
 * The three-way return distinguishes the cases a PATCH has to tell apart:
 * `undefined` (field absent -- leave it alone), `null` (explicitly cleared),
 * and an empty string, which is what a form sends for a field the user emptied
 * and therefore also means "clear it".
 */
export function normalizeWebsite(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
