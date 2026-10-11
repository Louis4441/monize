import { Injectable } from "@nestjs/common";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { TrackedProviderId } from "../provider-health/providers";
import { BondFetch } from "./bond-adapter";

export type HttpFetch = typeof globalThis.fetch;

export const SERIES_FETCH_TIMEOUT_MS = 30_000;
/** The largest body read: the issue letter PDF; an HTML page is far smaller. */
export const SERIES_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** A body that ran past the cap: the read stopped and nothing was returned. */
export class SeriesBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The response body is larger than ${maxBytes} bytes`);
    this.name = "SeriesBodyTooLargeError";
  }
}

/**
 * The whole body as bytes, read as a stream with a hard cap: the declared length
 * is refused before a byte is read, and a body that does not declare one (or
 * lies) is cancelled the moment the running total passes `maxBytes`, so an
 * oversized or endless answer never sits in memory.
 */
export async function readCapped(
  response: Pick<Response, "body" | "headers">,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new SeriesBodyTooLargeError(maxBytes);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SeriesBodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * The network door of a series fetch. An adapter is a pure function of what this
 * returns, so the redirect rule, the size cap and the timeout live here and the
 * breaker gates every request.
 *
 * A redirect is never followed: the answer is returned with its 3xx status (the
 * adapter refuses anything but 200, so a redirect off the issuer's host is never
 * requested), and `url` is the address that was asked.
 */
@Injectable()
export class SeriesHttp {
  constructor(private readonly health: ProviderHealthService) {}

  /**
   * The fetch an adapter receives, behind the provider's circuit breaker: a
   * refusal throws before any socket is opened, a transport failure is counted,
   * and success is recorded only once the whole body has arrived.
   */
  gated(providerId: TrackedProviderId, http?: HttpFetch): BondFetch {
    return async (url) => {
      const admission = this.health.assertAvailable(providerId);
      let status: number;
      let body: Uint8Array;
      let finalUrl: string;
      try {
        const init = {
          redirect: "manual" as const,
          signal: AbortSignal.timeout(SERIES_FETCH_TIMEOUT_MS),
        };
        // A test injects `http`; production calls the global fetch here, in the
        // one place provider-call.guard.spec.ts scans for its breaker.
        const response = http ? await http(url, init) : await fetch(url, init);
        status = response.status;
        finalUrl = response.url || url;
        body = await readCapped(response, SERIES_MAX_BODY_BYTES);
      } catch (error) {
        const counted = this.health.recordFailure(providerId, error);
        if (!counted && admission === "probe")
          this.health.releaseProbe(providerId);
        throw error;
      }
      this.health.recordSuccess(providerId);
      return { status, body, url: finalUrl };
    };
  }
}
