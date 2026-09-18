import { DataSource } from "typeorm";
import { TestingModule } from "@nestjs/testing";

import { AiRelayService } from "@/ai/relay/ai-relay.service";
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
  let userId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    db = module.get(DataSource);
    userId = (
      await createTestUserDirect(db, { email: "relay-claim@test.local" })
    ).id;
    relay = new AiRelayService(
      db,
      new RelayAttachmentStore(),
      new RelayStreamRegistry(),
      new MemoryEventBus(),
    );
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM ai_relay_prompts");
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
});
