import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { tr } from "../../i18n/translate";
import { withScopedDb } from "../../common/db/scoped-db";
import { withUserContext } from "../../common/db/with-context";
import { returnedRows } from "../../common/db/query-result";
import { ActionHistoryService } from "../../action-history/action-history.service";
import { FaviconService } from "../../common/favicon/favicon.service";
import { brandLogoColumns } from "../../common/favicon/brand-logo.columns";
import { Payee } from "../entities/payee.entity";
import { LookupQueue } from "./lookup-queue";
import { buildLookupContext, PayeeLookupContext } from "./lookup-context";
import { PayeeContactLookupService } from "./payee-contact-lookup.service";
import {
  CONTACT_LOOKUP_FIELDS,
  ContactLookupField,
  ContactLookupOutcome,
  ContactLookupReason,
} from "./payee-contact-lookup.types";

/** Background lookups in flight per replica, and how many may wait. */
const BACKGROUND_CONCURRENCY = 2;
const BACKGROUND_MAX_PENDING = 50;

/**
 * The one statement that writes looked-up contact details, and the whole
 * of two invariants:
 *
 * - **A lookup never overwrites a value the user entered** (INV-PAYEE-001):
 *   every contact column is `COALESCE(column, $n)`, so a value already there
 *   -- typed before the lookup answered, or by anyone in between -- wins.
 * - **The automatic path runs at most once per payee**: the first-attempt
 *   form adds `contact_lookup_at IS NULL`, so a second replica, a retried
 *   request or a re-dispatch affects zero rows. The user-initiated re-run
 *   omits that predicate and still only fills gaps.
 *
 * `contact_lookup_at` stamps the attempt; `contact_lookup_source` moves only
 * when this write actually set a field (the `CASE` reads the columns' values
 * *before* the SET, which is what a column reference means on the right-hand
 * side of an UPDATE), and otherwise keeps whatever provenance the row had.
 */
function enrichmentUpdateSql(firstAttemptOnly: boolean): string {
  return `
    UPDATE payees
       SET website = COALESCE(website, $3),
           address = COALESCE(address, $4),
           email = COALESCE(email, $5),
           phone = COALESCE(phone, $6),
           contact_lookup_at = NOW(),
           contact_lookup_source = CASE
             WHEN (website IS NULL AND $3::text IS NOT NULL)
               OR (address IS NULL AND $4::text IS NOT NULL)
               OR (email IS NULL AND $5::text IS NOT NULL)
               OR (phone IS NULL AND $6::text IS NOT NULL)
             THEN $7::varchar
             ELSE contact_lookup_source
           END
     WHERE id = $1 AND user_id = $2
       ${firstAttemptOnly ? "AND contact_lookup_at IS NULL" : ""}
    RETURNING website, address, email, phone, contact_lookup_source`;
}

export interface ContactEnrichmentResult {
  reason: ContactLookupReason;
  /** The lookup's actionable message, when it had one (relay offline...). */
  detail?: string;
  /** The contact fields this run wrote. Empty when nothing was written. */
  filled: ContactLookupField[];
  /**
   * Fuller values found for fields the payee already holds -- the full street
   * address behind a stored "Toronto". Never written here (INV-PAYEE-001):
   * they are offered to the user, who applies them as their own edit. Absent
   * when there are none.
   */
  refinements?: Partial<Record<ContactLookupField, string>>;
}

type ContactColumns = Record<ContactLookupField, string | null>;

interface EnrichmentRow extends ContactColumns {
  contact_lookup_source: string | null;
}

/**
 * The fuller values worth offering the user: a field the lookup refined that
 * the row still holds a value for. Nothing here is ever written -- the
 * enrichment UPDATE is COALESCE per column (INV-PAYEE-001) -- so this is the
 * only way a refinement reaches anyone, and a field the write filled is a
 * fill rather than a refinement and is reported as such.
 */
function collectRefinements(
  outcome: ContactLookupOutcome,
  before?: ContactColumns,
): Partial<Record<ContactLookupField, string>> | undefined {
  const suggestion = outcome.suggestion;
  if (!suggestion || !before) return undefined;
  const refinements: Partial<Record<ContactLookupField, string>> = {};
  for (const field of suggestion.refined) {
    const value = suggestion[field];
    if (value && before[field] != null) refinements[field] = value;
  }
  return Object.keys(refinements).length > 0 ? refinements : undefined;
}

/**
 * Applies a contact lookup's answer to a payee row: the background
 * enrichment after a name-only create, and the on-demand re-run from the
 * detail page. Both end in {@link enrichmentUpdateSql}.
 */
@Injectable()
export class PayeeContactEnrichmentService {
  private readonly logger = new Logger(PayeeContactEnrichmentService.name);
  /** Payee ids this replica is already looking up; a re-dispatch is a no-op. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly queue = new LookupQueue(
    BACKGROUND_CONCURRENCY,
    BACKGROUND_MAX_PENDING,
  );

  constructor(
    private readonly dataSource: DataSource,
    private readonly lookupService: PayeeContactLookupService,
    private readonly actionHistoryService: ActionHistoryService,
    private readonly faviconService: FaviconService,
  ) {}

  /**
   * Fire-and-forget, for `PayeesService.create` once its transaction has
   * committed. Runs under the user's own context because the request that
   * created the payee has already returned; nothing here can reach the
   * caller, so a failure is logged and nothing else.
   */
  dispatchAfterCreate(
    userId: string,
    payeeId: string,
    name: string,
    known?: PayeeLookupContext,
  ): void {
    if (this.inFlight.has(payeeId)) return;
    const run = this.queue
      .run(`payee ${payeeId}`, () =>
        withUserContext(userId, () =>
          this.enrichAfterCreate(userId, payeeId, name, known),
        ),
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Background contact lookup for payee "${name}" (${payeeId}) failed: ${message}`,
        );
      })
      .finally(() => {
        this.inFlight.delete(payeeId);
      });
    this.inFlight.set(payeeId, run);
  }

  /** The automatic path: preference-gated, first attempt only. */
  async enrichAfterCreate(
    userId: string,
    payeeId: string,
    name: string,
    known?: PayeeLookupContext,
  ): Promise<ContactEnrichmentResult> {
    const outcome = await this.lookupService.lookup(userId, { name, known });
    return this.apply(userId, payeeId, name, outcome, true);
  }

  /**
   * The user asked for this payee to be looked up. Fills empty fields only,
   * whether or not an earlier attempt already stamped the row, and whether
   * or not the automatic lookup is enabled -- the click is the consent. A
   * fuller value for a field that is already filled comes back as a
   * refinement for the user to apply, never as a write.
   */
  async rerun(
    userId: string,
    payeeId: string,
  ): Promise<ContactEnrichmentResult & { payee: Payee }> {
    const payee = await this.loadPayee(userId, payeeId);
    const outcome = await this.lookupService.lookup(
      userId,
      // Everything the row already holds goes in as context: the lookup has to
      // answer for this organisation in this place, not for a same-named one
      // on another continent.
      { name: payee.name, known: buildLookupContext(payee) },
      { ignorePreference: true },
    );
    const result = await this.apply(
      userId,
      payeeId,
      payee.name,
      outcome,
      false,
    );
    return { ...result, payee: await this.loadPayee(userId, payeeId) };
  }

  private async loadPayee(userId: string, payeeId: string): Promise<Payee> {
    const payee = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Payee).findOne({
        where: { id: payeeId, userId },
        relations: ["defaultCategory"],
      }),
    );
    if (!payee) {
      throw new NotFoundException(
        tr("errors.payees.notFound", `Payee with ID ${payeeId} not found`, {
          id: payeeId,
        }),
      );
    }
    return payee;
  }

  private async apply(
    userId: string,
    payeeId: string,
    name: string,
    outcome: ContactLookupOutcome,
    firstAttemptOnly: boolean,
  ): Promise<ContactEnrichmentResult> {
    // Only an answer stamps the row. "Could not look" (provider offline, no
    // provider, feature off) leaves contact_lookup_at NULL so a later
    // attempt is still possible.
    if (outcome.reason !== "ok" && outcome.reason !== "none") {
      return { reason: outcome.reason, detail: outcome.detail, filled: [] };
    }
    const suggestion = outcome.suggestion;
    const values: ContactColumns = {
      website: suggestion?.website ?? null,
      address: suggestion?.address ?? null,
      email: suggestion?.email ?? null,
      phone: suggestion?.phone ?? null,
    };

    const written = await withScopedDb(this.dataSource, (m) =>
      this.write(
        m,
        userId,
        payeeId,
        values,
        suggestion?.source ?? null,
        firstAttemptOnly,
      ),
    );
    // Decided against the row as it stood at the write, not against the
    // context the lookup was given: the value may have been edited in between,
    // and a refinement of something that is no longer there is not one.
    const refinements = collectRefinements(outcome, written?.before);
    const offered = refinements ? { refinements } : {};
    if (!written || written.filled.length === 0) {
      return { reason: outcome.reason, filled: [], ...offered };
    }

    this.actionHistoryService.record(userId, {
      entityType: "payee",
      entityId: payeeId,
      action: "update",
      beforeData: { id: payeeId, name, ...written.before },
      afterData: {
        id: payeeId,
        name,
        website: written.after.website,
        address: written.after.address,
        email: written.after.email,
        phone: written.after.phone,
        contactLookupSource: written.after.contact_lookup_source,
      },
      description: `Looked up contact details for payee "${name}"`,
      descriptionKey: "lookedUpPayeeContact",
      descriptionParams: { name },
    });

    if (written.filled.includes("website") && written.after.website) {
      await this.cacheFavicon(userId, payeeId, written.after.website);
    }
    return { reason: outcome.reason, filled: written.filled, ...offered };
  }

  /**
   * Read-then-UPDATE inside one transaction. The read is only so the caller
   * can say which fields *this* write set; the UPDATE's COALESCE is what
   * guarantees nothing already there is touched.
   */
  private async write(
    m: EntityManager,
    userId: string,
    payeeId: string,
    values: ContactColumns,
    source: string | null,
    firstAttemptOnly: boolean,
  ): Promise<{
    before: ContactColumns;
    after: EnrichmentRow;
    filled: ContactLookupField[];
  } | null> {
    const before = await m.getRepository(Payee).findOne({
      where: { id: payeeId, userId },
      select: {
        id: true,
        website: true,
        address: true,
        email: true,
        phone: true,
      },
    });
    if (!before) return null;

    const rows = returnedRows<EnrichmentRow>(
      await m.query(enrichmentUpdateSql(firstAttemptOnly), [
        payeeId,
        userId,
        values.website,
        values.address,
        values.email,
        values.phone,
        source,
      ]),
    );
    const after = rows[0];
    if (!after) return null;

    const filled = CONTACT_LOOKUP_FIELDS.filter(
      (field) => before[field] == null && after[field] != null,
    );
    return {
      before: {
        website: before.website,
        address: before.address,
        email: before.email,
        phone: before.phone,
      },
      after,
      filled,
    };
  }

  /**
   * Same rule as `PayeesService`: the favicon fetch stays outside any
   * transaction, and the write is keyed on the website it resolved so a
   * concurrent edit to the address cannot end up under a stale icon.
   */
  private async cacheFavicon(
    userId: string,
    payeeId: string,
    website: string,
  ): Promise<void> {
    const logo = await this.faviconService.fetchFavicon(website);
    await withScopedDb(this.dataSource, (m) =>
      m.update(Payee, { id: payeeId, userId, website }, brandLogoColumns(logo)),
    );
  }
}
