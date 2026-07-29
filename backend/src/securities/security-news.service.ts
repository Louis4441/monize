import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { UserPreference } from "../users/entities/user-preference.entity";
import { SecuritiesService } from "./securities.service";
import { YahooFinanceService, SecurityNewsItem } from "./yahoo-finance.service";
import { DEFAULT_QUOTE_PROVIDER } from "./providers/quote-provider.registry";
import { QuoteProviderName } from "./providers/quote-provider.interface";

/** An image fetched for a news thumbnail. */
export interface FetchedThumbnail {
  data: Buffer;
  contentType: string;
}

export interface SecurityNewsResult {
  /**
   * The provider the headlines came from, or null when the security's effective
   * provider supplies none. The UI needs the difference: "nothing was published"
   * and "we cannot ask" are not the same statement.
   */
  provider: QuoteProviderName | null;
  items: SecurityNewsItem[];
}

/** One symbol's headlines, plus the upstream image addresses behind them. */
interface CachedNews {
  fetchedAt: number;
  items: SecurityNewsItem[];
  /** `itemId -> upstream thumbnail URL`, never sent to the browser. */
  thumbnails: Map<string, string>;
}

/**
 * Headlines for a security.
 *
 * Nothing is stored in the database. News is worth reading for an hour and is
 * not the user's data, so a table would mean a migration, a cron, a staleness
 * rule and a support-backup classification for something the provider will hand
 * back on request. It is fetched on demand and held in memory for a few minutes
 * instead, which is enough to stop a reader switching tabs from re-asking Yahoo
 * every time.
 *
 * Only Yahoo supplies news. That is not just because MSN's client here has no
 * news call: a security set to MSN may carry a symbol Yahoo does not know, and
 * asking Yahoo anyway risks headlines about a different company, which is worse
 * than none. So the provider is resolved first and the answer says which one
 * spoke.
 */
@Injectable()
export class SecurityNewsService {
  private readonly logger = new Logger(SecurityNewsService.name);

  /** How long a symbol's headlines are reused before asking again. */
  private static readonly TTL_MS = 10 * 60 * 1000;
  /** Cap on cached symbols, so a large portfolio cannot grow this forever. */
  private static readonly MAX_ENTRIES = 200;
  private static readonly THUMBNAIL_TIMEOUT_MS = 6000;
  /** A list thumbnail is a few KB; cap generously against a bad upstream. */
  private static readonly THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

  /**
   * Hosts a thumbnail may be fetched from.
   *
   * The address already comes from our own cache rather than from the request,
   * so this is defence in depth: it means a change upstream cannot turn this
   * into a fetcher for arbitrary hosts.
   */
  private static readonly THUMBNAIL_HOSTS = [
    "yimg.com",
    "zenfs.com",
    "yahoo.com",
  ];

  private readonly cache = new Map<string, CachedNews>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly securitiesService: SecuritiesService,
    private readonly yahoo: YahooFinanceService,
  ) {}

  async getNews(
    userId: string,
    securityId: string,
  ): Promise<SecurityNewsResult> {
    const security = await this.securitiesService.findOne(userId, securityId);
    const provider = await this.effectiveProvider(userId, security);

    if (provider !== "yahoo") {
      return { provider: null, items: [] };
    }

    const cached = this.readCache(security.symbol);
    if (cached) return { provider: "yahoo", items: cached.items };

    const raw = await this.yahoo.fetchNews(security.symbol);
    const entry = this.buildEntry(securityId, raw);
    this.writeCache(security.symbol, entry);
    return { provider: "yahoo", items: entry.items };
  }

  /**
   * The image behind one headline, fetched server-side.
   *
   * Takes an item id rather than a URL on purpose: the address is looked up in
   * the cache, so there is no request parameter that could point this at an
   * arbitrary host. A cache that has since expired returns null, and the reader
   * simply sees a row without a picture.
   */
  async getThumbnail(
    userId: string,
    securityId: string,
    itemId: string,
  ): Promise<FetchedThumbnail | null> {
    const security = await this.securitiesService.findOne(userId, securityId);
    const url = this.cache.get(security.symbol)?.thumbnails.get(itemId);
    if (!url || !this.isAllowedThumbnailHost(url)) return null;
    return this.fetchImage(url);
  }

  private async effectiveProvider(
    userId: string,
    security: { quoteProvider: string | null },
  ): Promise<QuoteProviderName> {
    if (security.quoteProvider) {
      return security.quoteProvider as QuoteProviderName;
    }
    const preference = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return (
      (preference?.defaultQuoteProvider as QuoteProviderName | null) ??
      DEFAULT_QUOTE_PROVIDER
    );
  }

  /**
   * Swap each upstream thumbnail address for a path on our own API, keeping the
   * original where only this process can reach it. The CSP is
   * `img-src 'self' data: blob:`, and beyond that the reader's browser has no
   * business announcing itself to a publisher's CDN.
   */
  private buildEntry(
    securityId: string,
    raw: readonly SecurityNewsItem[],
  ): CachedNews {
    const thumbnails = new Map<string, string>();
    const items = raw.map((item) => {
      if (!item.thumbnailUrl) return { ...item, thumbnailUrl: null };
      thumbnails.set(item.id, item.thumbnailUrl);
      return {
        ...item,
        thumbnailUrl: `/api/v1/securities/${securityId}/news/${encodeURIComponent(item.id)}/thumbnail`,
      };
    });
    return { fetchedAt: Date.now(), items, thumbnails };
  }

  private readCache(symbol: string): CachedNews | null {
    const entry = this.cache.get(symbol);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > SecurityNewsService.TTL_MS) {
      this.cache.delete(symbol);
      return null;
    }
    return entry;
  }

  private writeCache(symbol: string, entry: CachedNews): void {
    // Oldest insertion first in a Map, so the first key is the one to drop.
    if (this.cache.size >= SecurityNewsService.MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(symbol, entry);
  }

  private isAllowedThumbnailHost(url: string): boolean {
    try {
      const { protocol, hostname } = new URL(url);
      if (protocol !== "https:") return false;
      return SecurityNewsService.THUMBNAIL_HOSTS.some(
        (host) => hostname === host || hostname.endsWith(`.${host}`),
      );
    } catch {
      return false;
    }
  }

  /**
   * Best-effort image fetch. Null on any failure -- a missing picture costs the
   * row an image, and nothing else on the page should notice.
   */
  private async fetchImage(url: string): Promise<FetchedThumbnail | null> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(SecurityNewsService.THUMBNAIL_TIMEOUT_MS),
        // No redirects: a redirect could leave the allowlist behind.
        redirect: "error",
      });
      if (!response.ok) return null;

      const contentType = (response.headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!contentType.startsWith("image/")) return null;

      const buffer = Buffer.from(await response.arrayBuffer());
      if (
        buffer.length === 0 ||
        buffer.length > SecurityNewsService.THUMBNAIL_MAX_BYTES
      ) {
        return null;
      }
      return { data: buffer, contentType };
    } catch (error) {
      this.logger.warn(
        `News thumbnail fetch failed: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }
}
