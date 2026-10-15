import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_RETRY_WAIT_MS,
  MAX_RATE_LIMIT_RETRIES,
  defaultSleep,
  retryWaitMs,
  runImport,
  withPlanNotes,
} from "./run-import";
import type { UploadPart } from "./upload-plan";
import type {
  EmailReceiptImportFileResult,
  EmailReceiptImportResult,
} from "@/types/email-receipts";

const api = vi.hoisted(() => ({ importFiles: vi.fn() }));
vi.mock("@/lib/email-receipts-api", () => ({
  emailReceiptsApi: { mailbox: { import: api.importFiles } },
}));

function part(
  name: string,
  origin: string,
  messages: number | null = 1,
): UploadPart {
  return { file: new File(["x"], name), origin, messages };
}

function entry(
  name: string,
  o: Partial<EmailReceiptImportFileResult> = {},
): EmailReceiptImportFileResult {
  return {
    name,
    format: "mbox",
    messages: 2,
    stored: 1,
    duplicates: 1,
    skipped: 0,
    ignoredEntries: 0,
    error: null,
    ...o,
  };
}

function response(
  files: EmailReceiptImportFileResult[],
  o: Partial<EmailReceiptImportResult> = {},
): EmailReceiptImportResult {
  return { files, truncated: 0, processed: 1, busy: false, ...o };
}

const tooMany = (headers?: Record<string, string>) => ({
  response: { status: 429, headers },
});
const noSleep = () => vi.fn(async (_ms: number, _signal?: AbortSignal) => {});

describe("runImport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the requests in order and sums the entries under the origin name", async () => {
    api.importFiles
      .mockResolvedValueOnce(
        response(
          [
            entry("big-1.mbox", { skipped: 1, ignoredEntries: 2 }),
            entry("m.eml", { format: "eml", messages: 1 }),
          ],
          {
            truncated: 3,
            processed: 4,
          },
        ),
      )
      .mockResolvedValueOnce(
        response(
          [
            entry("big-2.mbox", { error: "empty", format: null }),
            entry("x", { error: "invalid_archive" }),
          ],
          {
            busy: true,
            processed: 2,
            truncated: 1,
          },
        ),
      );
    const requests = [
      [part("big-1.mbox", "big.mbox"), part("m.eml", "m.eml", null)],
      [part("big-2.mbox", "big.mbox"), part("x", "big.mbox")],
    ];
    const progress: Array<[number, number]> = [];
    const out = await runImport(requests, {
      onProgress: (d, t) => progress.push([d, t]),
    });

    expect(out.status).toBe("complete");
    expect(out.error).toBeNull();
    expect(
      api.importFiles.mock.calls.map((c) => c[0].map((f: File) => f.name)),
    ).toEqual([
      ["big-1.mbox", "m.eml"],
      ["big-2.mbox", "x"],
    ]);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect(out.result.files).toEqual([
      {
        name: "big.mbox",
        format: "mbox",
        messages: 6,
        stored: 3,
        duplicates: 3,
        skipped: 1,
        ignoredEntries: 2,
        error: "empty",
      },
      entry("m.eml", { format: "eml", messages: 1 }),
    ]);
    expect(out.result.truncated).toBe(4);
    expect(out.result.processed).toBe(6);
    expect(out.result.busy).toBe(true);
  });

  it("falls back to the returned names when the server answers a different number of files", async () => {
    api.importFiles.mockResolvedValueOnce(response([entry("a-1.mbox")]));
    const out = await runImport([
      [part("a-1.mbox", "a.mbox"), part("a-2.mbox", "a.mbox")],
    ]);
    expect(out.result.files.map((f) => f.name)).toEqual(["a.mbox"]);
  });

  it("returns an empty result for no requests", async () => {
    const out = await runImport([]);
    expect(out).toMatchObject({ status: "complete", completed: 0, total: 0 });
    expect(out.result).toEqual({
      files: [],
      truncated: 0,
      processed: 0,
      busy: false,
    });
    expect(api.importFiles).not.toHaveBeenCalled();
  });

  it("waits for Retry-After on a 429 and retries the same request", async () => {
    api.importFiles
      .mockRejectedValueOnce(tooMany({ "retry-after": "7" }))
      .mockResolvedValueOnce(response([entry("a.eml")]));
    const sleep = noSleep();
    const out = await runImport([[part("a.eml", "a.eml")]], { sleep });
    expect(out.status).toBe("complete");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBe(7000);
    expect(api.importFiles).toHaveBeenCalledTimes(2);
  });

  it("waits 10 seconds when a 429 names no wait", async () => {
    api.importFiles
      .mockRejectedValueOnce(tooMany())
      .mockResolvedValueOnce(response([entry("a.eml")]));
    const sleep = noSleep();
    await runImport([[part("a.eml", "a.eml")]], { sleep });
    expect(sleep.mock.calls[0][0]).toBe(DEFAULT_RETRY_WAIT_MS);
    expect(DEFAULT_RETRY_WAIT_MS).toBe(10_000);
  });

  it("retries up to 6 times, then stops with the error", async () => {
    api.importFiles.mockRejectedValue(tooMany());
    const sleep = noSleep();
    const out = await runImport([[part("a.eml", "a.eml")]], { sleep });
    expect(MAX_RATE_LIMIT_RETRIES).toBe(6);
    expect(api.importFiles).toHaveBeenCalledTimes(7);
    expect(sleep).toHaveBeenCalledTimes(6);
    expect(out.status).toBe("failed");
    expect(out.error).toMatchObject({ response: { status: 429 } });
  });

  it("stops at another failure and returns what was already imported", async () => {
    const failure = { response: { status: 500 } };
    api.importFiles
      .mockResolvedValueOnce(response([entry("a-1.mbox")]))
      .mockRejectedValueOnce(failure);
    const out = await runImport([
      [part("a-1.mbox", "a.mbox")],
      [part("a-2.mbox", "a.mbox")],
      [part("a-3.mbox", "a.mbox")],
    ]);
    expect(out.status).toBe("failed");
    expect(out.error).toBe(failure);
    expect(out.completed).toBe(1);
    expect(out.total).toBe(3);
    expect(api.importFiles).toHaveBeenCalledTimes(2);
    expect(out.result.files[0]).toMatchObject({ name: "a.mbox", stored: 1 });
  });

  it("cancels between requests and keeps what was imported", async () => {
    const controller = new AbortController();
    api.importFiles.mockImplementationOnce(async () => {
      controller.abort();
      return response([entry("a-1.mbox")]);
    });
    const out = await runImport(
      [[part("a-1.mbox", "a.mbox")], [part("a-2.mbox", "a.mbox")]],
      {
        signal: controller.signal,
      },
    );
    expect(out.status).toBe("cancelled");
    expect(out.completed).toBe(1);
    expect(api.importFiles).toHaveBeenCalledTimes(1);
    expect(out.result.files).toHaveLength(1);
  });

  it("does not send anything when cancelled before the first request", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await runImport([[part("a.eml", "a.eml")]], {
      signal: controller.signal,
    });
    expect(out.status).toBe("cancelled");
    expect(api.importFiles).not.toHaveBeenCalled();
  });

  it("cancels during the wait after a 429, without another attempt", async () => {
    const controller = new AbortController();
    api.importFiles.mockRejectedValue(tooMany());
    const sleep = vi.fn(async () => controller.abort());
    const out = await runImport([[part("a.eml", "a.eml")]], {
      sleep,
      signal: controller.signal,
    });
    expect(out.status).toBe("cancelled");
    expect(api.importFiles).toHaveBeenCalledTimes(1);
  });
});

describe("retryWaitMs", () => {
  it("reads seconds from a plain or a getter-style header object", () => {
    expect(retryWaitMs(tooMany({ "retry-after": "3" }))).toBe(3000);
    expect(
      retryWaitMs({ response: { status: 429, headers: { get: () => "2" } } }),
    ).toBe(2000);
    expect(retryWaitMs(tooMany({ "Retry-After": "0" }))).toBe(0);
  });

  it("uses the default for a missing, negative or non-numeric value, and bounds a huge one", () => {
    expect(retryWaitMs(tooMany())).toBe(DEFAULT_RETRY_WAIT_MS);
    expect(retryWaitMs(tooMany({ "retry-after": "-1" }))).toBe(
      DEFAULT_RETRY_WAIT_MS,
    );
    expect(
      retryWaitMs(tooMany({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })),
    ).toBe(DEFAULT_RETRY_WAIT_MS);
    expect(retryWaitMs(null)).toBe(DEFAULT_RETRY_WAIT_MS);
    expect(retryWaitMs(tooMany({ "retry-after": "99999" }))).toBe(120_000);
  });
});

describe("defaultSleep", () => {
  it("resolves after the time, and at once when aborted", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const waiting = defaultSleep(1000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(done).toBe(true);

      const controller = new AbortController();
      const aborting = defaultSleep(60_000, controller.signal);
      controller.abort();
      await aborting;
      await defaultSleep(60_000, controller.signal);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("withPlanNotes", () => {
  const base = response([
    entry("takeout.zip", { format: "zip", ignoredEntries: 1 }),
  ]);

  it("adds the entries the browser skipped to the server's count", () => {
    const out = withPlanNotes(base, [
      {
        origin: "takeout.zip",
        ignoredEntries: 4,
        oversizedMessages: 0,
        error: null,
      },
    ]);
    expect(out.files[0].ignoredEntries).toBe(5);
    expect(base.files[0].ignoredEntries).toBe(1);
  });

  it("adds an entry for a damaged archive, and for an archive with no mail", () => {
    const out = withPlanNotes(response([]), [
      {
        origin: "bad.zip",
        ignoredEntries: 0,
        oversizedMessages: 0,
        error: "invalid_archive",
      },
      {
        origin: "none.zip",
        ignoredEntries: 3,
        oversizedMessages: 0,
        error: null,
      },
    ]);
    expect(
      out.files.map((f) => [f.name, f.error, f.format, f.ignoredEntries]),
    ).toEqual([
      ["bad.zip", "invalid_archive", null, 0],
      ["none.zip", "empty", "zip", 3],
    ]);
  });

  it("adds no entry for a file whose only note is an oversized message", () => {
    const out = withPlanNotes(response([]), [
      {
        origin: "big.mbox",
        ignoredEntries: 0,
        oversizedMessages: 2,
        error: null,
      },
    ]);
    expect(out.files).toEqual([]);
  });
});
