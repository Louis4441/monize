import { GeocodingService } from "./geocoding.service";
import { CLEARED_GEOCODE_COLUMNS, geocodeColumns } from "./geocode.columns";
import { OSM_USER_AGENT } from "./osm-user-agent";

/** A Nominatim jsonv2 hit. Coordinates arrive as strings, as the real one sends them. */
const hit = (lat = "47.609722", lon = "-122.342201") => [{ lat, lon }];

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

/**
 * The service's own fetch-abort deadline, mirrored here so the timer control
 * below can tell the two kinds of timer apart.
 */
const FETCH_DEADLINE_MS = 6000;

/**
 * Take control of the timers a lookup sets, which are two different things:
 *
 *  - The **rate limiter's sleep** is time that genuinely elapses, so its
 *    callback runs and the fake clock moves by exactly the wait it asked for.
 *  - The **fetch abort deadline** never fires: the mocked fetch resolves
 *    immediately and a real run clears the timer untouched. Registering it and
 *    dropping it is what a real request that completes in time looks like.
 *
 * Firing the deadline instead -- and letting it move the clock -- is what made
 * the first version of the interval test pass with the rate limiter switched
 * off: the 6000ms it jumped swamped the 1000ms being asserted.
 *
 * `clock` is shared with a `Date.now` stub when a test measures elapsed time;
 * omitted, the sleep is simply instantaneous.
 */
function installTimerControl(clock?: { now: number }): void {
  jest.spyOn(global, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if (ms !== undefined && ms >= FETCH_DEADLINE_MS) {
      return 0 as unknown as NodeJS.Timeout;
    }
    if (clock && ms) clock.now += ms;
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
}

/** Timer control for tests that only need the sleep not to cost real seconds. */
function fastForwardRateLimit(): void {
  installTimerControl();
}

describe("GeocodingService", () => {
  let service: GeocodingService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new GeocodingService();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(GeocodingService.prototype["logger"] ?? console, "warn");
    delete process.env.NOMINATIM_URL;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("resolving an address", () => {
    it("returns the first result's coordinates as numbers", async () => {
      fetchMock.mockResolvedValue(okResponse(hit()));

      await expect(service.geocode("1912 Pike Pl, Seattle")).resolves.toEqual({
        latitude: 47.609722,
        longitude: -122.342201,
      });
    });

    it("identifies itself, because Nominatim answers an anonymous client with 403", async () => {
      fetchMock.mockResolvedValue(okResponse(hit()));

      await service.geocode("1912 Pike Pl");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["User-Agent"]).toBe(
        OSM_USER_AGENT,
      );
    });

    it("sends the address encoded in the query, collapsed to one line", async () => {
      fetchMock.mockResolvedValue(okResponse(hit()));

      await service.geocode("1912 Pike Pl\nSeattle, WA");

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain(encodeURIComponent("1912 Pike Pl Seattle, WA"));
      expect(url).toContain("format=jsonv2");
      expect(url).toContain("limit=1");
    });

    it("honours NOMINATIM_URL so a self-hosted geocoder needs no code change", async () => {
      process.env.NOMINATIM_URL = "https://geo.example.test/search";
      fetchMock.mockResolvedValue(okResponse(hit()));

      await service.geocode("somewhere");

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url.startsWith("https://geo.example.test/search?")).toBe(true);
    });
  });

  describe("returning null rather than a wrong point", () => {
    it.each([
      ["an empty result array", okResponse([])],
      ["a non-array body", okResponse({ error: "nope" })],
      [
        "an HTTP error",
        { ok: false, status: 429, json: async () => [] } as unknown as Response,
      ],
      ["non-numeric coordinates", okResponse([{ lat: "north", lon: "west" }])],
      ["a latitude out of range", okResponse(hit("91.5", "0"))],
      ["a longitude out of range", okResponse(hit("0", "180.5"))],
      ["a missing lon", okResponse([{ lat: "47.6" }])],
    ])("returns null for %s", async (_label, response) => {
      fastForwardRateLimit();
      fetchMock.mockResolvedValue(response);

      await expect(service.geocode("anywhere")).resolves.toBeNull();
    });

    it("returns null when the request rejects, so a save never fails on it", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      await expect(service.geocode("anywhere")).resolves.toBeNull();
    });

    it("never calls out for a blank address", async () => {
      await expect(service.geocode("   \n  ")).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never calls out for an address longer than a geocoder query", async () => {
      await expect(service.geocode("x".repeat(501))).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("staying inside Nominatim's one-request-per-second policy", () => {
    it("waits out the interval between two outbound requests", async () => {
      // Real timers with a shortened interval would not test the real constant,
      // so the clock is what moves: the only thing that advances it is the rate
      // limiter's own sleep, and each outbound request records the time it was
      // issued at. Switch MIN_INTERVAL_MS to 0 and this test fails.
      const times: number[] = [];
      const clock = { now: 1_000_000 };
      jest.spyOn(Date, "now").mockImplementation(() => clock.now);
      installTimerControl(clock);

      fetchMock.mockImplementation(async () => {
        times.push(clock.now);
        return okResponse(hit());
      });

      await Promise.all([
        service.geocode("first address"),
        service.geocode("second address"),
      ]);

      expect(times).toHaveLength(2);
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
    });

    it("serializes concurrent callers instead of bursting", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      fastForwardRateLimit();
      fetchMock.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return okResponse(hit());
      });

      await Promise.all([
        service.geocode("a"),
        service.geocode("b"),
        service.geocode("c"),
      ]);

      expect(maxInFlight).toBe(1);
    });

    it("keeps serving later lookups after one of them fails", async () => {
      fastForwardRateLimit();
      fetchMock
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(okResponse(hit()));

      const [failed, succeeded] = await Promise.all([
        service.geocode("broken"),
        service.geocode("fine"),
      ]);

      expect(failed).toBeNull();
      expect(succeeded).toEqual({
        latitude: 47.609722,
        longitude: -122.342201,
      });
    });
  });

  describe("caching", () => {
    it("answers a repeated address without a second request", async () => {
      fetchMock.mockResolvedValue(okResponse(hit()));

      await service.geocode("1912 Pike Pl");
      await service.geocode("1912 Pike Pl");

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats a multi-line address as the same query as its one-line form", async () => {
      fetchMock.mockResolvedValue(okResponse(hit()));

      await service.geocode("1912 Pike Pl, Seattle");
      await service.geocode("1912 Pike Pl,\n  Seattle");

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("caches a not-found answer too, so a bad address is not retried in a loop", async () => {
      fetchMock.mockResolvedValue(okResponse([]));

      await service.geocode("nowhere at all");
      await service.geocode("nowhere at all");

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("re-requests once the entry has expired", async () => {
      const clock = { now: 1_000_000 };
      jest.spyOn(Date, "now").mockImplementation(() => clock.now);
      fastForwardRateLimit();
      fetchMock.mockResolvedValue(okResponse(hit()));

      await service.geocode("1912 Pike Pl");
      clock.now += 24 * 60 * 60 * 1000 + 1;
      await service.geocode("1912 Pike Pl");

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("evicts the least recently used entry past the cap", async () => {
      fastForwardRateLimit();
      fetchMock.mockResolvedValue(okResponse(hit()));

      for (let i = 0; i < 201; i++) await service.geocode(`address ${i}`);
      const afterFill = fetchMock.mock.calls.length;
      // `address 0` was evicted by the 201st insert, so it costs a request.
      await service.geocode("address 0");

      expect(fetchMock.mock.calls.length).toBe(afterFill + 1);
    });
  });
});

describe("geocodeColumns", () => {
  it("stores the point and stamps the attempt", () => {
    const columns = geocodeColumns({ latitude: 47.6, longitude: -122.3 });

    expect(columns.latitude).toBe(47.6);
    expect(columns.longitude).toBe(-122.3);
    expect(columns.geocodedAt).toBeInstanceOf(Date);
  });

  it("clears a stale point on a failed lookup but still stamps the attempt", () => {
    // The stamp is what tells the UI a lookup happened and found nothing, so a
    // retry is worth offering -- as opposed to never having been tried.
    const columns = geocodeColumns(null);

    expect(columns.latitude).toBeNull();
    expect(columns.longitude).toBeNull();
    expect(columns.geocodedAt).toBeInstanceOf(Date);
  });

  it("clears the stamp as well when the address itself is gone", () => {
    expect(CLEARED_GEOCODE_COLUMNS).toEqual({
      latitude: null,
      longitude: null,
      geocodedAt: null,
    });
  });
});
