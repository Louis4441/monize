import { DataSource } from "typeorm";
import { TestingModule } from "@nestjs/testing";

import {
  AiRelayService,
  INACTIVITY_TIMEOUT_MS,
} from "@/ai/relay/ai-relay.service";
import { RelaySweeperService } from "@/ai/relay/relay-sweeper.service";
import { RelayAttachmentStore } from "@/ai/relay/relay-attachment.store";
import { RelayStreamRegistry } from "@/ai/relay/relay-stream.registry";
import { MemoryEventBus } from "@/common/events/memory-event-bus";
import { withUserContext } from "@/common/db/with-context";

import {
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The relay queue's concurrency, against a real database.
 *
 * Both properties INV-HA-005 rests on belong to PostgreSQL, not to the service:
 * `FOR UPDATE SKIP LOCKED` is what makes a second agent take a different prompt
 * instead of queueing behind the first, and the conditional `UPDATE ... WHERE
 * status = 'claimed'` is what makes the loser of a double `post_response` learn
 * it lost. A unit spec with a mocked manager can express either and prove
 * neither (VER-001), so the contended row here is locked by a second,
 * uncommitted connection while the service's own statement runs.
 */
describe("AI relay claim (real PostgreSQL)", () => {
  let module: TestingModule;
  let db: DataSource;
  let relay: AiRelayService;
  let sweeper: RelaySweeperService;
  let attachments: RelayAttachmentStore;
  let userId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    db = module.get(DataSource);
    userId = (
      await createTestUserDirect(db, { email: "relay-claim@test.local" })
    ).id;
    attachments = new RelayAttachmentStore(db);
    relay = new AiRelayService(
      db,
      attachments,
      new RelayStreamRegistry(),
      new MemoryEventBus(),
    );
    sweeper = new RelaySweeperService(db, attachments);
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM ai_relay_prompts");
    await db.query("DELETE FROM ai_relay_actions");
    await db.query("DELETE FROM ai_relay_agents");
    await db.query("DELETE FROM ai_relay_attachments");
  });

  /**
   * Queue a turn the way the browser does, without parking on it: the waiter's
   * own loop is the unit spec's subject, and holding it open here would keep a
   * connection for the length of every test.
   */
  async function queue(prompt: string): Promise<string> {
    const [row] = await db.query(
      `INSERT INTO ai_relay_prompts (user_id, prompt, expires_at)
       VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
       RETURNING id`,
      [userId, JSON.stringify({ prompt, history: [] })],
    );
    return row.id as string;
  }

  async function statusOf(id: string): Promise<string> {
    const [row] = await db.query(
      `SELECT status FROM ai_relay_prompts WHERE id = $1`,
      [id],
    );
    return row.status as string;
  }

  it("hands one queued prompt to exactly one of two concurrent polls", async () => {
    await queue("only one");

    const [a, b] = await Promise.all([
      asUser(() => relay.waitForPrompt(userId, "session-a")),
      asUser(() => relay.waitForPrompt(userId, "session-b")),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("skips a row another transaction holds rather than queueing behind it", async () => {
    const first = await queue("first");
    const second = await queue("second");

    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      // Another replica's poll is mid-claim on the oldest row and has not
      // committed. Without SKIP LOCKED this claim would block on it for the
      // length of that transaction; with it, the agent gets on with the next
      // prompt instead.
      await runner.query(
        `SELECT id FROM ai_relay_prompts WHERE id = $1 FOR UPDATE`,
        [first],
      );

      const claimed = await asUser(() =>
        relay.waitForPrompt(userId, "session-b"),
      );
      expect(claimed?.promptId).toBe(second);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }

    expect(await statusOf(first)).toBe("pending");
  });

  it("refuses a second post_response for the same turn", async () => {
    const id = await queue("q");
    const claimed = await asUser(() =>
      relay.waitForPrompt(userId, "session-a"),
    );
    expect(claimed?.promptId).toBe(id);

    await expect(
      asUser(() => relay.postResponse(userId, id, "first")),
    ).resolves.toBe(true);
    // The row is `answered` now, so the second UPDATE matches no row at all.
    await expect(
      asUser(() => relay.postResponse(userId, id, "second")),
    ).resolves.toBe(false);

    const [row] = await db.query(
      `SELECT answer FROM ai_relay_prompts WHERE id = $1`,
      [id],
    );
    expect(row.answer).toEqual({ text: "first" });
  });

  it("refuses an answer for a turn nobody claimed", async () => {
    const id = await queue("q");
    await expect(
      asUser(() => relay.postResponse(userId, id, "x")),
    ).resolves.toBe(false);
    expect(await statusOf(id)).toBe("pending");
  });

  it("hands a late answer to the pickup endpoint exactly once", async () => {
    const id = await queue("q");
    await asUser(() => relay.waitForPrompt(userId, "session-a"));
    await asUser(() => relay.postResponse(userId, id, "late"));

    await expect(
      asUser(() => relay.takeBufferedResponse(userId, id)),
    ).resolves.toEqual({ text: "late" });
    await expect(
      asUser(() => relay.takeBufferedResponse(userId, id)),
    ).resolves.toBeNull();
    expect(await statusOf(id)).toBe("expired");
  });

  it("never claims a prompt whose deadline has already passed", async () => {
    const stale = await queue("stale");
    await db.query(
      `UPDATE ai_relay_prompts
          SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE id = $1`,
      [stale],
    );
    const live = await queue("live");

    // The deadline is compared in the database's clock, so a replica whose own
    // clock has drifted still agrees about which turns are claimable.
    const claimed = await asUser(() =>
      relay.waitForPrompt(userId, "session-a"),
    );
    expect(claimed?.promptId).toBe(live);
    expect(await statusOf(stale)).toBe("pending");
  });

  it("does not hand one user's prompt to another user's agent", async () => {
    const mine = await queue("mine");
    const other = await createTestUserDirect(db, {
      email: "relay-claim-other@test.local",
    });
    const [theirs] = await db.query(
      `INSERT INTO ai_relay_prompts (user_id, prompt, expires_at)
       VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
       RETURNING id`,
      [other.id, JSON.stringify({ prompt: "theirs", history: [] })],
    );

    const claimed = await withUserContext(other.id, () =>
      relay.waitForPrompt(other.id, "session-a"),
    );

    expect(claimed?.promptId).toBe(theirs.id);
    expect(await statusOf(mine)).toBe("pending");
  });

  describe("the agent row", () => {
    it("keeps one liveness row per user however often the agent polls", async () => {
      await queue("q");
      await asUser(() => relay.waitForPrompt(userId, "session-a"));
      await asUser(() => relay.waitForPrompt(userId, "session-a"));

      const rows = await db.query(
        `SELECT last_poll_at FROM ai_relay_agents WHERE user_id = $1`,
        [userId],
      );
      // The primary key is what stops a second replica's poll adding a second
      // liveness row for one agent.
      expect(rows).toHaveLength(1);
      expect(rows[0].last_poll_at).not.toBeNull();
    });

    it("starts the inactivity clock, then ends it and records the disconnect", async () => {
      await expect(asUser(() => relay.shouldStopForIdle(userId))).resolves.toBe(
        false,
      );
      await db.query(
        `UPDATE ai_relay_agents
            SET idle_since = CURRENT_TIMESTAMP
                             - ($2::numeric / 1000 * INTERVAL '1 second')
                             - INTERVAL '1 second'
          WHERE user_id = $1`,
        [userId, INACTIVITY_TIMEOUT_MS],
      );

      // Start, elapse and disconnect in one upsert: two replicas serving the
      // same agent's polls must not each start a clock neither finishes.
      await expect(asUser(() => relay.shouldStopForIdle(userId))).resolves.toBe(
        true,
      );
      expect(
        (await asUser(() => relay.getStatus(userId))).idleDisconnected,
      ).toBe(true);
    });
  });

  describe("buffered confirmation cards", () => {
    const card = (id: string) =>
      ({ actionId: id, descriptor: { kind: "create_transaction" } }) as never;

    async function claimedTurn(): Promise<void> {
      await queue("q");
      await asUser(() => relay.waitForPrompt(userId, "session-a"));
    }

    it("drains oldest first and only once", async () => {
      await claimedTurn();
      await asUser(() =>
        relay.emitPendingAction(userId, card("a1"), "session-a"),
      );
      await asUser(() =>
        relay.emitPendingAction(userId, card("a2"), "session-a"),
      );

      const drained = await asUser(() => relay.takeBufferedActions(userId));
      expect(drained.map((c) => c.actionId)).toEqual(["a1", "a2"]);
      await expect(
        asUser(() => relay.takeBufferedActions(userId)),
      ).resolves.toEqual([]);
    });

    it("takes an expired card with it rather than showing it late", async () => {
      await claimedTurn();
      await asUser(() =>
        relay.emitPendingAction(userId, card("a1"), "session-a"),
      );
      await db.query(
        `UPDATE ai_relay_actions
            SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'`,
      );

      await expect(
        asUser(() => relay.takeBufferedActions(userId)),
      ).resolves.toEqual([]);
      const [{ count }] = await db.query(
        `SELECT COUNT(*)::int AS count FROM ai_relay_actions`,
      );
      expect(count).toBe(0);
    });
  });

  describe("the sweep", () => {
    it("expires a turn nobody claimed, without deleting it yet", async () => {
      const id = await queue("nobody came");
      await db.query(
        `UPDATE ai_relay_prompts
            SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
          WHERE id = $1`,
        [id],
      );

      await sweeper.sweepRelayState();

      // The browser is still entitled to learn "no agent" rather than "gone".
      expect(await statusOf(id)).toBe("expired");
    });

    it("leaves a turn whose answer would still be accepted alone", async () => {
      const id = await queue("slow agent");
      await asUser(() => relay.waitForPrompt(userId, "session-a"));
      await db.query(
        `UPDATE ai_relay_prompts
            SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
          WHERE id = $1`,
        [id],
      );

      await sweeper.sweepRelayState();

      expect(await statusOf(id)).toBe("claimed");
      await expect(
        asUser(() => relay.postResponse(userId, id, "recovered")),
      ).resolves.toBe(true);
    });

    it("deletes a turn once its grace has run out", async () => {
      const id = await queue("long gone");
      await db.query(
        `UPDATE ai_relay_prompts
            SET status = 'expired',
                expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour'
          WHERE id = $1`,
        [id],
      );

      await sweeper.sweepRelayState();

      const rows = await db.query(
        `SELECT id FROM ai_relay_prompts WHERE id = $1`,
        [id],
      );
      expect(rows).toHaveLength(0);
    });

    it("drops a card past its expiry and keeps a live one", async () => {
      await queue("q");
      await asUser(() => relay.waitForPrompt(userId, "session-a"));
      await asUser(() =>
        relay.emitPendingAction(
          userId,
          { actionId: "live", descriptor: {} } as never,
          "session-a",
        ),
      );
      await db.query(
        `INSERT INTO ai_relay_actions (user_id, id, card, expires_at)
         VALUES ($1, 'stale', '{}'::jsonb, CURRENT_TIMESTAMP - INTERVAL '1 minute')`,
        [userId],
      );

      await sweeper.sweepRelayState();

      const rows = await db.query(
        `SELECT id FROM ai_relay_actions WHERE user_id = $1`,
        [userId],
      );
      expect(rows.map((r: { id: string }) => r.id)).toEqual(["live"]);
    });

    it("is a no-op the second time it runs", async () => {
      const id = await queue("nobody came");
      await db.query(
        `UPDATE ai_relay_prompts
            SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
          WHERE id = $1`,
        [id],
      );

      // Idempotent by predicate, which is what makes every replica firing this
      // cron safe rather than a race.
      await sweeper.sweepRelayState();
      await sweeper.sweepRelayState();

      expect(await statusOf(id)).toBe("expired");
    });
  });

  describe("attachments", () => {
    const PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const png = (filename = "img.png") => ({
      kind: "image" as const,
      mediaType: "image/png",
      filename,
      data: PNG_BASE64,
    });

    it("round-trips the bytes, which a second replica's store reads back", async () => {
      const [ref] = await asUser(() => attachments.store(userId, [png()]));

      // A store built over the same database is what a second pod has.
      const otherReplica = new RelayAttachmentStore(db);
      const stored = await asUser(() => otherReplica.get(userId, ref.id));

      expect(stored?.filename).toBe("img.png");
      expect(Buffer.isBuffer(stored?.data)).toBe(true);
      expect(stored?.data.toString("base64")).toBe(PNG_BASE64);
    });

    it("does not resolve one user's attachment for another", async () => {
      const [ref] = await asUser(() => attachments.store(userId, [png()]));
      const other = await createTestUserDirect(db, {
        email: "relay-attachment-other@test.local",
      });

      await expect(
        withUserContext(other.id, () => attachments.get(other.id, ref.id)),
      ).resolves.toBeUndefined();
    });

    it("takes the bytes with the metadata row", async () => {
      const [ref] = await asUser(() => attachments.store(userId, [png()]));

      await asUser(() => attachments.releaseForPrompt(userId, [ref.id]));

      // The cascade is what reclaims them: no second delete to get wrong.
      const [{ count }] = await db.query(
        `SELECT COUNT(*)::int AS count FROM ai_relay_attachment_blobs`,
      );
      expect(count).toBe(0);
    });

    it("refuses a kind outside the resource's three branches", async () => {
      await expect(
        db.query(
          `INSERT INTO ai_relay_attachments
             (user_id, filename, kind, mime, size, expires_at)
           VALUES ($1, 'x', 'video', 'video/mp4', 1,
                   CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
          [userId],
        ),
      ).rejects.toThrow(/ck_ai_relay_attachments_kind/);
    });

    it("is reclaimed by the sweep once past its TTL", async () => {
      const [ref] = await asUser(() => attachments.store(userId, [png()]));
      await db.query(
        `UPDATE ai_relay_attachments
            SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
          WHERE id = $1`,
        [ref.id],
      );

      await sweeper.sweepRelayState();

      const [{ count }] = await db.query(
        `SELECT COUNT(*)::int AS count FROM ai_relay_attachments`,
      );
      expect(count).toBe(0);
    });
  });
});
