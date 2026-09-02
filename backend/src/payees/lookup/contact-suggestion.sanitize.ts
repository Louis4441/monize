import { isEmail } from "class-validator";
import { normalizeWebsite } from "../../common/normalize-website";
import { sanitizePromptValue, stripHtml } from "../../common/sanitization.util";
import {
  ContactLookupConfidence,
  ContactLookupSource,
  PayeeContactSuggestion,
  UNVERIFIED_CONTACT_LOOKUP_SOURCES,
} from "./payee-contact-lookup.types";

/**
 * Caps match `CreatePayeeDto`, not the columns: a suggestion the form cannot
 * submit is not a suggestion. (`address` is TEXT in the table but 500 in the
 * DTO; `website` 2048, `email` 255, `phone` 50 are the same in both.)
 */
export const CONTACT_FIELD_MAX_LENGTH = {
  website: 2048,
  address: 500,
  email: 255,
  phone: 50,
} as const;

const NOTES_MAX_LENGTH = 300;

/** Strings a model writes when it means "nothing". */
const EMPTY_SENTINELS = new Set([
  "",
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "not available",
  "not found",
  "not applicable",
  "-",
  "--",
]);

/** A phone number with fewer digits than this is a fragment, not a number. */
const MIN_PHONE_DIGITS = 7;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return EMPTY_SENTINELS.has(trimmed.toLowerCase()) ? null : trimmed;
}

function sanitizeWebsite(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const normalized = normalizeWebsite(raw);
  if (!normalized || normalized.length > CONTACT_FIELD_MAX_LENGTH.website) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // A hostname with no dot is a bare word ("acme"), never a public site.
  if (!url.hostname.includes(".")) return null;
  return normalized;
}

function sanitizeEmail(value: unknown): string | null {
  const raw = text(value);
  if (!raw || raw.length > CONTACT_FIELD_MAX_LENGTH.email) return null;
  return isEmail(raw) ? raw : null;
}

function sanitizePhone(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const cleaned = (stripHtml(raw) ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length > CONTACT_FIELD_MAX_LENGTH.phone) return null;
  const digits = cleaned.replace(/\D/g, "").length;
  return digits >= MIN_PHONE_DIGITS ? cleaned : null;
}

/** An address longer than this many lines is prose, not an envelope. */
const MAX_ADDRESS_LINES = 6;

/**
 * An address keeps its line breaks: the prompt asks for envelope lines, the
 * form's textarea and the detail card (`whitespace-pre-line`) both show them,
 * and a maps link takes the whole string either way. Spaces collapse only
 * *within* a line; blank lines are dropped.
 */
function sanitizeAddress(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const lines = (stripHtml(raw) ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_ADDRESS_LINES) return null;
  const cleaned = lines.join("\n");
  return cleaned.length > CONTACT_FIELD_MAX_LENGTH.address ? null : cleaned;
}

function sanitizeConfidence(value: unknown): ContactLookupConfidence | null {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : null;
}

function sanitizeNotes(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const cleaned = sanitizePromptValue(stripHtml(raw) ?? "");
  return cleaned ? cleaned.slice(0, NOTES_MAX_LENGTH) : null;
}

/**
 * Turn whatever a data source returned into a suggestion the payee form and
 * the enrichment UPDATE can take verbatim -- or `null` when nothing survives.
 *
 * Two kinds of rule. Shape rules apply to every source: each field is a
 * string within the DTO's cap and format (a URL with a dotted host, an
 * address that is at least an email, a phone with enough digits), sentinel
 * strings mean absent, and HTML angle brackets are stripped as `@SanitizeHtml`
 * would. Trust rules apply by source: an answer that did not come from a
 * verified web search (`ai-knowledge`, `ai-relay`) keeps its address and
 * phone only at high confidence, because model memory is worst at exactly
 * those two -- a plausible street address for the wrong branch is worse than
 * an empty field.
 */
export function sanitizeContactSuggestion(
  raw: unknown,
  source: ContactLookupSource,
): PayeeContactSuggestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const confidence = sanitizeConfidence(record.confidence);
  const unverified = UNVERIFIED_CONTACT_LOOKUP_SOURCES.includes(source);
  const keepLocalDetails = !unverified || confidence === "high";

  const suggestion: PayeeContactSuggestion = {
    website: sanitizeWebsite(record.website),
    address: keepLocalDetails ? sanitizeAddress(record.address) : null,
    email: sanitizeEmail(record.email),
    phone: keepLocalDetails ? sanitizePhone(record.phone) : null,
    source,
    confidence,
    notes: sanitizeNotes(record.notes),
  };

  const hasAny =
    suggestion.website !== null ||
    suggestion.address !== null ||
    suggestion.email !== null ||
    suggestion.phone !== null;
  return hasAny ? suggestion : null;
}

/**
 * Pull the JSON object out of a model answer that may wrap it in prose or a
 * code fence. Returns `null` for anything that is not one JSON object.
 */
export function parseContactJson(
  content: string,
): Record<string, unknown> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
