/**
 * Shared shapes for the payee contact lookup: the adapter a data source
 * implements, the suggestion it returns, and the outcome the coordinator hands
 * to every caller (form endpoint, background enrichment, AI/MCP preview).
 *
 * The lookup is pluggable. Today the only adapter is the user's configured AI
 * provider (`AiPayeeContactLookupProvider`); a Google Places adapter would
 * implement the same interface and be selected by the module's provider
 * factory from an operator setting -- see `payee-contact-lookup.module.ts`.
 */

import { PayeeLookupContext } from "./lookup-context";

/**
 * Where a looked-up value came from. Persisted in `payees.contact_lookup_source`
 * (the CHECK constraint in migration 173 lists the same values) and mirrored in
 * `frontend/src/types/payee.ts`.
 *
 * - `ai-web-search`: the AI provider ran a real web search and answered from it.
 * - `ai-knowledge`: the AI provider answered from model memory (no search
 *   available, or none ran). Lower trust -- see `sanitizeContactSuggestion`.
 * - `ai-relay`: the user's own agent behind the MCP relay answered. It cannot
 *   report whether it searched, so it is trusted like `ai-knowledge`.
 * - `google-places`: reserved for the Places adapter.
 */
export const CONTACT_LOOKUP_SOURCES = [
  "ai-web-search",
  "ai-knowledge",
  "ai-relay",
  "google-places",
] as const;
export type ContactLookupSource = (typeof CONTACT_LOOKUP_SOURCES)[number];

/** Sources whose answers did not come from a verified web search. */
export const UNVERIFIED_CONTACT_LOOKUP_SOURCES: readonly ContactLookupSource[] =
  ["ai-knowledge", "ai-relay"];

export type ContactLookupConfidence = "high" | "medium" | "low";

export interface PayeeContactLookupInput {
  name: string;
  /** Optional disambiguation, e.g. the user's country. Never persisted. */
  hint?: string;
  /**
   * What the caller already holds about this payee (the form's current
   * values, or the stored row). Used to pick the right organisation and the
   * right branch of it, never written back -- see `PayeeLookupContext`.
   */
  known?: PayeeLookupContext;
}

/** The four contact fields a lookup may fill. */
export const CONTACT_LOOKUP_FIELDS = [
  "website",
  "address",
  "email",
  "phone",
] as const;
export type ContactLookupField = (typeof CONTACT_LOOKUP_FIELDS)[number];

export interface PayeeContactSuggestion {
  website: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  source: ContactLookupSource;
  confidence: ContactLookupConfidence | null;
  /** The model's one-line justification. Shown, never persisted. */
  notes: string | null;
  /**
   * Fields whose value here is a *refinement* of one the caller already had
   * -- the full street address behind a typed "Toronto" -- rather than a fill
   * for an empty field. A refinement is never written by a lookup
   * (INV-PAYEE-001): the form applies it where the user can still see and undo
   * it before saving, and the detail card offers it for the user to apply.
   * A suggested value equal to the known one is not a refinement and is
   * dropped, so it can never be counted as something found.
   */
  refined: ContactLookupField[];
}

export interface PayeeContactLookupProvider {
  /**
   * Resolves `null` when nothing trustworthy was found. May throw; the
   * coordinator catches and classifies.
   */
  lookup(
    userId: string,
    input: PayeeContactLookupInput,
  ): Promise<PayeeContactSuggestion | null>;
}

export const PAYEE_CONTACT_LOOKUP_PROVIDER = Symbol(
  "PAYEE_CONTACT_LOOKUP_PROVIDER",
);

/**
 * What a lookup attempt established. Five states, because the caller has to
 * tell the user different things: `none` is "we looked and there was nothing",
 * `failed` is "we could not look" (and must never be shown as "nothing found"),
 * `no_provider` and `disabled` each name their own fix.
 */
export type ContactLookupReason =
  | "ok"
  | "none"
  | "disabled"
  | "no_provider"
  | "failed";

export type ContactLookupOutcome =
  | { reason: "ok"; suggestion: PayeeContactSuggestion; detail?: undefined }
  | { reason: "none"; suggestion: null; detail?: undefined }
  | { reason: "disabled"; suggestion: null; detail?: undefined }
  | { reason: "no_provider"; suggestion: null; detail?: undefined }
  | {
      reason: "failed";
      suggestion: null;
      /**
       * A message the user can act on, when there is one -- the relay's own
       * "agent is not connected" for instance. Absent for a generic failure.
       */
      detail?: string;
    };

/**
 * Thrown by an adapter that could not look at all -- as opposed to looking
 * and finding nothing, which is a `null` suggestion. The coordinator turns
 * it into the matching `ContactLookupOutcome` without logging it as a
 * defect, because both reasons are states the user can fix.
 */
export class ContactLookupUnavailableError extends Error {
  constructor(
    readonly reason: "no_provider" | "failed",
    readonly detail?: string,
  ) {
    super(detail ?? reason);
    this.name = "ContactLookupUnavailableError";
  }
}
