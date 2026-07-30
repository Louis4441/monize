import {
  PROGRESS_MIN_INTERVAL_MS,
  throttleProgress,
} from "./progress-throttle";

describe("throttleProgress", () => {
  let clock: number;
  let reported: Array<{ processed: number; total: number }>;
  const now = (): number => clock;

  const report = jest.fn(
    async (progress: { processed: number; total: number }) => {
      reported.push({ processed: progress.processed, total: progress.total });
    },
  );

  const throttled = (intervalMs = 1000) =>
    throttleProgress(report as never, intervalMs, now);

  beforeEach(() => {
    clock = 0;
    reported = [];
    report.mockClear();
  });

  it("reports the first chunk immediately, so the bar starts moving", async () => {
    const send = throttled();

    await send({ phase: "transactions", processed: 500, total: 37000 });

    expect(reported).toEqual([{ processed: 500, total: 37000 }]);
  });

  it("drops the chunks that arrive inside one interval", async () => {
    // 74 chunk reports over a few seconds is the real shape; the wizard polls
    // every 1500 ms, so all but a handful are overwritten unread -- and each
    // one costs a second pool connection while the import transaction is open.
    const send = throttled();

    for (let processed = 500; processed <= 5000; processed += 500) {
      clock += 50;
      await send({ phase: "transactions", processed, total: 37000 });
    }

    expect(reported).toHaveLength(1);
  });

  it("reports again once the interval has passed", async () => {
    const send = throttled();

    await send({ phase: "prices", processed: 500, total: 68000 });
    clock += 999;
    await send({ phase: "prices", processed: 1000, total: 68000 });
    clock += 1;
    await send({ phase: "prices", processed: 1500, total: 68000 });

    expect(reported).toEqual([
      { processed: 500, total: 68000 },
      { processed: 1500, total: 68000 },
    ]);
  });

  it("always reports the chunk that completes a phase", async () => {
    // Otherwise the bar stops short of the total it just reached, and the next
    // phase's opening report is the only thing that ever corrects it.
    const send = throttled();

    await send({ phase: "transactions", processed: 500, total: 1200 });
    clock += 10;
    await send({ phase: "transactions", processed: 1000, total: 1200 });
    clock += 10;
    await send({ phase: "transactions", processed: 1200, total: 1200 });

    expect(reported).toEqual([
      { processed: 500, total: 1200 },
      { processed: 1200, total: 1200 },
    ]);
  });

  it("reports a phase whose only chunk is also its last", async () => {
    const send = throttled();
    // Consume the free first report, then run a short phase inside the window.
    await send({ phase: "transactions", processed: 10, total: 10 });
    clock += 5;

    await send({ phase: "bills", processed: 3, total: 3 });

    expect(reported).toHaveLength(2);
  });

  it("does not treat an empty phase as a completed one", async () => {
    const send = throttled();
    await send({ phase: "prices", processed: 500, total: 68000 });
    clock += 5;

    await send({ phase: "prices", processed: 0, total: 0 });

    expect(reported).toHaveLength(1);
  });

  it("throttles below the wizard's poll interval, so no tick is starved", () => {
    // The wizard polls every 1500 ms (MNY_POLL_INTERVAL_MS). A throttle at or
    // above that would let a poll find the same numbers twice.
    expect(PROGRESS_MIN_INTERVAL_MS).toBeLessThan(1500);
  });
});
