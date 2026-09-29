import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
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
  readonly limit?: number;
}

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

  /** The user's requests, oldest first, optionally in one status. */
  async listForUser(
    userId: string,
    options: ListAiReviewRequestsOptions = {},
  ): Promise<AiReviewRequest[]> {
    const limit = Math.min(
      Math.max(Math.trunc(options.limit ?? DEFAULT_AI_REVIEW_LIST_LIMIT), 1),
      MAX_AI_REVIEW_LIST_LIMIT,
    );
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(AiReviewRequest).find({
        where: {
          userId,
          ...(options.status ? { status: options.status } : {}),
        },
        order: { createdAt: "ASC", id: "ASC" },
        take: limit,
      }),
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
