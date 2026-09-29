import { ConflictException, Injectable } from "@nestjs/common";
import { DataSource, EntityManager, In, MoreThan } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import {
  AiReviewRequest,
  AiReviewRequestStatus,
} from "./ai-review-request.entity";

/** One request to queue: which row, which rule asked, and what to do. */
export interface AiReviewEnqueueInput {
  readonly transactionId: string;
  /** Null for a request no rule made. */
  readonly ruleId: string | null;
  readonly instruction: string;
}

export interface AiReviewEnqueueKey {
  readonly transactionId: string;
  readonly ruleId: string | null;
}

export interface AiReviewEnqueueResult {
  /** Requests that were written. */
  readonly queued: readonly AiReviewEnqueueKey[];
  /** Requests skipped because an open one already exists for the same row and rule. */
  readonly alreadyQueued: readonly AiReviewEnqueueKey[];
}

export interface ListAiReviewRequestsOptions {
  readonly status?: AiReviewRequestStatus;
  /** Any of these statuses; wins over `status`. */
  readonly statuses?: readonly AiReviewRequestStatus[];
  readonly limit?: number;
  /** Oldest first is the queue's own order; an inbox reads newest first. */
  readonly order?: "ASC" | "DESC";
  /** Leave out requests whose life has run out, whatever their stored status. */
  readonly unexpiredOnly?: boolean;
}

/** What an agent that gives up on a claimed request tells the queue. */
export interface ReleaseAiReviewRequestInput {
  /** True: the request cannot be done and becomes `rejected`. False: it returns to `pending`. */
  readonly final: boolean;
  readonly note: string;
}

/** The longest note an agent leaves when it gives a request up. */
export const MAX_AI_REVIEW_NOTE_LENGTH = 500;

export const DEFAULT_AI_REVIEW_LIST_LIMIT = 50;
export const MAX_AI_REVIEW_LIST_LIMIT = 200;
/** Rows per INSERT, so one statement never carries an unbounded array. */
const ENQUEUE_CHUNK_SIZE = 500;

interface RequestRow {
  id: string;
  user_id: string;
  transaction_id: string;
  rule_id: string | null;
  kind: AiReviewRequest["kind"];
  instruction: string;
  status: AiReviewRequestStatus;
  claimed_by: string | null;
  claimed_at: Date | null;
  proposal: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

function toRequest(row: RequestRow): AiReviewRequest {
  return Object.assign(new AiReviewRequest(), {
    id: row.id,
    userId: row.user_id,
    transactionId: row.transaction_id,
    ruleId: row.rule_id,
    kind: row.kind,
    instruction: row.instruction,
    status: row.status,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    proposal: row.proposal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  });
}

/**
 * The AI review queue (design 6.5): durable requests that an AI look at one
 * transaction. A producer enqueues inside its own transaction; a consumer
 * claims. The queue never writes the ledger, and the transaction-rules module
 * depends on this one, never the other way round.
 */
@Injectable()
export class AiReviewRequestsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Queue requests in the caller's transaction, so a rollback of the insert
   * that asked drops them (INV-RULE-002). One `INSERT ... ON CONFLICT DO
   * NOTHING` per chunk against the partial unique index on
   * (transaction_id, rule_id) where the request is still open: a second
   * identical trigger inserts nothing and is reported in `alreadyQueued`.
   */
  async enqueue(
    m: EntityManager,
    userId: string,
    requests: readonly AiReviewEnqueueInput[],
  ): Promise<AiReviewEnqueueResult> {
    const queued: AiReviewEnqueueKey[] = [];
    const alreadyQueued: AiReviewEnqueueKey[] = [];
    for (let i = 0; i < requests.length; i += ENQUEUE_CHUNK_SIZE) {
      const chunk = requests.slice(i, i + ENQUEUE_CHUNK_SIZE);
      const inserted = returnedRows<{
        transaction_id: string;
        rule_id: string | null;
      }>(
        await m.query(
          `INSERT INTO ai_review_requests
             (user_id, transaction_id, rule_id, kind, instruction)
           SELECT $1, r.transaction_id, r.rule_id, 'transaction_review', r.instruction
             FROM unnest($2::uuid[], $3::uuid[], $4::text[])
                  AS r(transaction_id, rule_id, instruction)
           ON CONFLICT (transaction_id, rule_id)
             WHERE status IN ('pending', 'claimed', 'proposed')
           DO NOTHING
           RETURNING transaction_id, rule_id`,
          [
            userId,
            chunk.map((r) => r.transactionId),
            chunk.map((r) => r.ruleId),
            chunk.map((r) => r.instruction.trim()),
          ],
        ),
      );
      const written = new Set(
        inserted.map((row) => `${row.transaction_id}:${row.rule_id ?? ""}`),
      );
      for (const request of chunk) {
        const key = `${request.transactionId}:${request.ruleId ?? ""}`;
        const target = written.delete(key) ? queued : alreadyQueued;
        target.push({
          transactionId: request.transactionId,
          ruleId: request.ruleId,
        });
      }
    }
    return { queued, alreadyQueued };
  }

  /** The user's requests, oldest first unless told otherwise, optionally in some statuses. */
  async listForUser(
    userId: string,
    options: ListAiReviewRequestsOptions = {},
  ): Promise<AiReviewRequest[]> {
    const limit = Math.min(
      Math.max(Math.trunc(options.limit ?? DEFAULT_AI_REVIEW_LIST_LIMIT), 1),
      MAX_AI_REVIEW_LIST_LIMIT,
    );
    const order = options.order ?? "ASC";
    const statusFilter = options.statuses
      ? { status: In([...options.statuses]) }
      : options.status
        ? { status: options.status }
        : {};
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(AiReviewRequest).find({
        where: {
          userId,
          ...statusFilter,
          ...(options.unexpiredOnly ? { expiresAt: MoreThan(new Date()) } : {}),
        },
        order: { createdAt: order, id: order },
        take: limit,
      }),
    );
  }

  /** One of the user's requests, or null. Another user's id reads as absent. */
  async getForUser(
    userId: string,
    id: string,
  ): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(AiReviewRequest).findOne({ where: { id, userId } }),
    );
  }

  /**
   * Claim the user's oldest pending, unexpired request for `claimedBy`, or
   * return null when there is none. The mechanism (docs/concurrency-and-
   * idempotency.md, conditional UPDATE plus a row lock): ONE statement whose
   * subselect takes the candidate `FOR UPDATE SKIP LOCKED` and whose outer
   * `WHERE status = 'pending'` re-checks it, so two agents claiming at once
   * never receive the same row -- the loser skips the locked row, or matches
   * nothing once the winner has committed. A null is not proof the queue is
   * empty under contention; the caller asks again.
   */
  async claimNext(
    userId: string,
    claimedBy: string,
  ): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const [row] = returnedRows<RequestRow>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = 'claimed',
                  claimed_by = $2,
                  claimed_at = CURRENT_TIMESTAMP
            WHERE id = (
                    SELECT id
                      FROM ai_review_requests
                     WHERE user_id = $1
                       AND status = 'pending'
                       AND expires_at > CURRENT_TIMESTAMP
                     ORDER BY created_at, id
                     LIMIT 1
                       FOR UPDATE SKIP LOCKED)
              AND status = 'pending'
              AND user_id = $1
           RETURNING *`,
          [userId, claimedBy],
        ),
      );
      return row ? toRequest(row) : null;
    });
  }

  /**
   * Store the proposal of the agent that holds the claim and move the request to
   * `proposed`. ONE conditional UPDATE: it matches only a `claimed` request
   * whose `claimed_by` is this caller and whose life has not run out, so an
   * agent that never claimed it (or lost the claim to a dismissal, an expiry or
   * a release) writes nothing and gets null. The proposal is a signed pending
   * action; the ledger is not touched.
   */
  async submitProposal(
    userId: string,
    id: string,
    claimedBy: string,
    proposal: Record<string, unknown>,
  ): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const [row] = returnedRows<RequestRow>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = 'proposed',
                  proposal = $4::jsonb
            WHERE id = $1
              AND user_id = $2
              AND status = 'claimed'
              AND claimed_by = $3
              AND expires_at > CURRENT_TIMESTAMP
           RETURNING *`,
          [id, userId, claimedBy, JSON.stringify(proposal)],
        ),
      );
      return row ? toRequest(row) : null;
    });
  }

  /**
   * Give up a claim. The same conditional shape as {@link submitProposal}: only
   * the caller that holds the claim can release it. `final` false returns the
   * request to `pending` with the claim cleared, so another agent (or this one
   * later) can take it; `final` true marks it `rejected`, for a request that no
   * agent can do, so the queue does not hand it out again. The agent's note is
   * kept in `proposal` (`{ agentNote }`) so the next reader sees why.
   */
  async release(
    userId: string,
    id: string,
    claimedBy: string,
    input: ReleaseAiReviewRequestInput,
  ): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const [row] = returnedRows<RequestRow>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = CASE WHEN $4::boolean THEN 'rejected' ELSE 'pending' END,
                  claimed_by = NULL,
                  claimed_at = NULL,
                  proposal = jsonb_build_object(
                    'agentNote',
                    jsonb_build_object('reason', $5::text, 'at', CURRENT_TIMESTAMP))
            WHERE id = $1
              AND user_id = $2
              AND status = 'claimed'
              AND claimed_by = $3
           RETURNING *`,
          [
            id,
            userId,
            claimedBy,
            input.final,
            input.note.slice(0, MAX_AI_REVIEW_NOTE_LENGTH),
          ],
        ),
      );
      return row ? toRequest(row) : null;
    });
  }

  /**
   * The person dismisses a request that is still open: `rejected`, whoever
   * holds the claim. Null when it is not the user's or is no longer open.
   */
  async dismiss(userId: string, id: string): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const [row] = returnedRows<RequestRow>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = 'rejected'
            WHERE id = $1
              AND user_id = $2
              AND status IN ('pending', 'claimed', 'proposed')
           RETURNING *`,
          [id, userId],
        ),
      );
      return row ? toRequest(row) : null;
    });
  }

  /**
   * Mark a proposed request `applied` inside the transaction that writes what it
   * proposed, so the two commit or roll back together. The UPDATE is bound to
   * the user, to the transaction the proposal was about and to `proposed`; a
   * request that was dismissed, expired or is about another transaction matches
   * nothing and the caller's write is refused (409) before it happens -- the
   * caller runs this first, under the row lock.
   */
  async markApplied(
    m: EntityManager,
    userId: string,
    id: string,
    transactionId: string,
  ): Promise<void> {
    const applied = returnedRows<{ id: string }>(
      await m.query(
        `UPDATE ai_review_requests
            SET status = 'applied'
          WHERE id = $1
            AND user_id = $2
            AND transaction_id = $3
            AND status = 'proposed'
         RETURNING id`,
        [id, userId, transactionId],
      ),
    );
    if (applied.length === 0) {
      throw new ConflictException(
        tr(
          "errors.aiReview.notProposed",
          "This AI review request is no longer waiting for approval, so its proposal was not applied.",
        ),
      );
    }
  }

  /**
   * Mark every open request whose life has run out as `expired` (a request is
   * reported as expired, never deleted). Returns how many changed. NOT
   * scheduled: a cron is a reviewed `WITH_CONTEXT_ALLOWLIST` decision. Under a
   * user's identity it reaches only that user's rows; a sweep across users
   * must run under `withSystemContext`.
   */
  async expireStale(): Promise<number> {
    return withScopedDb(this.dataSource, async (m) => {
      const expired = returnedRows<{ id: string }>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = 'expired'
            WHERE status IN ('pending', 'claimed', 'proposed')
              AND expires_at <= CURRENT_TIMESTAMP
           RETURNING id`,
        ),
      );
      return expired.length;
    });
  }
}
