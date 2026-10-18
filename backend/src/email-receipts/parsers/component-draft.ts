import type { EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import {
  componentWindow,
  type ComponentRow,
  type ComponentSearch,
} from "../linking/component-lookup";
import { coveredByDomainSql } from "../linking/component-reread";
import { parseReceiptLinesTraced } from "../parsing/parse-receipt";
import {
  MAX_LINK_DOMAINS,
  type ReceiptParserDefinition,
} from "../parsing/receipt-parser.types";
import {
  validateReceiptParserDefinition,
  type ReceiptParserValidationError,
} from "../parsing/receipt-parser.validation";
import { ReceiptSourceLines } from "../pipeline/receipt-source-lines";
import { EMAIL_RECEIPT_PARSER_TOOL_MAX_DRAFTS } from "./parser-tool.guide";
import {
  isReceiptDomain,
  normalizeReceiptDomain,
} from "./dto/receipt-domain.validator";

/**
 * `componentDrafts` of the `test` operation (linked receipts spec 10a): unsaved
 * `component` profiles, each with the sender domains it would cover, offered
 * beside a `settlement` definition so the profiles can be tested before any is
 * saved. Nothing here writes.
 */

/** Stored emails a dry run reads with ONE component draft (newest first). */
export const MAX_DRAFT_COMPONENT_EMAILS = 200;

/** A component draft that passed `checkComponentDrafts`. */
export interface ComponentDraft {
  definition: ReceiptParserDefinition;
  /** Normalized sender domains (1 to `MAX_LINK_DOMAINS`). */
  fromDomains: string[];
}

export type ComponentDraftCheck =
  | { ok: true; drafts: ComponentDraft[] }
  | { ok: false; errors: ReceiptParserValidationError[] };

/**
 * Validate the `componentDrafts` of a test against the definition being tested.
 * The definition under test must be a `settlement`
 * (`component_draft_requires_settlement`); there are 1 to
 * `EMAIL_RECEIPT_PARSER_TOOL_MAX_DRAFTS` drafts (`component_draft_too_many`);
 * each draft's definition goes through the one validator (its paths are prefixed
 * `componentDrafts[i].definition`) and must have `role: "component"`
 * (`component_draft_requires_component`); its `fromDomains` is 1 to 10 valid
 * domains (`component_draft_domain_invalid`). Each `definition` is what the
 * caller resolved (category names to ids, the version defaulted). Pure.
 */
export function checkComponentDrafts(
  tested: Pick<ReceiptParserDefinition, "role">,
  inputs: readonly { definition: unknown; fromDomains: unknown }[],
): ComponentDraftCheck {
  if (tested.role !== "settlement") {
    return {
      ok: false,
      errors: [
        {
          path: "componentDrafts",
          code: "component_draft_requires_settlement",
        },
      ],
    };
  }
  if (
    inputs.length < 1 ||
    inputs.length > EMAIL_RECEIPT_PARSER_TOOL_MAX_DRAFTS
  ) {
    return {
      ok: false,
      errors: [{ path: "componentDrafts", code: "component_draft_too_many" }],
    };
  }
  const errors: ReceiptParserValidationError[] = [];
  const drafts: ComponentDraft[] = [];
  inputs.forEach((input, index) => {
    const at = `componentDrafts[${index}]`;
    const validation = validateReceiptParserDefinition(input.definition);
    let definition: ReceiptParserDefinition | null = null;
    if (!validation.ok) {
      for (const error of validation.errors) {
        errors.push({
          path:
            error.path === ""
              ? `${at}.definition`
              : `${at}.definition.${error.path}`,
          code: error.code,
        });
      }
    } else if (validation.definition.role !== "component") {
      errors.push({
        path: `${at}.definition.role`,
        code: "component_draft_requires_component",
      });
    } else {
      definition = validation.definition;
    }
    const list = input.fromDomains;
    const domains = Array.isArray(list)
      ? list.map((entry) => normalizeReceiptDomain(entry))
      : [];
    if (
      !Array.isArray(list) ||
      list.length < 1 ||
      list.length > MAX_LINK_DOMAINS ||
      !domains.every(isReceiptDomain)
    ) {
      errors.push({
        path: `${at}.fromDomains`,
        code: "component_draft_domain_invalid",
      });
    } else if (definition !== null) {
      drafts.push({
        definition,
        fromDomains: [...new Set(domains as string[])],
      });
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, drafts };
}

/**
 * Read the user's stored emails with the component drafts, as the candidates a
 * settlement's parts may join (spec 10a). The emails are the user's, not
 * `skipped`, from a sender the draft covers (the module's equal-or-subdomain
 * rule), dated inside the settlement's component window (the one
 * `loadLinkedComponents` uses), newest first, at most
 * `MAX_DRAFT_COMPONENT_EMAILS` per draft; the settlement's own email is left out. Each is
 * read with the draft over the lines of its `source`; a reading that the draft's
 * guards turn aside, or that holds no link value among `wanted`, is not a
 * candidate. Reads only: no write, no row lock.
 */
export async function readDraftComponents(
  m: EntityManager,
  userId: string,
  settlement: { id: string; effectiveDate: string },
  wanted: ReadonlySet<string>,
  search: ComponentSearch,
  drafts: readonly ComponentDraft[],
): Promise<ComponentRow[]> {
  if (wanted.size === 0) return [];
  const found: ComponentRow[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    for (const row of await readOneDraft(
      m,
      userId,
      settlement,
      wanted,
      search,
      draft,
    )) {
      // An email two drafts both cover is a candidate once: the first draft's reading.
      if (!seen.has(row.id)) {
        seen.add(row.id);
        found.push(row);
      }
    }
  }
  return found;
}

async function readOneDraft(
  m: EntityManager,
  userId: string,
  settlement: { id: string; effectiveDate: string },
  wanted: ReadonlySet<string>,
  search: ComponentSearch,
  draft: ComponentDraft,
): Promise<ComponentRow[]> {
  const { from, to } = componentWindow(settlement.effectiveDate, search);
  const rows = returnedRows<{
    id: string;
    subject: string;
    body_text: string;
    body_html: string | null;
    effective_date: string;
  }>(
    await m.query(
      `SELECT r.id, r.subject, r.body_text, r.body_html,
              TO_CHAR((COALESCE(r.original_sent_at, r.received_at) AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS effective_date
         FROM email_receipts r
        WHERE r.user_id = $1
          AND r.status <> 'skipped'
          AND r.id <> $2
          AND EXISTS (
                SELECT 1 FROM unnest($3::text[]) AS d(domain)
                 WHERE ${coveredByDomainSql("r", "d.domain")})
          AND (COALESCE(r.original_sent_at, r.received_at) AT TIME ZONE 'UTC')::date
                BETWEEN $4::date AND $5::date
        ORDER BY COALESCE(r.original_sent_at, r.received_at) DESC, r.id ASC
        LIMIT ${MAX_DRAFT_COMPONENT_EMAILS}`,
      [userId, settlement.id, draft.fromDomains, from, to],
    ),
  );
  const found: ComponentRow[] = [];
  for (const row of rows) {
    const read = parseReceiptLinesTraced(
      draft.definition,
      row.subject,
      new ReceiptSourceLines({
        bodyText: row.body_text,
        bodyHtml: row.body_html,
      }).forSource(draft.definition.source),
      null,
    );
    const linkKey = read.parsed.linkKey ?? null;
    if (read.outcome !== "read" || linkKey === null || !wanted.has(linkKey)) {
      continue;
    }
    found.push({
      id: row.id,
      linkKey,
      subject: row.subject,
      effectiveDate: row.effective_date,
      parsed: read.parsed,
      parserId: null,
    });
  }
  return found;
}
