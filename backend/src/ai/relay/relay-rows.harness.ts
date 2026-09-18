import {
  RelayAnswerPayload,
  RelayPromptPayload,
  RelayPromptStatus,
} from "./entities/ai-relay-prompt.entity";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";

/**
 * An `ai_relay_prompts` table that answers `AiRelayService`'s statements.
 *
 * A double that only recorded the SQL would make every behavioural assertion in
 * the relay's spec vacuous: FIFO order, one-claim-wins, a refused second answer,
 * the idle window being pushed out by liveness and clamped by the hard deadline
 * are all properties of *what the statement does to the row*, not of the string.
 * So this evaluates them, on the same rules the real table does -- conditional
 * on `status`, compared against a single clock, `LEAST`-clamped.
 *
 * What it deliberately does not model, because no in-process double can: `FOR
 * UPDATE SKIP LOCKED` under real concurrency. That property belongs to
 * PostgreSQL and is proved by `test/integration/ai-relay-claim.integration.spec.ts`
 * with two connections (VER-001).
 */
export interface RelayPromptRow {
  id: string;
  userId: string;
  status: RelayPromptStatus;
  prompt: RelayPromptPayload;
  answer: RelayAnswerPayload | null;
  claimedBy: string | null;
  /** Epoch ms, all four, read through the harness's one clock. */
  createdAt: number;
  claimedAt: number | null;
  answeredAt: number | null;
  expiresAt: number;
}

export interface RelayRowsHarness {
  /** The mock DataSource to hand `AiRelayService`. */
  dataSource: ReturnType<typeof createScopedDbMocks>["dataSource"];
  /** The table, in insertion order. Assert on it; mutate it to set a scenario up. */
  rows: RelayPromptRow[];
  /** Every statement the service issued, for the rare assertion about SQL itself. */
  statements: string[];
}

/** `CURRENT_TIMESTAMP`, which under a spec's fake timers is the spec's clock. */
function now(): number {
  return Date.now();
}

/**
 * Build the harness. `manager.query` is replaced with an interpreter over the
 * statements `AiRelayService` issues; anything else throws, so a new statement
 * announces itself instead of silently returning no rows.
 */
export function createRelayRowsHarness(): RelayRowsHarness {
  const scoped = createScopedDbMocks();
  const rows: RelayPromptRow[] = [];
  const statements: string[] = [];
  let sequence = 0;

  const byId = (id: string, userId: string): RelayPromptRow | undefined =>
    rows.find((r) => r.id === id && r.userId === userId);

  scoped.manager.query.mockImplementation(
    async (sql: string, params: unknown[] = []) => {
      statements.push(sql);

      if (sql.includes("INSERT INTO ai_relay_prompts")) {
        const [userId, payload, queueWaitMs] = params as [
          string,
          string,
          number,
        ];
        const row: RelayPromptRow = {
          id: `prompt-${++sequence}`,
          userId,
          status: "pending",
          prompt: JSON.parse(payload) as RelayPromptPayload,
          answer: null,
          claimedBy: null,
          createdAt: now(),
          claimedAt: null,
          answeredAt: null,
          expiresAt: now() + queueWaitMs,
        };
        rows.push(row);
        return [{ id: row.id }];
      }

      if (sql.includes("WITH next AS")) {
        const [userId, sessionId, idleMs] = params as [
          string,
          string | null,
          number,
        ];
        const next = rows.find(
          (r) =>
            r.userId === userId &&
            r.status === "pending" &&
            r.expiresAt > now(),
        );
        if (!next) return [];
        next.status = "claimed";
        next.claimedAt = now();
        next.claimedBy = sessionId;
        next.expiresAt = now() + idleMs;
        return [{ id: next.id, prompt: next.prompt }];
      }

      if (sql.includes("SET status = 'answered'")) {
        const [promptId, userId, answer, bufferMs] = params as [
          string,
          string,
          string,
          number,
        ];
        const row = byId(promptId, userId);
        if (
          !row ||
          row.status !== "claimed" ||
          row.expiresAt + bufferMs <= now()
        ) {
          return [];
        }
        row.status = "answered";
        row.answer = JSON.parse(answer) as RelayAnswerPayload;
        row.answeredAt = now();
        return [{ id: row.id }];
      }

      if (sql.includes("SET status = 'expired'")) {
        const [promptId, userId] = params as [string, string];
        const row = byId(promptId, userId);
        if (!row || row.status !== "answered") return [];
        row.status = "expired";
        return [{ answer: row.answer }];
      }

      if (sql.includes("SET claimed_by = COALESCE")) {
        const [promptId, userId, sessionId, idleMs, hardMs] = params as [
          string,
          string,
          string | null,
          number,
          number,
        ];
        const row = byId(promptId, userId);
        if (!row || row.status !== "claimed" || row.expiresAt <= now()) {
          return [];
        }
        row.claimedBy = sessionId ?? row.claimedBy;
        row.expiresAt = Math.min(now() + idleMs, (row.claimedAt ?? 0) + hardMs);
        return [{ id: row.id }];
      }

      if (sql.includes("SET expires_at = LEAST")) {
        const [userId, sessionId, idleMs, hardMs] = params as [
          string,
          string | null,
          number,
          number,
        ];
        const matches = rows.filter(
          (r) =>
            r.userId === userId &&
            r.status === "claimed" &&
            r.claimedBy === sessionId &&
            r.expiresAt > now(),
        );
        for (const row of matches) {
          row.expiresAt = Math.min(
            now() + idleMs,
            (row.claimedAt ?? 0) + hardMs,
          );
        }
        return matches.map((r) => ({ id: r.id }));
      }

      if (sql.includes("COUNT(*) FILTER")) {
        const [userId] = params as [string];
        const live = rows.filter(
          (r) => r.userId === userId && r.expiresAt > now(),
        );
        return [
          {
            queued: String(live.filter((r) => r.status === "pending").length),
            in_flight: String(
              live.filter((r) => r.status === "claimed").length,
            ),
          },
        ];
      }

      if (sql.includes("SELECT status, answer, prompt, claimed_at")) {
        const [promptId, userId] = params as [string, string];
        const row = byId(promptId, userId);
        if (!row) return [];
        return [
          {
            status: row.status,
            answer: row.answer,
            prompt: row.prompt,
            claimed_at: row.claimedAt === null ? null : new Date(row.claimedAt),
            expired: row.expiresAt <= now(),
            remaining_ms: String(Math.ceil(row.expiresAt - now())),
          },
        ];
      }

      if (sql.includes("SELECT id")) {
        const [userId, sessionId, bufferMs] = params as [
          string,
          string | null,
          number,
        ];
        const match = [...rows]
          .reverse()
          .find(
            (r) =>
              r.userId === userId &&
              r.status === "claimed" &&
              r.claimedBy === sessionId &&
              r.expiresAt + bufferMs > now(),
          );
        return match ? [{ id: match.id }] : [];
      }

      throw new Error(`createRelayRowsHarness: no rule for statement:\n${sql}`);
    },
  );

  return {
    dataSource: scoped.dataSource,
    rows,
    statements,
  };
}
