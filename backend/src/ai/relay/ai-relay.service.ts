import { Inject, Injectable, Logger } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";

import {
  RelayAttachmentRef,
  RelayClaimedPrompt,
  RelayResponse,
  RelayServerEvent,
  RelayStreamOptions,
  RelayTunnelState,
  RelayTunnelStatus,
} from "./ai-relay.types";
import { RelayAttachmentStore } from "./relay-attachment.store";
import { RelayStreamRegistry } from "./relay-stream.registry";
import {
  RelayAnswerPayload,
  RelayPromptPayload,
  RelayPromptStatus,
} from "./entities/ai-relay-prompt.entity";
import { PendingAiAction } from "../actions/ai-action.types";
import { EVENT_BUS, EventBus } from "../../common/events/event-bus.interface";
import { WakeSignal } from "../../common/events/wake-signal";
import { returnedRows } from "../../common/db/query-result";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../../common/db/scoped-db";

/**
 * How long a queued (never-claimed) prompt waits for ANY agent to pick it up
 * before the browser gives up. Keeps an offline agent from hanging the browser
 * forever. This is the only deadline that applies before a claim; once an agent
 * claims the prompt the idle window below takes over.
 */
const QUEUE_WAIT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Once an agent has claimed a prompt, how long it may go completely silent (no
 * poll, progress, or tool activity) before the browser gives up on it. Pushed
 * out by every liveness signal, so a slow-but-alive agent that keeps reporting
 * stays connected indefinitely (up to HARD_WAIT_MS). A blip in the agent's own
 * API connection is what trips this -- and a late answer is still accepted if
 * the agent recovers and posts within BUFFER_TTL_MS of the deadline.
 *
 * Sized to outlast the agent's own quiet phases: composing a large tool-call
 * payload (e.g. a 40-item bulk write) is invisible to us -- no poll, progress,
 * or tool activity reaches the relay until the call lands -- so too short a
 * window trips mid-composition, the browser gives up, and a confirmation card
 * emitted afterwards has no live stream to render into (#793). The card buffer
 * recovers that case regardless, but a generous idle window keeps the common
 * case on the live stream so the card appears without a pickup round-trip.
 */
const IDLE_TIMEOUT_MS = 180 * 1000; // 3 minutes of silence after a claim

/**
 * Absolute backstop from claim time, regardless of liveness, so a wedged agent
 * that keeps emitting heartbeats but never finishes cannot hold the browser
 * open forever.
 */
const HARD_WAIT_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Grace after a claimed turn's deadline during which the agent's answer is
 * still accepted and a confirmation card still counts as belonging to that
 * turn. The browser has given up by then; the answer lands on the row and is
 * served by the pickup endpoint instead of the stream.
 */
export const BUFFER_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Cap on buffered late confirmation cards retained per user. Bounds memory if
 * an agent keeps emitting cards whose browsers have all gone away. Oldest
 * entries are evicted first.
 */
const MAX_BUFFERED_PER_USER = 20;

/**
 * How long a single `get_next_prompt` long-poll parks before returning empty.
 * Kept under typical proxy idle timeouts; the agent is told to immediately poll
 * again, so this just bounds one HTTP round-trip.
 */
const POLL_PARK_MS = 25 * 1000; // 25 seconds

/**
 * How long a parked waiter goes without re-reading its row when no wake-up
 * arrives.
 *
 * A bus message is a hint and can be lost outright, so the wake-up only ever
 * shortens this wait -- it never replaces it. Five seconds is the most latency
 * a dropped message may cost, at the price of one primary-key read per open
 * chat per interval.
 */
const WAKE_POLL_INTERVAL_MS = 5 * 1000;

/**
 * An agent counts as "connected" if it polled within this window. Slightly
 * longer than POLL_PARK_MS so the brief gap between two polls does not flicker
 * the indicator back to offline.
 */
const CONNECTED_WINDOW_MS = 45 * 1000; // 45 seconds

/**
 * How long the user can be inactive (no new prompt) before the relay tells the
 * agent to stop its polling loop. An idle agent otherwise long-polls
 * `get_next_prompt` forever, and every empty poll is a fresh turn that bloats
 * the agent's own context until it degrades or its harness gives up mid-task.
 * Stopping the loop cleanly after a quiet spell avoids that; the web chat shows
 * an "idle disconnected" notice and the user reconnects when they want to
 * continue. The clock resets on every prompt, so an active conversation is
 * never interrupted.
 */
export const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Most recent conversation turns carried into a relayed prompt. The browser
 * sends the whole conversation, but `get_next_prompt` returns it to the agent on
 * EVERY prompt, and the agent runs the relay loop in one long-lived session that
 * also accumulates its own context. Returning an unbounded history therefore
 * grows the agent's context until the model degrades (multi-minute "thinking",
 * malformed tool calls, no answer). Keep only the newest turns, within a char
 * budget, so continuity survives without the bloat.
 */
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_CHARS = 12000;
const HISTORY_TRUNCATION_MARKER = " … [truncated]";

/** The per-user wake-up channel on the `EventBus`. Carries ids, never payloads. */
export function relayChannel(userId: string): string {
  return `relay:${userId}`;
}

/**
 * `expires_at` arithmetic, always in the database's clock rather than this
 * process's: two replicas disagreeing about "now" by a few seconds must not
 * disagree about whether a turn is still live.
 */
function msInterval(param: string): string {
  return `(${param}::numeric / 1000 * INTERVAL '1 second')`;
}

/**
 * Trim a conversation history to the most recent turns within the char budget,
 * preserving order (oldest first). Older turns that do not fit are dropped; if
 * the single newest turn alone exceeds the budget it is kept but truncated, so
 * the result is always bounded regardless of how long the conversation grew.
 */
export function trimRelayHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Array<{ role: "user" | "assistant"; content: string }> {
  const kept: Array<{ role: "user" | "assistant"; content: string }> = [];
  let budget = MAX_HISTORY_CHARS;
  for (
    let i = history.length - 1;
    i >= 0 && kept.length < MAX_HISTORY_TURNS && budget > 0;
    i--
  ) {
    const { role, content } = history[i];
    if (content.length <= budget) {
      kept.push({ role, content });
      budget -= content.length;
    } else {
      // Only the newest kept turn may be truncated to fit; once anything is
      // kept, an over-budget older turn (and everything before it) is dropped.
      if (kept.length === 0) {
        kept.push({
          role,
          content: content.slice(0, budget) + HISTORY_TRUNCATION_MARKER,
        });
      }
      break;
    }
  }
  return kept.reverse();
}

/** The turn as the browser's waiter sees it on each re-read. */
interface PromptStateRow {
  status: RelayPromptStatus;
  answer: RelayAnswerPayload | null;
  prompt: RelayPromptPayload;
  claimed_at: Date | null;
  expired: boolean;
  remaining_ms: string | number;
}

/** A write-confirmation card emitted after the browser stream gave up. */
interface BufferedAction {
  action: PendingAiAction;
  /** Epoch ms the card was emitted; used for TTL pruning and LRU eviction. */
  at: number;
}

/**
 * Broker between the browser chat and the user's MCP agent.
 *
 * The queue is rows, not process memory. The browser inserts a `pending`
 * `ai_relay_prompts` row and parks; the agent's long-poll claims one with a
 * conditional `UPDATE` under `FOR UPDATE SKIP LOCKED`, so two agents polling one
 * user get different prompts and the loser of a double `post_response` is
 * refused by the database rather than by a read it had already passed
 * (INV-HA-005). A wake-up on the `EVENT_BUS` only shortens the wait: it carries
 * ids, never the prompt or the answer, and every waiter re-reads its row on a
 * slow timer in case the message was lost.
 *
 * The relay never touches financial data itself -- it only routes prompts and
 * answers; the agent does the work through the existing MCP tools.
 */
@Injectable()
export class AiRelayService {
  private readonly logger = new Logger(AiRelayService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly attachmentStore: RelayAttachmentStore,
    private readonly streams: RelayStreamRegistry,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  /** Last time each user's agent polled, for connection liveness. */
  private readonly lastPollAt = new Map<string, number>();
  /**
   * When the current idle (no-prompt) streak began for a user, set on the first
   * empty poll and reset on any prompt. Drives the inactivity disconnect.
   */
  private readonly idleSince = new Map<string, number>();
  /**
   * Users whose agent was told to stop after INACTIVITY_TIMEOUT_MS of no prompts.
   * Surfaced in the tunnel status so the chat shows an "idle disconnected" notice
   * until the user reconnects (the agent polls again) or sends a new prompt.
   */
  private readonly idleDisconnectedAt = new Map<string, number>();
  /**
   * Write-confirmation cards emitted after the browser stream gave up, keyed by
   * userId then actionId. The browser drains them via the pickup endpoint so a
   * card composed slowly (idle timeout fired) is still shown and approvable
   * rather than being silently lost or auto-declined (#793).
   */
  private readonly bufferedActions = new Map<
    string,
    Map<string, BufferedAction>
  >();

  /**
   * Enqueue a prompt from the browser and resolve when the agent answers.
   *
   * The row is inserted and committed before this parks, so an agent polling any
   * replica can claim it; the wake-up is published after that commit, never
   * inside it. `options.onEnqueued` is invoked with the row's id as soon as it
   * exists, so the browser stream can tell the client its id up front and later
   * pick up a late answer for it.
   */
  async enqueuePrompt(
    userId: string,
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    options: RelayStreamOptions = {},
  ): Promise<RelayResponse> {
    // Validate and persist any attachments up front so a bad upload rejects the
    // request before the prompt is ever queued (the controller maps the thrown
    // BadRequestException to an error SSE event).
    const attachments = this.attachmentStore.store(
      userId,
      options.attachments ?? [],
    );
    // A new prompt is activity: restart the inactivity clock and clear any
    // prior idle-disconnect notice so the chat shows the live state again.
    this.idleSince.delete(userId);
    this.idleDisconnectedAt.delete(userId);

    const payload: RelayPromptPayload = {
      prompt,
      // Bound the history handed to the agent: get_next_prompt returns it on
      // every prompt, so an unbounded conversation bloats the agent's context.
      history: trimRelayHistory(history),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const promptId = await this.insertPrompt(userId, payload);
    // After the insert's transaction committed: a wake-up published inside it
    // would send an agent looking for a row that may never exist.
    await this.publishWake(userId, promptId);
    options.onEnqueued?.(promptId);

    const release = options.emit
      ? this.streams.register(promptId, userId, options.emit)
      : undefined;
    try {
      return await this.awaitAnswer(userId, promptId, attachments, options);
    } finally {
      release?.();
    }
  }

  /**
   * Called by the `get_next_prompt` MCP tool. Claims the next queued prompt for
   * the user, or parks until one arrives or the poll window elapses (then
   * returns null so the agent polls again).
   */
  async waitForPrompt(
    userId: string,
    sessionId?: string,
  ): Promise<RelayClaimedPrompt | null> {
    this.lastPollAt.set(userId, Date.now());
    // The agent is polling, so it is connected: clear any stale idle-disconnect
    // notice (e.g. it just reconnected after a quiet spell).
    this.idleDisconnectedAt.delete(userId);
    // A poll proves THIS agent is alive: keep the prompt it is mid-task on from
    // tripping the idle window. Scoped to its own session -- another session's
    // traffic says nothing about whether this agent is still working.
    await this.bumpLiveness(userId, sessionId);

    const first = await this.claimNextPrompt(userId, sessionId);
    if (first) return first;

    const signal = new WakeSignal();
    const unsubscribe = this.bus.subscribe(relayChannel(userId), () =>
      signal.signal(),
    );
    try {
      const parkUntil = Date.now() + POLL_PARK_MS;
      for (;;) {
        const remaining = parkUntil - Date.now();
        if (remaining <= 0) return null;
        await signal.wait(Math.min(remaining, WAKE_POLL_INTERVAL_MS));
        // A wake-up is a hint: the prompt it announced may have been claimed by
        // another agent in between, so the claim decides, never the message.
        const claimed = await this.claimNextPrompt(userId, sessionId);
        if (claimed) return claimed;
      }
    } finally {
      unsubscribe();
    }
  }

  /**
   * Called by `get_next_prompt` after an empty poll (no prompt was waiting) to
   * decide whether the agent should stop its loop for inactivity. The first
   * empty poll starts the idle clock; once INACTIVITY_TIMEOUT_MS of no prompts
   * has elapsed it returns true (and records the disconnect so the chat can show
   * it), telling the tool to instruct the agent to exit rather than keep
   * polling. The clock is reset by enqueuePrompt and by claiming a prompt, so an
   * active conversation never trips it.
   */
  shouldStopForIdle(userId: string): boolean {
    const since = this.idleSince.get(userId);
    if (since === undefined) {
      this.idleSince.set(userId, Date.now());
      return false;
    }
    if (Date.now() - since >= INACTIVITY_TIMEOUT_MS) {
      this.idleSince.delete(userId);
      this.idleDisconnectedAt.set(userId, Date.now());
      this.logger.log(
        `Relay agent for user ${userId} idle ${INACTIVITY_TIMEOUT_MS}ms; ` +
          `signalling stop`,
      );
      return true;
    }
    return false;
  }

  /**
   * Called by the `post_response` MCP tool. Moves the row from `claimed` to
   * `answered` in one conditional `UPDATE`, then publishes a wake-up so the
   * replica holding the browser's stream re-reads it.
   *
   * The answer is never dropped when the browser has already given up: the row
   * keeps it until the pickup endpoint takes it, or the sweeper's TTL does.
   * Returns false when the `UPDATE` matched nothing -- an unknown or foreign
   * promptId, a turn nobody claimed, one already answered, or one whose grace
   * after the deadline has run out.
   */
  async postResponse(
    userId: string,
    promptId: string,
    text: string,
  ): Promise<boolean> {
    this.lastPollAt.set(userId, Date.now());
    const answered = await this.writeAnswer(userId, promptId, { text });
    if (!answered) {
      return false;
    }
    await this.publishWake(userId, promptId);
    return true;
  }

  /**
   * Hand the browser an answer that landed after its stream gave up, and close
   * the turn out. Returns null when there is nothing to hand over: the turn is
   * still running, was never answered, or has already been picked up.
   */
  async takeBufferedResponse(
    userId: string,
    promptId: string,
  ): Promise<RelayResponse | null> {
    return this.consumeAnswer(userId, promptId);
  }

  /**
   * Called by the `report_progress` MCP tool. Streams an interim status line
   * from the agent to the browser parked on this prompt as an `assistant_text`
   * event -- the same live-narration channel the native AI Assistant uses -- so
   * the user sees what the agent is doing ("looking up the category...",
   * "sending the confirmation card...") instead of a static spinner. Returns
   * false if the prompt is unknown, already settled, or has no stream here.
   */
  async reportProgress(
    userId: string,
    promptId: string,
    text: string,
    sessionId?: string,
  ): Promise<boolean> {
    this.lastPollAt.set(userId, Date.now());
    // Knowing the (unguessable) promptId is what proves this caller owns the
    // turn, so a reconnected agent's new session is adopted here rather than
    // locked out -- and the same statement counts the call as liveness.
    const owned = await this.adoptAndBump(userId, promptId, sessionId);
    if (!owned) {
      return false;
    }
    // The browser accumulates assistant_text into one live-narration block
    // (rendered whitespace-pre-wrap), so terminate each discrete update with a
    // newline to keep sequential progress lines from running together.
    return this.streams.emit(userId, promptId, {
      type: "assistant_text",
      text: `${text}\n`,
    });
  }

  /**
   * Stream the agent's tool activity to the browser as `tool_start` /
   * `tool_result` events -- the same channel the native AI Assistant uses to
   * show "Looking up ..." chips. Called by the MCP server's per-call wrapper for
   * every Monize tool the agent invokes while handling a relayed prompt, so the
   * user sees real-time progress without the agent having to narrate explicitly.
   */
  async reportToolActivity(
    userId: string,
    toolName: string,
    phase: "start" | "result",
    isError = false,
    sessionId?: string,
  ): Promise<void> {
    // Deliberately does NOT stamp lastPollAt, and everything below is scoped to
    // the CALLING session: every MCP data tool call lands here, including calls
    // from a direct MCP client (Claude Desktop) that has nothing to do with the
    // relay. Treating that traffic as this user's relay liveness kept an
    // abandoned relay prompt alive indefinitely, so the dead turn stayed
    // claimed and captured every later direct write's confirmation card -- and
    // mirrored the direct client's tool chips into a web chat nobody was
    // watching.
    const promptId = await this.bumpLiveness(userId, sessionId);
    if (!promptId) {
      return;
    }
    const event: RelayServerEvent =
      phase === "start"
        ? { type: "tool_start", name: toolName }
        : { type: "tool_result", name: toolName, isError };
    this.streams.emit(userId, promptId, event);
  }

  /**
   * Push a write-confirmation card to the browser parked on this user's
   * in-flight relay prompt. Called by the MCP write tools when they detect they
   * are serving a relayed prompt: instead of an MCP-client elicitation (which
   * the user would have to accept in their CLI), the approve/reject card is
   * rendered in the web chat, exactly like the native AI Assistant.
   *
   * Returns true when the card was handled by the relay (the caller is in relay
   * context and must NOT perform the write -- the browser commits it via
   * /ai/actions/confirm on approval): either delivered live, or, when the
   * browser stream already gave up while the agent composed the call, buffered
   * for pickup. Returns false only when the user has no relay turn at all (a
   * direct MCP client), so the caller falls back to its own confirmation.
   *
   * Buffering the card when the stream is gone is what fixes #793: previously a
   * card emitted after the idle timeout returned false, the write tool fell
   * through to an MCP-client elicitation the web-chat user could not answer, and
   * it surfaced as a decline.
   */
  async emitPendingAction(
    userId: string,
    action: PendingAiAction,
    sessionId?: string,
  ): Promise<boolean> {
    // A turn this session claimed and has not finished -- including one whose
    // deadline has passed but whose grace has not, which is exactly the case
    // where the browser gave up while the agent composed this call.
    const turn = await this.findSessionTurn(userId, sessionId);
    if (!turn) {
      return false;
    }
    if (this.streams.emit(userId, turn, { type: "pending_action", action })) {
      return true;
    }
    this.bufferAction(userId, action);
    return true;
  }

  /**
   * Drain any buffered confirmation cards for a user, removing them. Returns an
   * empty array when none are buffered (expired, already picked up, or never
   * buffered). Prunes expired entries on access.
   */
  takeBufferedActions(userId: string): PendingAiAction[] {
    this.pruneActionBuffer(userId);
    const userBuffer = this.bufferedActions.get(userId);
    if (!userBuffer || userBuffer.size === 0) {
      return [];
    }
    const actions = [...userBuffer.values()]
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.action);
    this.bufferedActions.delete(userId);
    return actions;
  }

  /** Tunnel status for the chat indicator. One indexed query per call. */
  async getStatus(userId: string): Promise<RelayTunnelStatus> {
    const [row] = returnedRows<{ queued: string; in_flight: string }>(
      await this.relayQuery(
        `SELECT COUNT(*) FILTER (
                  WHERE status = 'pending' AND expires_at > CURRENT_TIMESTAMP
                ) AS queued,
                COUNT(*) FILTER (
                  WHERE status = 'claimed' AND expires_at > CURRENT_TIMESTAMP
                ) AS in_flight
           FROM ai_relay_prompts
          WHERE user_id = $1`,
        [userId],
      ),
    );
    const queued = Number(row?.queued ?? 0);
    const inFlight = Number(row?.in_flight ?? 0);
    return {
      state: this.computeState(userId, inFlight > 0),
      queued,
      // Present only between an inactivity stop and the user reconnecting (agent
      // polls again) or sending a new prompt, so the chat can explain it.
      ...(this.idleDisconnectedAt.has(userId)
        ? { idleDisconnected: true }
        : {}),
    };
  }

  private computeState(userId: string, inFlight: boolean): RelayTunnelState {
    if (inFlight) {
      return "busy";
    }
    const last = this.lastPollAt.get(userId) ?? 0;
    return Date.now() - last < CONNECTED_WINDOW_MS ? "listening" : "offline";
  }

  // ---------------------------------------------------------------- the rows

  /**
   * Park until this turn is answered or its deadline passes, re-reading the row
   * on every wake-up and on a slow timer besides.
   *
   * The deadline is the row's own `expires_at`, which the agent's liveness
   * pushes out, so a slow-but-alive agent keeps the browser; a lost wake-up
   * costs one poll interval and nothing else.
   */
  private async awaitAnswer(
    userId: string,
    promptId: string,
    attachments: RelayAttachmentRef[],
    options: RelayStreamOptions,
  ): Promise<RelayResponse> {
    const signal = new WakeSignal();
    const unsubscribe = this.bus.subscribe(relayChannel(userId), () =>
      signal.signal(),
    );
    // A closed socket wakes the waiter the same way an answer does, so it stops
    // at once instead of sitting out the rest of its poll interval first.
    const onClose = () => signal.signal();
    options.signal?.addEventListener("abort", onClose);
    try {
      for (;;) {
        if (options.signal?.aborted) {
          // The socket is gone. The row stays exactly as it is: the agent may
          // still answer it, and the pickup endpoint serves that answer when
          // the browser comes back.
          throw new RelayStreamClosedError(promptId);
        }
        const row = await this.readPrompt(userId, promptId);
        if (!row) {
          // The row is gone (the user was deleted, or the sweeper reclaimed it
          // long after the deadline). Nothing is coming.
          throw new RelayTimeoutError("no_agent", promptId);
        }
        if (row.status === "answered") {
          await this.consumeAnswer(userId, promptId);
          this.releaseAttachments(userId, attachments);
          return { text: row.answer?.text ?? "" };
        }
        if (row.status === "expired" || row.expired) {
          this.settleExpired(userId, promptId, row, attachments);
        }
        await signal.wait(
          Math.min(WAKE_POLL_INTERVAL_MS, Number(row.remaining_ms)),
        );
      }
    } finally {
      options.signal?.removeEventListener("abort", onClose);
      unsubscribe();
    }
  }

  /** Give up on a turn whose deadline passed, with the reason the copy needs. */
  private settleExpired(
    userId: string,
    promptId: string,
    row: PromptStateRow,
    attachments: RelayAttachmentRef[],
  ): never {
    // Distinguish "an agent took it then went quiet" from "no agent ever picked
    // it up": the controller maps the two to different user-facing copy, and a
    // claimed turn's answer is still recoverable via the pickup endpoint if the
    // agent comes back and posts within the grace window.
    if (row.claimed_at) {
      this.logger.warn(
        `Relay prompt ${promptId} for user ${userId} went quiet after claim; ` +
          `browser gave up (a late answer is still accepted)`,
      );
      throw new RelayTimeoutError("disconnected", promptId);
    }
    // Never claimed: no agent will ever read these attachments, so release them
    // now instead of waiting for the TTL.
    this.releaseAttachments(userId, attachments);
    this.logger.warn(
      `Relay prompt ${promptId} for user ${userId} timed out with no agent response`,
    );
    throw new RelayTimeoutError("no_agent", promptId);
  }

  /** Insert the turn as `pending` and return the id the database minted. */
  private async insertPrompt(
    userId: string,
    payload: RelayPromptPayload,
  ): Promise<string> {
    const [row] = returnedRows<{ id: string }>(
      await this.relayQuery(
        `INSERT INTO ai_relay_prompts (user_id, prompt, expires_at)
         VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + ${msInterval("$3")})
         RETURNING id`,
        [userId, JSON.stringify(payload), QUEUE_WAIT_MS],
      ),
    );
    return row.id;
  }

  /** Re-read the turn's state. JSONB comes back as an object; never parsed. */
  private async readPrompt(
    userId: string,
    promptId: string,
  ): Promise<PromptStateRow | undefined> {
    const [row] = returnedRows<PromptStateRow>(
      await this.relayQuery(
        `SELECT status, answer, prompt, claimed_at,
                (expires_at <= CURRENT_TIMESTAMP) AS expired,
                CEIL(
                  EXTRACT(EPOCH FROM (expires_at - CURRENT_TIMESTAMP)) * 1000
                )::bigint AS remaining_ms
           FROM ai_relay_prompts
          WHERE id = $1 AND user_id = $2`,
        [promptId, userId],
      ),
    );
    return row;
  }

  /**
   * Take the oldest live `pending` turn for this user, if any.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes two agents polling one user claim
   * different prompts instead of queueing on the same row, and the `UPDATE`'s
   * `WHERE status = 'pending'` is what makes exactly one of them win
   * (INV-HA-005).
   */
  private async claimNextPrompt(
    userId: string,
    sessionId?: string,
  ): Promise<RelayClaimedPrompt | null> {
    const [row] = returnedRows<{ id: string; prompt: RelayPromptPayload }>(
      await this.relayQuery(
        `WITH next AS (
           SELECT id AS next_id
             FROM ai_relay_prompts
            WHERE user_id = $1
              AND status = 'pending'
              AND expires_at > CURRENT_TIMESTAMP
            ORDER BY created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE ai_relay_prompts
            SET status = 'claimed',
                claimed_at = CURRENT_TIMESTAMP,
                claimed_by = $2,
                expires_at = CURRENT_TIMESTAMP + ${msInterval("$3")}
           FROM next
          WHERE ai_relay_prompts.id = next.next_id
         RETURNING id, prompt`,
        [userId, sessionId ?? null, IDLE_TIMEOUT_MS],
      ),
    );
    if (!row) {
      return null;
    }
    // Claiming a prompt is activity: restart the inactivity clock.
    this.idleSince.delete(userId);
    return {
      promptId: row.id,
      prompt: row.prompt.prompt,
      history: row.prompt.history,
      ...(row.prompt.attachments?.length
        ? { attachments: row.prompt.attachments }
        : {}),
    };
  }

  /**
   * Record the answer. Conditional on `claimed`, so a second post -- or one for
   * a turn the sweeper already expired -- matches nothing and is refused.
   */
  private async writeAnswer(
    userId: string,
    promptId: string,
    answer: RelayAnswerPayload,
  ): Promise<boolean> {
    const rows = returnedRows<{ id: string }>(
      await this.relayQuery(
        `UPDATE ai_relay_prompts
            SET status = 'answered',
                answer = $3::jsonb,
                answered_at = CURRENT_TIMESTAMP
          WHERE id = $1
            AND user_id = $2
            AND status = 'claimed'
            AND expires_at + ${msInterval("$4")} > CURRENT_TIMESTAMP
         RETURNING id`,
        [promptId, userId, JSON.stringify(answer), BUFFER_TTL_MS],
      ),
    );
    return rows.length > 0;
  }

  /**
   * Hand the answer over exactly once. The turn ends here: `expired` is what
   * "the browser has this" looks like on the row, and the sweeper deletes it.
   */
  private async consumeAnswer(
    userId: string,
    promptId: string,
  ): Promise<RelayResponse | null> {
    const [row] = returnedRows<{ answer: RelayAnswerPayload | null }>(
      await this.relayQuery(
        `UPDATE ai_relay_prompts
            SET status = 'expired'
          WHERE id = $1 AND user_id = $2 AND status = 'answered'
         RETURNING answer`,
        [promptId, userId],
      ),
    );
    return row ? { text: row.answer?.text ?? "" } : null;
  }

  /**
   * Push this session's claimed turn's deadline out and return its id.
   *
   * The clamp against `claimed_at + HARD_WAIT_MS` is the backstop: a
   * perpetually-chatty-but-stuck agent still loses the browser. A turn already
   * past its deadline is not revived -- `expires_at > CURRENT_TIMESTAMP` is
   * what keeps liveness from resurrecting a turn the browser has given up on.
   */
  private async bumpLiveness(
    userId: string,
    sessionId?: string,
  ): Promise<string | null> {
    const [row] = returnedRows<{ id: string }>(
      await this.relayQuery(
        `UPDATE ai_relay_prompts
            SET expires_at = LEAST(
                  CURRENT_TIMESTAMP + ${msInterval("$3")},
                  claimed_at + ${msInterval("$4")}
                )
          WHERE user_id = $1
            AND status = 'claimed'
            AND claimed_by IS NOT DISTINCT FROM $2
            AND expires_at > CURRENT_TIMESTAMP
         RETURNING id`,
        [userId, sessionId ?? null, IDLE_TIMEOUT_MS, HARD_WAIT_MS],
      ),
    );
    return row?.id ?? null;
  }

  /**
   * Bind this turn to the calling session and count the call as liveness.
   *
   * An agent that reconnected mid-turn arrives with a fresh MCP session id;
   * without the adoption its own later writes would look like a different
   * session's and confirm in the wrong place.
   */
  private async adoptAndBump(
    userId: string,
    promptId: string,
    sessionId?: string,
  ): Promise<boolean> {
    const rows = returnedRows<{ id: string }>(
      await this.relayQuery(
        `UPDATE ai_relay_prompts
            SET claimed_by = COALESCE($3, claimed_by),
                expires_at = LEAST(
                  CURRENT_TIMESTAMP + ${msInterval("$4")},
                  claimed_at + ${msInterval("$5")}
                )
          WHERE id = $1
            AND user_id = $2
            AND status = 'claimed'
            AND expires_at > CURRENT_TIMESTAMP
         RETURNING id`,
        [promptId, userId, sessionId ?? null, IDLE_TIMEOUT_MS, HARD_WAIT_MS],
      ),
    );
    return rows.length > 0;
  }

  /**
   * The turn this session is handling, or has just lost the browser for.
   *
   * Three things this deliberately is NOT:
   *  - not connection liveness. An agent merely parked on `get_next_prompt`
   *    has claimed nothing, so a write arriving then is a direct client's and
   *    must confirm there.
   *  - not user-wide. A relay turn belongs to the session that claimed it;
   *    another session's write is not part of it. Matching on userId alone let
   *    one abandoned web-chat turn capture every direct write the same user
   *    made afterwards.
   *  - not unbounded in time. A turn past its deadline stands in for a live one
   *    only for as long as its answer would still be accepted.
   */
  private async findSessionTurn(
    userId: string,
    sessionId?: string,
  ): Promise<string | null> {
    const [row] = returnedRows<{ id: string }>(
      await this.relayQuery(
        `SELECT id
           FROM ai_relay_prompts
          WHERE user_id = $1
            AND status = 'claimed'
            AND claimed_by IS NOT DISTINCT FROM $2
            AND expires_at + ${msInterval("$3")} > CURRENT_TIMESTAMP
          ORDER BY claimed_at DESC
          LIMIT 1`,
        [userId, sessionId ?? null, BUFFER_TTL_MS],
      ),
    );
    return row?.id ?? null;
  }

  /**
   * Every relay statement runs in its own short transaction, outside whatever
   * transaction the caller happens to be in.
   *
   * Both halves matter. A queued prompt has to be visible to an agent polling a
   * different replica the moment `enqueuePrompt` parks, and a row written inside
   * the caller's transaction is not. And a waiter parks for minutes: joining an
   * ambient transaction would hold that connection, and its snapshot, for the
   * whole wait.
   */
  private relayQuery(sql: string, params: unknown[]): Promise<unknown> {
    return runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager: EntityManager) =>
        manager.query(sql, params),
      ),
    );
  }

  /** Wake every replica holding a stream or a poll for this user. */
  private async publishWake(userId: string, promptId: string): Promise<void> {
    // Ids only: the payload crosses replicas outside RLS, and the recipient
    // reads the row back under its own scope.
    await this.bus.publish(relayChannel(userId), { userId, promptId });
  }

  // ------------------------------------------------------- the action buffer

  /** Store a late confirmation card for pickup, enforcing TTL and the per-user cap. */
  private bufferAction(userId: string, action: PendingAiAction): void {
    this.pruneActionBuffer(userId);
    const existing =
      this.bufferedActions.get(userId) ?? new Map<string, BufferedAction>();
    const next = new Map(existing);
    next.set(action.actionId, { action, at: Date.now() });
    // Evict oldest entries (by emit time) until within the per-user cap.
    if (next.size > MAX_BUFFERED_PER_USER) {
      const ordered = [...next.entries()].sort((a, b) => a[1].at - b[1].at);
      const trimmed = ordered.slice(next.size - MAX_BUFFERED_PER_USER);
      this.bufferedActions.set(userId, new Map(trimmed));
    } else {
      this.bufferedActions.set(userId, next);
    }
    this.logger.warn(
      `Relay confirmation card ${action.actionId} for user ${userId} emitted ` +
        `after the stream gave up; buffered for pickup`,
    );
  }

  /** Drop expired buffered cards for a user; clean up the empty bucket. */
  private pruneActionBuffer(userId: string): void {
    const userBuffer = this.bufferedActions.get(userId);
    if (!userBuffer) {
      return;
    }
    const cutoff = Date.now() - BUFFER_TTL_MS;
    const live = [...userBuffer.entries()].filter(([, v]) => v.at >= cutoff);
    if (live.length === 0) {
      this.bufferedActions.delete(userId);
    } else if (live.length !== userBuffer.size) {
      this.bufferedActions.set(userId, new Map(live));
    }
  }

  /** Eagerly drop a settled turn's attachments from the store (TTL backstop). */
  private releaseAttachments(
    userId: string,
    attachments: RelayAttachmentRef[],
  ): void {
    if (attachments.length === 0) {
      return;
    }
    this.attachmentStore.releaseForPrompt(
      userId,
      attachments.map((a) => a.id),
    );
  }
}

/**
 * Thrown when the browser gives up on a relay prompt. `reason` tells the
 * controller which copy to show: `no_agent` (never claimed) vs `disconnected`
 * (an agent claimed it then fell silent). `promptId` lets the browser try the
 * pickup endpoint for a late answer.
 */
export class RelayTimeoutError extends Error {
  constructor(
    readonly reason: "no_agent" | "disconnected",
    readonly promptId: string,
  ) {
    super(
      reason === "disconnected"
        ? "AI relay: your assistant went quiet before answering"
        : "AI relay timed out: no response from your assistant",
    );
    this.name = "RelayTimeoutError";
  }
}

/**
 * Thrown when the browser's socket closed while its turn was still running.
 *
 * Not a failure of the turn: the row is left exactly as it was, so the agent
 * may still answer it and the pickup endpoint serves that answer when the
 * browser returns. It exists so the waiter stops immediately instead of holding
 * a connection and a poll for a socket that is gone.
 */
export class RelayStreamClosedError extends Error {
  constructor(readonly promptId: string) {
    super("AI relay: the browser stream closed before the answer arrived");
    this.name = "RelayStreamClosedError";
  }
}
