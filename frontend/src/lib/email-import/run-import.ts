import { emailReceiptsApi } from "@/lib/email-receipts-api";
import type {
  EmailReceiptImportFileResult,
  EmailReceiptImportResult,
} from "@/types/email-receipts";
import type { PlanNote } from "./build-plan";
import type { UploadPart } from "./upload-plan";

/** How many times one request is retried after a 429. */
export const MAX_RATE_LIMIT_RETRIES = 6;
/** The wait when a 429 names none. */
export const DEFAULT_RETRY_WAIT_MS = 10_000;
/** A server asking for more than this is waited for this long, then asked again. */
const MAX_RETRY_WAIT_MS = 120_000;

export type ImportRunStatus = "complete" | "cancelled" | "failed";

export interface ImportRunOutcome {
  /** Everything the requests that succeeded imported, summed under the selected file names. */
  result: EmailReceiptImportResult;
  status: ImportRunStatus;
  /** The error that stopped the run; `null` unless `status` is `failed`. */
  error: unknown;
  /** Requests that succeeded. */
  completed: number;
  total: number;
}

export interface ImportRunOptions {
  signal?: AbortSignal;
  /** Called with the number of finished requests, before the first and after each. */
  onProgress?: (done: number, total: number) => void;
  /** Injectable for tests. Resolves after `ms`, or at once when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function responseOf(
  error: unknown,
): { status?: number; headers?: unknown } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response = (error as { response?: unknown }).response;
  return typeof response === "object" && response !== null
    ? response
    : undefined;
}

export function isRateLimited(error: unknown): boolean {
  return responseOf(error)?.status === 429;
}

/** The wait a 429 asks for (`Retry-After` in seconds), else the default. */
export function retryWaitMs(error: unknown): number {
  const headers = responseOf(error)?.headers as
    | { get?: (name: string) => unknown; [key: string]: unknown }
    | undefined;
  const raw =
    headers?.["retry-after"] ??
    headers?.["Retry-After"] ??
    headers?.get?.("retry-after");
  const seconds =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_WAIT_MS;
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_WAIT_MS);
}

/** Sums per-file entries under their origin name; results come in order of first appearance. */
class ResultMerger {
  private readonly files = new Map<string, EmailReceiptImportFileResult>();
  private truncated = 0;
  private processed = 0;
  private busy = false;

  add(origin: string, entry: EmailReceiptImportFileResult): void {
    const known = this.files.get(origin);
    if (!known) {
      this.files.set(origin, { ...entry, name: origin });
      return;
    }
    this.files.set(origin, {
      name: origin,
      format: known.format ?? entry.format,
      messages: known.messages + entry.messages,
      stored: known.stored + entry.stored,
      duplicates: known.duplicates + entry.duplicates,
      skipped: known.skipped + entry.skipped,
      ignoredEntries: known.ignoredEntries + entry.ignoredEntries,
      error: known.error ?? entry.error,
    });
  }

  addResponse(
    parts: readonly UploadPart[],
    response: EmailReceiptImportResult,
  ): void {
    // The server answers in the order it was sent; a count that differs falls back to names.
    const byOrder = response.files.length === parts.length;
    const byName = new Map(parts.map((part) => [part.file.name, part.origin]));
    response.files.forEach((entry, index) => {
      const origin = byOrder
        ? parts[index].origin
        : (byName.get(entry.name) ?? entry.name);
      this.add(origin, entry);
    });
    this.truncated += response.truncated;
    this.processed += response.processed;
    this.busy = this.busy || response.busy;
  }

  result(): EmailReceiptImportResult {
    return {
      files: [...this.files.values()],
      truncated: this.truncated,
      processed: this.processed,
      busy: this.busy,
    };
  }
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * Sends the requests one after another and merges what each one imported. A 429
 * waits and retries; any other failure stops the run and returns what was already
 * imported, with the error. A cancel (the signal) is honoured between requests.
 */
export async function runImport(
  requests: readonly (readonly UploadPart[])[],
  options: ImportRunOptions = {},
): Promise<ImportRunOutcome> {
  const { signal, onProgress, sleep = defaultSleep } = options;
  const merger = new ResultMerger();
  const total = requests.length;
  let completed = 0;
  onProgress?.(0, total);

  for (const parts of requests) {
    if (aborted(signal)) {
      return {
        result: merger.result(),
        status: "cancelled",
        error: null,
        completed,
        total,
      };
    }
    let attempt = 0;
    for (;;) {
      try {
        const response = await emailReceiptsApi.mailbox.import(
          parts.map((part) => part.file),
        );
        merger.addResponse(parts, response);
        completed += 1;
        onProgress?.(completed, total);
        break;
      } catch (error) {
        if (!isRateLimited(error) || attempt >= MAX_RATE_LIMIT_RETRIES) {
          return {
            result: merger.result(),
            status: "failed",
            error,
            completed,
            total,
          };
        }
        attempt += 1;
        await sleep(retryWaitMs(error), signal);
        if (aborted(signal)) {
          return {
            result: merger.result(),
            status: "cancelled",
            error: null,
            completed,
            total,
          };
        }
      }
    }
  }
  return {
    result: merger.result(),
    status: "complete",
    error: null,
    completed,
    total,
  };
}

/**
 * Adds what planning found to the merged result: archive entries the browser
 * skipped, and an entry for a file that never reached the server (a damaged
 * archive, or one holding no mail).
 */
export function withPlanNotes(
  result: EmailReceiptImportResult,
  notes: readonly PlanNote[],
): EmailReceiptImportResult {
  const files = result.files.map((file) => ({ ...file }));
  for (const note of notes) {
    const known = files.find((file) => file.name === note.origin);
    if (known) {
      known.ignoredEntries += note.ignoredEntries;
      continue;
    }
    if (
      note.error === null &&
      note.oversizedMessages > 0 &&
      note.ignoredEntries === 0
    )
      continue;
    files.push({
      name: note.origin,
      format: note.error ? null : "zip",
      messages: 0,
      stored: 0,
      duplicates: 0,
      skipped: 0,
      ignoredEntries: note.ignoredEntries,
      error: note.error ?? "empty",
    });
  }
  return { ...result, files };
}
