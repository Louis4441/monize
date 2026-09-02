import { Inject, Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { validateUrlIsSafe } from "../../ai/validators/safe-url.validator";
import { UserPreference } from "../../users/entities/user-preference.entity";
import {
  ContactLookupOutcome,
  ContactLookupSuggestions,
  ContactLookupUnavailableError,
  PAYEE_CONTACT_LOOKUP_PROVIDER,
  PayeeContactLookupInput,
  PayeeContactLookupProvider,
  PayeeContactSuggestion,
} from "./payee-contact-lookup.types";

export interface ContactLookupOptions {
  /**
   * Skip the opt-in preference. Only for a lookup the user just asked for by
   * name -- the "Look up" buttons -- where the click is the consent. The
   * automatic paths (form prefill, background enrichment, AI/MCP preview)
   * never set it.
   */
  ignorePreference?: boolean;
}

interface LookupPreferences {
  enabled: boolean;
  hint: string | undefined;
}

/**
 * The one door to a contact lookup. Every caller gets a `ContactLookupOutcome`
 * and never an exception: a lookup is best-effort everywhere it runs, and a
 * failure has to be *named* rather than thrown, because the caller must tell
 * the user "could not look" and never "nothing found" for it.
 *
 * Gate, then adapter, then two checks on the answer: the sanitizer (shape and
 * per-source trust, `sanitizeContactSuggestion`) already ran in the adapter;
 * here the website is additionally resolved through `validateUrlIsSafe`,
 * which refuses private and loopback addresses (SSRF, since the favicon
 * fetcher will visit it) and, as a side effect, an invented hostname that
 * does not resolve.
 */
@Injectable()
export class PayeeContactLookupService {
  private readonly logger = new Logger(PayeeContactLookupService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(PAYEE_CONTACT_LOOKUP_PROVIDER)
    private readonly provider: PayeeContactLookupProvider,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    return (await this.readPreferences(userId)).enabled;
  }

  async lookup(
    userId: string,
    input: PayeeContactLookupInput,
    options: ContactLookupOptions = {},
  ): Promise<ContactLookupOutcome> {
    const preferences = await this.readPreferences(userId);
    if (!preferences.enabled && !options.ignorePreference) {
      return { reason: "disabled", suggestions: [] };
    }

    let candidates: PayeeContactSuggestion[];
    try {
      candidates = await this.provider.lookup(userId, {
        name: input.name,
        hint: input.hint ?? preferences.hint,
        known: input.known,
      });
    } catch (error) {
      if (error instanceof ContactLookupUnavailableError) {
        return error.reason === "no_provider"
          ? { reason: "no_provider", suggestions: [] }
          : { reason: "failed", suggestions: [], detail: error.detail };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Contact lookup failed for payee "${input.name}": ${message}`,
      );
      return { reason: "failed", suggestions: [] };
    }

    const checked: PayeeContactSuggestion[] = [];
    for (const candidate of candidates) {
      const vetted = await this.vetWebsite(candidate);
      if (vetted) checked.push(vetted);
    }
    const [best, ...rest] = checked;
    if (!best) {
      return { reason: "none", suggestions: [] };
    }
    const suggestions: ContactLookupSuggestions = [best, ...rest];
    return { reason: "ok", suggestions };
  }

  /**
   * Resolve the candidate's website through `validateUrlIsSafe` and drop it
   * when it does not survive, along with any claim that it refined one the
   * user holds. A candidate left with nothing at all is not a candidate.
   */
  private async vetWebsite(
    suggestion: PayeeContactSuggestion,
  ): Promise<PayeeContactSuggestion | null> {
    const website =
      suggestion.website && (await validateUrlIsSafe(suggestion.website))
        ? suggestion.website
        : null;
    const checked: PayeeContactSuggestion = {
      ...suggestion,
      website,
      refined:
        website === null
          ? suggestion.refined.filter((field) => field !== "website")
          : suggestion.refined,
    };
    const hasAny =
      checked.website !== null ||
      checked.address !== null ||
      checked.email !== null ||
      checked.phone !== null;
    return hasAny ? checked : null;
  }

  /**
   * The opt-in flag, plus the two facts about the user that disambiguate a
   * name ("Hydro One" vs "Hydro-Québec"): their language tag and default
   * currency. Both are already stored; nothing new is collected.
   */
  private async readPreferences(userId: string): Promise<LookupPreferences> {
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId },
        select: {
          userId: true,
          payeeContactLookupEnabled: true,
          language: true,
          defaultCurrency: true,
        },
      }),
    );
    const parts: string[] = [];
    if (prefs?.language) parts.push(`the user's locale is ${prefs.language}`);
    if (prefs?.defaultCurrency) {
      parts.push(`their default currency is ${prefs.defaultCurrency}`);
    }
    return {
      enabled: prefs?.payeeContactLookupEnabled === true,
      hint: parts.length > 0 ? parts.join("; ") : undefined,
    };
  }
}
