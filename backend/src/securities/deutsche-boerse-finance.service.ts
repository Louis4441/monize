import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import {
  QuoteProvider,
  QuoteProviderName,
  QuoteProviderOptions,
  QuoteResult,
  SecurityLookupResult,
  HistoricalPrice,
  HistoricalSeries,
  StockSectorInfo,
  EtfSectorWeighting,
} from "./providers/quote-provider.interface";
import { getTradingDateFromQuote } from "./providers/trading-date.util";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { TrackedProviderId } from "../provider-health/providers";

/**
 * This client's id in `provider_health` and in the circuit breaker. It names the
 * host we call (`api.live.deutsche-boerse.com`) and is the primary key of the
 * durable alert state, so it must stay stable.
 */
const HEALTH_PROVIDER_ID: TrackedProviderId = "deutsche_boerse";

const DBG_API = "https://api.live.deutsche-boerse.com";
const DBG_WS = "wss://api.live.deutsche-boerse.com/v1/mds/ws";
const DBG_ORIGIN = "https://live.deutsche-boerse.com";

/** Börse Frankfurt keeps Frankfurt time; Xetra (ETR) is the primary venue. */
const DBG_TIMEZONE = "Europe/Berlin";
const DEFAULT_SOURCE = "ETR";

/**
 * The request-signing constant Börse Frankfurt's own public JavaScript uses to
 * build its `X-Client-TraceId`. It is a fixed string embedded in the site's app
 * bundle (`tracing.salt`), not a credential and not tied to any login -- the
 * page computes the anti-scraping headers client-side with it before a visitor
 * has authenticated anything. It is reproduced here so this provider signs the
 * way the browser does. The site rotates it when it rebuilds the bundle; a stale
 * value simply makes the token endpoint answer 401 and the provider return no
 * data, never a wrong number, so refreshing it is a one-line code change.
 */
const DBG_SALT = "af5a8d16eb5dc49f8a72b26fd9185475c7a";

const TOKEN_SAFETY_MARGIN_MS = 30_000;
const CURRENCY_CACHE_TTL_MS = 60_000;

/** Close the socket if no timeseries frame arrives within this idle window. */
const WS_IDLE_TIMEOUT_MS = 2_000;
/** Hard ceiling for the whole websocket exchange, whatever the stream does. */
const WS_TOTAL_TIMEOUT_MS = 20_000;

/**
 * The minimal websocket surface this provider uses, so a unit test can drive the
 * exchange with a fake instead of a real connection.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** One daily bar as a `dataTimeseries` frame carries it. */
interface DbgTimeseriesFrame {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  quantity?: number;
}

/**
 * Deutsche Börse / Börse Frankfurt historical-price provider.
 *
 * Börse Frankfurt does not serve daily history over a plain REST endpoint: its
 * price-history page streams the bars over a websocket (`/v1/mds/ws`). Reaching
 * them, reconstructed from the browser's own traffic, is:
 *
 *  1. Obtain a short-lived market-data token from `mdstokenservice/token`. Every
 *     request to the market-data host carries the same `Client-Date` /
 *     `X-Client-TraceId` / `X-Security` signature the site's own public
 *     JavaScript computes client-side (see `boerseSecurityHeaders`) -- no login,
 *     no credential. It needs no configuration.
 *  2. Open the websocket, authenticate with the token, then ask for the daily
 *     series with `listTimeseries` for a `marketstateId` built from the ISIN, the
 *     instrument's currency and the venue (`DELAYED[<isin>,<ccy>@ETR>STX]`).
 *  3. Collect the streamed `dataTimeseries` frames until the stream goes idle.
 *
 * The instrument is addressed by ISIN, and the currency the bars are in is read
 * from `/v1/data/currency` -- carried on the `HistoricalSeries` so the numbers
 * are never stored against a security in the wrong currency.
 */
@Injectable()
export class DeutscheBoerseFinanceService implements QuoteProvider {
  readonly name: QuoteProviderName = "deutsche_boerse";
  private readonly logger = new Logger(DeutscheBoerseFinanceService.name);

  private static readonly FETCH_TIMEOUT_MS = 15_000;

  /** Overridable so a unit test can inject a fake socket. */
  wsFactory: WebSocketFactory = (url) =>
    new WebSocket(url) as unknown as WebSocketLike;

  private token: string | null = null;
  private tokenExpiresAt = 0;
  private tokenPromise: Promise<string | null> | null = null;

  private readonly currencyCache = new Map<
    string,
    { value: string | null; expiresAt: number }
  >();

  constructor(private readonly health: ProviderHealthService) {}

  private async request(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const admission = this.health.assertAvailable(HEALTH_PROVIDER_ID);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        // Every call to the market-data host carries the same client-computed
        // signature the site's own JavaScript adds through its HTTP interceptor.
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...boerseSecurityHeaders(url),
        },
        signal: AbortSignal.timeout(
          DeutscheBoerseFinanceService.FETCH_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      const counted = this.health.recordFailure(HEALTH_PROVIDER_ID, error);
      if (!counted && admission === "probe") {
        this.health.releaseProbe(HEALTH_PROVIDER_ID);
      }
      throw error;
    }
    if (!response.ok) this.health.recordSuccess(HEALTH_PROVIDER_ID);
    return response;
  }

  private async readBody<T>(response: Response): Promise<T> {
    const value = (await response.json()) as T;
    this.health.recordSuccess(HEALTH_PROVIDER_ID);
    return value;
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    return {
      accept: "application/json",
      origin: DBG_ORIGIN,
      referer: `${DBG_ORIGIN}/`,
      ...extra,
    };
  }

  private async ensureToken(): Promise<string | null> {
    if (
      this.token &&
      Date.now() < this.tokenExpiresAt - TOKEN_SAFETY_MARGIN_MS
    ) {
      return this.token;
    }
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.mintToken();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  private async mintToken(): Promise<string | null> {
    try {
      const response = await this.request(
        `${DBG_API}/v1/mdstokenservice/token`,
        { headers: this.headers() },
      );
      if (!response.ok) {
        this.logger.warn(
          `Deutsche Börse token request returned ${response.status}`,
        );
        return null;
      }
      const body = await this.readBody<{ token?: string }>(response);
      if (!body.token) return null;
      this.token = body.token;
      // The token carries its own `exp` (epoch seconds); read it so the cache
      // expires with the token rather than on a fixed guess.
      this.tokenExpiresAt =
        decodeJwtExpiryMs(body.token) ?? Date.now() + 600_000;
      return this.token;
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        "Deutsche Börse market-data token",
        error,
      );
      return null;
    }
  }

  private async fetchCurrency(isin: string): Promise<string | null> {
    const key = isin.trim().toUpperCase();
    const cached = this.currencyCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    let value: string | null = null;
    try {
      const response = await this.request(
        `${DBG_API}/v1/data/currency?isin=${encodeURIComponent(key)}`,
        { headers: this.headers() },
      );
      if (response.ok) {
        const body =
          await this.readBody<Array<{ currency?: string }>>(response);
        const first = Array.isArray(body) ? body[0] : undefined;
        value =
          first?.currency && typeof first.currency === "string"
            ? first.currency.toUpperCase()
            : null;
      } else if (response.status !== 404) {
        this.logger.warn(
          `Deutsche Börse currency for ${key} returned ${response.status}`,
        );
      }
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `Deutsche Börse currency for ${key}`,
        error,
      );
      value = null;
    }
    this.currencyCache.set(key, {
      value,
      expiresAt: Date.now() + CURRENCY_CACHE_TTL_MS,
    });
    return value;
  }

  private marketstateId(
    isin: string,
    currency: string,
    source: string,
  ): string {
    return `DELAYED[${isin},${currency}@${source}>STX]`;
  }

  /**
   * Run one websocket exchange: authenticate, request the daily series for the
   * window, and resolve the streamed frames. Rejections and a socket that never
   * authenticates are counted against the breaker; a clean set of frames is a
   * success.
   */
  private async streamTimeseries(
    marketstateId: string,
    fromDate: Date,
    toDate: Date,
    token: string,
  ): Promise<DbgTimeseriesFrame[] | null> {
    const admission = this.health.assertAvailable(HEALTH_PROVIDER_ID);
    return new Promise<DbgTimeseriesFrame[] | null>((resolve) => {
      let socket: WebSocketLike;
      try {
        socket = this.wsFactory(DBG_WS);
      } catch (error) {
        const counted = this.health.recordFailure(HEALTH_PROVIDER_ID, error);
        if (!counted && admission === "probe") {
          this.health.releaseProbe(HEALTH_PROVIDER_ID);
        }
        this.logger.warn("Deutsche Börse websocket could not be opened");
        resolve(null);
        return;
      }

      const frames: DbgTimeseriesFrame[] = [];
      const requestId = "monize-ts";
      let authenticated = false;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: DbgTimeseriesFrame[] | null) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        try {
          socket.close();
        } catch {
          // A socket that never opened has nothing to close.
        }
        if (result && result.length > 0) {
          this.health.recordSuccess(HEALTH_PROVIDER_ID);
        } else {
          // No frames means the exchange did not produce an answer. Treat it
          // like a transport miss so a probe slot is not held open.
          const counted = this.health.recordFailure(
            HEALTH_PROVIDER_ID,
            new Error("no timeseries frames"),
          );
          if (!counted && admission === "probe") {
            this.health.releaseProbe(HEALTH_PROVIDER_ID);
          }
        }
        resolve(result);
      };

      const hardTimer = setTimeout(
        () => finish(frames.length ? frames : null),
        WS_TOTAL_TIMEOUT_MS,
      );

      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(frames), WS_IDLE_TIMEOUT_MS);
      };

      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            subscribeAuthentication: { token },
            requestId: "monize-auth",
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        const parsed = parseFrame(event.data);
        if (!parsed) return;
        if (parsed.dataAuthentication && !authenticated) {
          authenticated = true;
          socket.send(
            JSON.stringify({
              listTimeseries: {
                resolution: "1D",
                marketstateId,
                start: fromDate.toISOString(),
                end: toDate.toISOString(),
                cleanSplits: false,
                cleanDividends: false,
                cleanDistributions: false,
                cleanSubscriptions: false,
                quality: "DELAYED",
              },
              requestId,
            }),
          );
          armIdle();
          return;
        }
        if (parsed.dataTimeseries && parsed.requestId === requestId) {
          frames.push(parsed.dataTimeseries);
          armIdle();
        }
      });

      socket.addEventListener("error", () => {
        finish(frames.length ? frames : null);
      });

      socket.addEventListener("close", () => {
        finish(frames.length ? frames : null);
      });
    });
  }

  private async loadSeries(
    isin: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<HistoricalSeries | null> {
    const token = await this.ensureToken();
    if (!token) return null;
    const currency = await this.fetchCurrency(isin);
    if (!currency) return null;

    const marketstateId = this.marketstateId(
      isin.trim().toUpperCase(),
      currency,
      DEFAULT_SOURCE,
    );
    const frames = await this.streamTimeseries(
      marketstateId,
      fromDate,
      toDate,
      token,
    );
    if (frames == null) return null;

    const prices: HistoricalPrice[] = [];
    for (const frame of frames) {
      if (!frame.date || frame.close == null || isNaN(Number(frame.close))) {
        continue;
      }
      prices.push({
        date: new Date(`${frame.date}T00:00:00.000Z`),
        open: numOrNull(frame.open),
        high: numOrNull(frame.high),
        low: numOrNull(frame.low),
        close: Number(frame.close),
        adjClose: null,
        volume: numOrNull(frame.quantity),
      });
    }
    prices.sort((a, b) => a.date.getTime() - b.date.getTime());

    return {
      prices,
      currencyCode: currency,
      symbol: isin.trim().toUpperCase(),
      exchange: DEFAULT_SOURCE,
    };
  }

  async fetchHistoricalSeries(
    symbol: string,
    _exchange: string | null = null,
    range: string = "max",
    _opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null> {
    const toDate = new Date();
    const fromDate = rangeToStartDate(range, toDate);
    return this.loadSeries(symbol, fromDate, toDate);
  }

  async fetchHistoricalWindowSeries(
    symbol: string,
    _exchange: string | null,
    fromDate: Date,
    toDate: Date,
    _opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null> {
    return this.loadSeries(symbol, fromDate, toDate);
  }

  async fetchQuote(
    symbol: string,
    _exchange: string | null = null,
    _opts?: QuoteProviderOptions,
  ): Promise<QuoteResult | null> {
    // Börse Frankfurt streams live prices over the same socket; the newest
    // settled daily bar is a truthful, cheaper stand-in for a delayed feed.
    const toDate = new Date();
    const fromDate = new Date(toDate);
    fromDate.setUTCDate(fromDate.getUTCDate() - 10);
    const series = await this.loadSeries(symbol, fromDate, toDate);
    const last = series?.prices.length
      ? series.prices[series.prices.length - 1]
      : undefined;
    if (!series || !last) return null;
    return {
      symbol: series.symbol ?? symbol.trim().toUpperCase(),
      regularMarketPrice: last.close,
      regularMarketOpen: last.open ?? undefined,
      regularMarketDayHigh: last.high ?? undefined,
      regularMarketDayLow: last.low ?? undefined,
      regularMarketVolume: last.volume ?? undefined,
      regularMarketTime: Math.floor(last.date.getTime() / 1000),
      exchangeTimezone: DBG_TIMEZONE,
      regularSession: null,
      provider: "deutsche_boerse",
      currencyCode: series.currencyCode,
    };
  }

  async lookupSecurity(
    query: string,
    _preferredExchanges?: string[],
  ): Promise<SecurityLookupResult | null> {
    // The provider is addressed by ISIN; only an ISIN-shaped query can resolve.
    const isin = query.trim().toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return null;
    const currency = await this.fetchCurrency(isin);
    if (!currency) return null;
    return {
      symbol: isin,
      name: isin,
      exchange: DEFAULT_SOURCE,
      securityType: null,
      currencyCode: currency,
      provider: "deutsche_boerse",
    };
  }

  async fetchStockSectorInfo(): Promise<StockSectorInfo | null> {
    return null;
  }

  async fetchEtfSectorWeightings(): Promise<EtfSectorWeighting[] | null> {
    return null;
  }

  getTradingDate(quote: QuoteResult): Date {
    return getTradingDateFromQuote(quote);
  }
}

/**
 * The `Client-Date` / `X-Client-TraceId` / `X-Security` triple Börse Frankfurt's
 * own page computes client-side for every market-data request, reproduced
 * exactly (verified byte-for-byte against captured traffic):
 *
 *   Client-Date      = ISO-8601 of `now` in Europe/Berlin, to the second, with
 *                      the numeric offset ("2026-09-24T09:21:48+02:00").
 *   X-Client-TraceId = md5(Client-Date + requestUrl + salt).
 *   X-Security       = md5(now in Europe/Berlin, "yyyyMMddHHmm") -- the current
 *                      minute; no salt, no url.
 *
 * The exchange keeps Frankfurt time, so the stamps are computed in that zone
 * regardless of where the server runs. `now` is injectable for testing.
 */
export function boerseSecurityHeaders(
  url: string,
  now: Date = new Date(),
  salt: string = DBG_SALT,
): Record<string, string> {
  const p = berlinParts(now);
  const offset = berlinOffset(now, p);
  const clientDate = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
  const minuteStamp = `${p.year}${p.month}${p.day}${p.hour}${p.minute}`;
  return {
    "Client-Date": clientDate,
    "X-Client-TraceId": md5(clientDate + url + salt),
    "X-Security": md5(minuteStamp),
  };
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

interface BerlinParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

/** The wall-clock fields of an instant in Europe/Berlin, each zero-padded. */
function berlinParts(date: Date): BerlinParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: DBG_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(date)) parts[type] = value;
  // Some ICU builds render midnight as "24"; normalise it to "00".
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** The `+HH:MM` / `-HH:MM` Europe/Berlin offset for the instant (CET or CEST). */
function berlinOffset(date: Date, p: BerlinParts): string {
  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  const minutes = Math.round((asIfUtc - date.getTime()) / 60000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.trunc(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

interface ParsedFrame {
  requestId?: string;
  dataAuthentication?: unknown;
  dataTimeseries?: DbgTimeseriesFrame;
}

/** A websocket text frame to the shape this provider reads, or null. */
function parseFrame(data: unknown): ParsedFrame | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as ParsedFrame;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function numOrNull(value: number | undefined): number | null {
  return value == null || isNaN(Number(value)) ? null : Number(value);
}

/** The `exp` claim of a JWT as epoch milliseconds, or null when unreadable. */
function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf8"),
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** A named range ("max", "5y", "1y", "6mo", "1mo", "5d") to the window start. */
function rangeToStartDate(range: string, to: Date): Date {
  const start = new Date(to);
  const normalized = range.trim().toLowerCase();
  if (normalized === "max") {
    start.setUTCFullYear(start.getUTCFullYear() - 30);
    return start;
  }
  const m = /^(\d+)(d|mo|y)$/.exec(normalized);
  if (!m) {
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    return start;
  }
  const n = Number(m[1]);
  if (m[2] === "d") start.setUTCDate(start.getUTCDate() - n);
  else if (m[2] === "mo") start.setUTCMonth(start.getUTCMonth() - n);
  else start.setUTCFullYear(start.getUTCFullYear() - n);
  return start;
}
