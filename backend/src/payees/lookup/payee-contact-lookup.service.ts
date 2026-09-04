import { Inject, Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { validateUrlIsSafe } from "../../ai/validators/safe-url.validator";
import {
  normalizePhoneNumber,
  phoneRegionFromPreferences,
} from "../../common/phone-number.util";
import type { CountryCode } from "libphonenumber-js/max";
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
  /**
   * Where a suggested number written without a country code belongs. Read from
   * the same preference row as the hint, so the lookup costs no extra query.
   */
  phoneRegion: CountryCode | null;
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
 * does not resolve, and the phone is normalized to the stored E.164 form.
 *
 * The phone belongs here rather than in the sanitizer because it needs the
 * user's region, and the sanitizer is pure. This is the single door for every
 * lookup -- the detail page's button, the form's prefill, the AI/MCP create
 * preview and the background enrichment -- so `ENRICHMENT_UPDATE_SQL`, which
 * writes a suggestion straight into the column without passing a DTO, can
 * never store a number in some other shape.
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
      const vetted = await this.vetCandidate(
        candidate,
        preferences.phoneRegion,
      );
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
   * The per-field checks that need something the pure sanitizer does not have:
   * the network (a website resolved through `validateUrlIsSafe`, which refuses
   * private and loopback addresses and, as a side effect, an invented hostname)
   * and the user's region (a phone normalized to the stored form).
   *
   * A field that does not survive is dropped to null, together with any claim
   * that it refined a value the user holds -- a refinement the user can never
   * be offered is not one. A candidate left with nothing at all is not a
   * candidate.
   */
  private async vetCandidate(
    suggestion: PayeeContactSuggestion,
    phoneRegion: CountryCode | null,
  ): Promise<PayeeContactSuggestion | null> {
    const website =
      suggestion.website && (await validateUrlIsSafe(suggestion.website))
        ? suggestion.website
        : null;
    // A model writes a number in whatever shape the page it read used, so this
    // is where a suggestion becomes storable. Not ok means we could not place
    // it, and a number nobody can dial is worse than an empty field.
    const normalized = suggestion.phone
      ? normalizePhoneNumber(suggestion.phone, phoneRegion)
      : null;
    const phone = normalized?.ok ? normalized.stored : null;
    const dropped = new Set<string>();
    if (website === null) dropped.add("website");
    if (phone === null) dropped.add("phone");
    const checked: PayeeContactSuggestion = {
      ...suggestion,
      website,
      phone,
      refined:
        dropped.size > 0
          ? suggestion.refined.filter((field) => !dropped.has(field))
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
   * The opt-in flag, the two facts about the user that disambiguate a name
   * ("Hydro One" vs "Hydro-Québec") -- their language tag and default currency
   * -- and the region a suggested phone number without a country code belongs
   * to. All are already stored; nothing new is collected.
   */
  private async readPreferences(userId: string): Promise<LookupPreferences> {
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId },
        select: {
          userId: true,
          payeeContactLookupEnabled: true,
          language: true,
          numberFormat: true,
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
      phoneRegion: phoneRegionFromPreferences(prefs),
    };
  }
}
