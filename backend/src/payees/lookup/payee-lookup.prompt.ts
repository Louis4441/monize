import { sanitizePromptValue } from "../../common/sanitization.util";

/** Usage-log feature name for every lookup completion. */
export const PAYEE_LOOKUP_FEATURE = "payee_lookup";

/** Searches allowed per lookup. Each one is billed to the user's provider. */
export const PAYEE_LOOKUP_MAX_SEARCHES = 3;

export const PAYEE_LOOKUP_MAX_TOKENS = 600;

/**
 * The instruction every provider gets. Two things it insists on, because the
 * answer is written into the user's data: never guess (null beats a
 * plausible invention), and the official site only (a directory listing is
 * not the payee's website). The JSON-only rule is repeated by the relay
 * prompt builder and enforced by `parseContactJson`, not trusted.
 */
export const PAYEE_LOOKUP_SYSTEM_PROMPT = [
  "You look up the public contact details of a business or organisation the user pays.",
  "Return ONLY a JSON object with exactly these keys: website, address, email, phone, confidence, notes.",
  "Use null for any field you cannot verify. Never guess, infer, or construct a value.",
  "website: the organisation's own official site -- not a directory, review site, social profile, or aggregator.",
  'address: the postal address of the head office or the most general public contact address, written as it would be on an envelope, with each part on its own line separated by \\n: street address, then city with region and postal code, then country. Example: "1373 Avenue du Mont-Royal Est\\nMontreal, Quebec H2J 1Y8\\nCanada".',
  "email and phone: public customer-contact details published by the organisation itself.",
  'confidence: "high", "medium" or "low".',
  "notes: one short sentence on where the details came from.",
  "If the name is ambiguous, generic (for example 'Rent', 'Cash', 'Transfer'), or refers to a private individual, return every field as null with confidence \"low\".",
  `Use at most ${PAYEE_LOOKUP_MAX_SEARCHES} web searches.`,
].join("\n");

export function buildPayeeLookupUserMessage(
  name: string,
  hint?: string,
): string {
  const lines = [`Business name: "${sanitizePromptValue(name)}"`];
  if (hint) {
    lines.push(`Context: ${sanitizePromptValue(hint)}`);
  }
  return lines.join("\n");
}
