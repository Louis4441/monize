/**
 * Errors of the rule editor: reading the API's 400 and 409 answers, checking a
 * draft for the parts the reader has not filled in yet, and placing each
 * `{ path, code }` entry on the card at that path.
 *
 * The server's paths look like `condition.all[0].any[1].value` and
 * `actions[2].tagIds`. A card owns everything under its own node, so the tail
 * after the node is dropped and the entry lands on the card.
 */
import { AxiosError } from 'axios';
import type { RuleDraft } from '@/lib/rule-draft';
import {
  MAX_RULE_TAG_IDS,
  MAX_RULE_VALUE_LIST,
  RULE_OPERATOR_SHAPES,
  RULE_VALIDATION_CODES,
  type RuleErrorCode,
} from '@/lib/rule-fields';
import { actionKey } from '@/lib/rule-actions';
import { conditionKey, type EditorGroup, type EditorNode } from '@/lib/rule-tree';

export interface RuleErrorEntry {
  path: string;
  code: string;
}

/** Codes the editor can name in the catalog; anything else reads as unknown. */
export type KnownRuleErrorCode = RuleErrorCode | 'NAME_REQUIRED';

export const KNOWN_RULE_ERROR_CODES: readonly string[] = [
  ...RULE_VALIDATION_CODES,
  'REFERENCE_NOT_FOUND',
  'NAME_REQUIRED',
];

export const isKnownRuleErrorCode = (code: string): code is KnownRuleErrorCode =>
  KNOWN_RULE_ERROR_CODES.includes(code);

// ---- the API's answers ---------------------------------------------------

export interface RuleApiError {
  status: number | undefined;
  errorCode: string | undefined;
  message: string | undefined;
  entries: RuleErrorEntry[];
}

const isEntry = (v: unknown): v is RuleErrorEntry =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as RuleErrorEntry).path === 'string' &&
  typeof (v as RuleErrorEntry).code === 'string';

/** What a failed save said: the status, the machine code and the per-card entries. */
export function readRuleApiError(error: unknown): RuleApiError {
  const response = error instanceof AxiosError ? error.response : undefined;
  const data: unknown = response?.data;
  const body = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const message = body.message;
  return {
    status: response?.status,
    errorCode: typeof body.errorCode === 'string' ? body.errorCode : undefined,
    // A DTO refusal answers `message` as a list of sentences.
    message: typeof message === 'string' ? message : Array.isArray(message) ? message.join('. ') : undefined,
    entries: Array.isArray(body.errors) ? body.errors.filter(isEntry) : [],
  };
}

export const isRevisionConflict = (error: RuleApiError): boolean =>
  error.status === 409 && error.errorCode === 'REVISION_CONFLICT';

// ---- placing entries on cards --------------------------------------------

/** Error keys: `c:0.1` (a condition node), `a:2` (an action), `actions`, `name`. */
export const ACTIONS_LIST_KEY = 'actions';
export const NAME_KEY = 'name';

export interface PlacedErrors {
  /** Codes per card key, each once, in the order reported. */
  readonly byKey: Readonly<Record<string, readonly string[]>>;
  /** Entries whose path names no card; shown at the top. */
  readonly unplaced: readonly RuleErrorEntry[];
}

const CONDITION_PATH = /^condition((?:\.(?:all|any)\[\d+\])*)(?:[.[].*)?$/;
const ACTION_PATH = /^actions\[(\d+)\](?:[.[].*)?$/;

/** The key of the card a server path belongs to, or null when it names none. */
export function keyForPath(path: string): string | null {
  if (path === ACTIONS_LIST_KEY) return ACTIONS_LIST_KEY;
  if (path === NAME_KEY) return NAME_KEY;
  const condition = CONDITION_PATH.exec(path);
  if (condition) {
    const indices = [...condition[1].matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    return conditionKey(indices);
  }
  const action = ACTION_PATH.exec(path);
  return action ? actionKey(Number(action[1])) : null;
}

export function placeErrors(entries: readonly RuleErrorEntry[]): PlacedErrors {
  const byKey: Record<string, string[]> = {};
  const unplaced: RuleErrorEntry[] = [];
  for (const entry of entries) {
    const key = keyForPath(entry.path);
    if (key === null) {
      unplaced.push(entry);
      continue;
    }
    const codes = byKey[key] ?? [];
    if (!codes.includes(entry.code)) codes.push(entry.code);
    byKey[key] = codes;
  }
  return { byKey, unplaced };
}

export const NO_ERRORS: PlacedErrors = { byKey: {}, unplaced: [] };

// ---- what the reader has not filled in yet -------------------------------

function conditionEntries(node: EditorNode, path: string, out: RuleErrorEntry[]): void {
  if (node.kind === 'group') {
    node.children.forEach((child, i) => conditionEntries(child, `${path}.${node.match}[${i}]`, out));
    return;
  }
  const shape = RULE_OPERATOR_SHAPES[node.op];
  if (shape === 'none') return;
  const value = node.value;
  if (shape === 'list') {
    if (!Array.isArray(value) || value.length === 0) out.push({ path, code: 'ARRAY_EMPTY' });
    else if (value.length > MAX_RULE_VALUE_LIST) out.push({ path, code: 'ARRAY_TOO_LARGE' });
  } else if (shape === 'range') {
    const complete = Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number');
    if (!complete) out.push({ path, code: 'VALUE_REQUIRED' });
  } else if (value === undefined || value === '') {
    out.push({ path, code: 'VALUE_REQUIRED' });
  }
}

/**
 * The gaps in a draft, as the entries the server would answer with, so they
 * land on the same cards. Only completeness is checked here; the server stays
 * the authority on everything else (bounds, ownership of each id).
 */
export function draftGaps(draft: RuleDraft): RuleErrorEntry[] {
  const out: RuleErrorEntry[] = [];
  if (draft.name.trim() === '') out.push({ path: NAME_KEY, code: 'NAME_REQUIRED' });
  const root: EditorGroup = draft.condition;
  conditionEntries(root, 'condition', out);
  if (draft.actions.length === 0) out.push({ path: ACTIONS_LIST_KEY, code: 'NO_ACTIONS' });
  draft.actions.forEach((action, i) => {
    const path = `actions[${i}]`;
    if ((action.type === 'add_tags' || action.type === 'remove_tags') && action.tagIds.length === 0) {
      out.push({ path, code: 'ARRAY_EMPTY' });
    } else if ((action.type === 'add_tags' || action.type === 'remove_tags') && action.tagIds.length > MAX_RULE_TAG_IDS) {
      out.push({ path, code: 'ARRAY_TOO_LARGE' });
    } else if (action.type === 'set_category' && action.categoryId === '') {
      out.push({ path, code: 'VALUE_REQUIRED' });
    } else if (action.type === 'set_payee' && action.payeeId === '') {
      out.push({ path, code: 'VALUE_REQUIRED' });
    } else if (action.type === 'request_ai_review' && action.instruction.trim() === '') {
      out.push({ path, code: 'VALUE_EMPTY' });
    }
  });
  return out;
}
