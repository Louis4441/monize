import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { SecurityNewsService } from "./security-news.service";
import { SecuritiesService } from "./securities.service";
import { YahooFinanceService, SecurityNewsItem } from "./yahoo-finance.service";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SECURITY_ID = "22222222-2222-4222-8222-222222222222";

jest.mock("../common/db/scoped-db", () => ({
  withScopedDb: (_dataSource: unknown, fn: (m: unknown) => unknown) =>
    fn((global as never as { __manager: unknown }).__manager),
}));

describe("SecurityNewsService", () => {
  let service: SecurityNewsService;
  let securitiesService: Record<string, jest.Mock>;
  let yahoo: Record<string, jest.Mock>;
  let preferenceRepo: Record<string, jest.Mock>;

  function rawItem(
    overrides: Partial<SecurityNewsItem> = {},
  ): SecurityNewsItem {
    return {
      id: "uuid-1",
      title: "Apple says UK App Store proposal amounts to price regulation",
      publisher: "Reuters",
      link: "https://finance.yahoo.com/news/apple.html",
      publishedAt: "2026-07-29T18:00:00.000Z",
      type: "STORY",
      thumbnailUrl: "https://s.yimg.com/small.jpg",
      relatedTickers: ["AAPL"],
      ...overrides,
    };
  }

  function givenSecurity(quoteProvider: string | null = "yahoo") {
    securitiesService.findOne.mockResolvedValue({
      id: SECURITY_ID,
      symbol: "AAPL",
      quoteProvider,
    });
  }

  beforeEach(async () => {
    preferenceRepo = { findOne: jest.fn().mockResolvedValue(null) };
    (global as never as { __manager: unknown }).__manager = {
      getRepository: () => preferenceRepo,
    };
    securitiesService = { findOne: jest.fn() };
    yahoo = { fetchNews: jest.fn().mockResolvedValue([rawItem()]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityNewsService,
        { provide: DataSource, useValue: {} },
        { provide: SecuritiesService, useValue: securitiesService },
        { provide: YahooFinanceService, useValue: yahoo },
      ],
    }).compile();
    service = module.get(SecurityNewsService);
    givenSecurity();
  });

  describe("ownership", () => {
    it("checks the security before asking anyone for news", async () => {
      await service.getNews(USER_ID, SECURITY_ID);
      expect(securitiesService.findOne).toHaveBeenCalledWith(
        USER_ID,
        SECURITY_ID,
      );
    });

    it("propagates a security that is not the caller's", async () => {
      securitiesService.findOne.mockRejectedValue(new NotFoundException());
      await expect(service.getNews(USER_ID, SECURITY_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(yahoo.fetchNews).not.toHaveBeenCalled();
    });
  });

  describe("which provider is asked", () => {
    it("asks Yahoo when the security is set to it", async () => {
      const result = await service.getNews(USER_ID, SECURITY_ID);
      expect(yahoo.fetchNews).toHaveBeenCalledWith("AAPL");
      expect(result.provider).toBe("yahoo");
    });

    it("says nobody supplies news for an MSN security", async () => {
      givenSecurity("msn");
      const result = await service.getNews(USER_ID, SECURITY_ID);

      // Not merely empty: "nothing was published" and "we cannot ask" are
      // different statements, and a security on MSN may carry a symbol Yahoo
      // does not know -- headlines about another company would be worse than
      // none.
      expect(result).toEqual({ provider: null, items: [] });
      expect(yahoo.fetchNews).not.toHaveBeenCalled();
    });

    it("falls back to the user's default provider", async () => {
      givenSecurity(null);
      preferenceRepo.findOne.mockResolvedValue({ defaultQuoteProvider: "msn" });
      expect((await service.getNews(USER_ID, SECURITY_ID)).provider).toBeNull();
    });

    it("falls back to Yahoo when the user has no preference either", async () => {
      givenSecurity(null);
      preferenceRepo.findOne.mockResolvedValue(null);
      expect((await service.getNews(USER_ID, SECURITY_ID)).provider).toBe(
        "yahoo",
      );
    });
  });

  describe("thumbnails", () => {
    it("hands the browser a path on our own API, never the publisher's CDN", async () => {
      const { items } = await service.getNews(USER_ID, SECURITY_ID);
      // The CSP is `img-src 'self' data: blob:`, and beyond that the reader's
      // browser has no business announcing itself to a publisher.
      expect(items[0].thumbnailUrl).toBe(
        `/api/v1/securities/${SECURITY_ID}/news/uuid-1/thumbnail`,
      );
      expect(items[0].thumbnailUrl).not.toContain("yimg.com");
    });

    it("leaves the field null for an item with no picture", async () => {
      yahoo.fetchNews.mockResolvedValue([rawItem({ thumbnailUrl: null })]);
      const { items } = await service.getNews(USER_ID, SECURITY_ID);
      expect(items[0].thumbnailUrl).toBeNull();
    });

    it("escapes an id that would otherwise break the path", async () => {
      yahoo.fetchNews.mockResolvedValue([rawItem({ id: "a/b?c" })]);
      const { items } = await service.getNews(USER_ID, SECURITY_ID);
      expect(items[0].thumbnailUrl).toContain("a%2Fb%3Fc");
    });

    describe("fetching one", () => {
      const okImage = () =>
        ({
          ok: true,
          headers: new Map([["content-type", "image/jpeg"]]) as never,
          arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
        }) as never;

      let originalFetch: typeof global.fetch;
      beforeEach(async () => {
        originalFetch = global.fetch;
        // Populate the cache, which is where the address comes from.
        await service.getNews(USER_ID, SECURITY_ID);
      });
      afterEach(() => {
        global.fetch = originalFetch;
      });

      it("looks the address up in the cache rather than taking one from the caller", async () => {
        global.fetch = jest.fn().mockImplementation((url: string) => {
          expect(url).toBe("https://s.yimg.com/small.jpg");
          return Promise.resolve(okImage());
        });
        const image = await service.getThumbnail(
          USER_ID,
          SECURITY_ID,
          "uuid-1",
        );
        expect(image).toEqual({
          data: Buffer.from([1, 2, 3]),
          contentType: "image/jpeg",
        });
      });

      it("returns nothing for an id it never cached", async () => {
        global.fetch = jest.fn();
        expect(
          await service.getThumbnail(USER_ID, SECURITY_ID, "not-cached"),
        ).toBeNull();
        // No id from a request ever becomes a URL, so nothing is fetched.
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it("refuses a response that is not an image", async () => {
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          headers: new Map([["content-type", "text/html"]]) as never,
          arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
        } as never);
        expect(
          await service.getThumbnail(USER_ID, SECURITY_ID, "uuid-1"),
        ).toBeNull();
      });

      it("refuses an oversized payload", async () => {
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          headers: new Map([["content-type", "image/png"]]) as never,
          arrayBuffer: () =>
            Promise.resolve(new Uint8Array(3 * 1024 * 1024).buffer),
        } as never);
        expect(
          await service.getThumbnail(USER_ID, SECURITY_ID, "uuid-1"),
        ).toBeNull();
      });

      it("swallows a failed fetch, costing the row its picture and nothing else", async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error("timeout"));
        expect(
          await service.getThumbnail(USER_ID, SECURITY_ID, "uuid-1"),
        ).toBeNull();
      });

      it("refuses a host outside the allowlist", async () => {
        // Defence in depth: the address is ours, but a change upstream must not
        // turn this into a fetcher for arbitrary hosts.
        yahoo.fetchNews.mockResolvedValue([
          rawItem({
            id: "evil",
            thumbnailUrl: "https://attacker.example/x.png",
          }),
        ]);
        // A fresh symbol, so this lands in the cache rather than hitting the TTL.
        securitiesService.findOne.mockResolvedValue({
          id: SECURITY_ID,
          symbol: "OTHER",
          quoteProvider: "yahoo",
        });
        await service.getNews(USER_ID, SECURITY_ID);

        global.fetch = jest.fn();
        expect(
          await service.getThumbnail(USER_ID, SECURITY_ID, "evil"),
        ).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
      });
    });
  });

  describe("caching", () => {
    it("reuses the headlines instead of asking again on every visit", async () => {
      await service.getNews(USER_ID, SECURITY_ID);
      await service.getNews(USER_ID, SECURITY_ID);
      expect(yahoo.fetchNews).toHaveBeenCalledTimes(1);
    });

    it("asks again once the entry has gone stale", async () => {
      await service.getNews(USER_ID, SECURITY_ID);
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);
      await service.getNews(USER_ID, SECURITY_ID);
      expect(yahoo.fetchNews).toHaveBeenCalledTimes(2);
      jest.restoreAllMocks();
    });
  });
});
