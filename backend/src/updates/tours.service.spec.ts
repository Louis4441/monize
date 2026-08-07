import { DataSource, EntityManager } from "typeorm";
import {
  TourProgressMap,
  UserPreference,
} from "../users/entities/user-preference.entity";
import { ReleaseNotesService } from "./release-notes.service";
import { ToursService } from "./tours.service";
import { withScopedDb } from "../common/db/scoped-db";
import {
  createUserPreferenceRepoMock,
  type UserPreferenceRepoMock,
} from "../test-helpers/user-preference-testing";

jest.mock("../common/db/scoped-db");
const mockedTenantTx = withScopedDb as jest.MockedFunction<typeof withScopedDb>;

const CURRENT_VERSION = "1.13.0";

describe("ToursService", () => {
  let prefsMock: UserPreferenceRepoMock;
  let repo: Record<string, jest.Mock>;
  let query: jest.Mock;
  let manager: EntityManager;
  let service: ToursService;

  beforeEach(() => {
    // The row-modelling double: the prune path writes through the column-scoped
    // writer (insert-if-absent + UPDATE of only the named columns), so a mock
    // that recorded `save` calls could not tell a whole-row save from a scoped
    // patch -- and the whole point of the change is that it is the latter.
    prefsMock = createUserPreferenceRepoMock(null);
    repo = prefsMock.repo;
    // Default: the atomic-merge UPDATE affects a row.
    query = jest.fn().mockResolvedValue([{ user_id: "user-1" }]);

    manager = {
      getRepository: jest.fn(() => repo),
      query,
    } as unknown as EntityManager;

    mockedTenantTx.mockImplementation((_dataSource, fn) => fn(manager));

    const releaseNotes = {
      currentVersion: CURRENT_VERSION,
    } as unknown as ReleaseNotesService;

    service = new ToursService({} as DataSource, releaseNotes);
  });

  afterEach(() => jest.clearAllMocks());

  function prefs(tourProgress: TourProgressMap = {}): UserPreference {
    return { userId: "user-1", tourProgress } as UserPreference;
  }

  describe("getProgress", () => {
    it("returns the stored map", async () => {
      const map = { "intro/basics": { status: "completed", updatedAt: "x" } };
      repo.findOne.mockResolvedValue(prefs(map as TourProgressMap));

      const result = await service.getProgress("user-1");

      expect(result).toEqual(map);
    });

    it("returns an empty map when no row exists", async () => {
      repo.findOne.mockResolvedValue(null);

      expect(await service.getProgress("user-1")).toEqual({});
    });
  });

  describe("saveProgress", () => {
    it("atomically merges a single entry without a version for evergreen tours", async () => {
      repo.findOne.mockResolvedValue(prefs());

      const result = await service.saveProgress(
        "user-1",
        "intro/basics",
        "completed",
      );

      expect(result).toEqual({ saved: true });
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain("tour_progress || $1::jsonb");
      const patch = JSON.parse(params[0]);
      expect(patch["intro/basics"]).toMatchObject({ status: "completed" });
      expect(patch["intro/basics"].version).toBeUndefined();
      expect(params[1]).toBe("user-1");
      // Existing row -> no fallback save.
      expect(repo.save).not.toHaveBeenCalled();
    });

    it("stamps the running version on release-* tours", async () => {
      repo.findOne.mockResolvedValue(prefs());

      await service.saveProgress(
        "user-1",
        "release-1.13.0/accounts",
        "dismissed",
      );

      const patch = JSON.parse(query.mock.calls[0][1][0]);
      expect(patch["release-1.13.0/accounts"]).toMatchObject({
        status: "dismissed",
        version: CURRENT_VERSION,
      });
    });

    it("materializes a preferences row when the UPDATE affects no rows", async () => {
      query.mockResolvedValue([]);

      await service.saveProgress("user-1", "intro/basics", "completed");

      expect(repo.save).toHaveBeenCalledTimes(1);
      const saved = repo.save.mock.calls[0][0] as UserPreference;
      expect(saved.userId).toBe("user-1");
      expect(saved.tourProgress["intro/basics"]).toMatchObject({
        status: "completed",
      });
    });

    it("prunes the oldest entries when the map exceeds the cap, writing only tour_progress", async () => {
      const bloated: TourProgressMap = {};
      for (let i = 0; i < 205; i++) {
        bloated[`tour-${i}`] = {
          status: "completed",
          updatedAt: new Date(2020, 0, 1, 0, i).toISOString(),
        };
      }
      repo.findOne.mockResolvedValue(prefs(bloated));

      await service.saveProgress("user-1", "tour-999", "completed");

      // The prune writes through the column-scoped writer, never a whole-entity
      // save that would revert a concurrent change to another preference
      // (finding 3). Exactly one column is touched: tour_progress.
      expect(repo.save).not.toHaveBeenCalled();
      expect(prefsMock.patches()).toHaveLength(1);
      const patched = prefsMock.patches()[0].tourProgress as TourProgressMap;
      expect(Object.keys(patched)).toHaveLength(200);
      // Oldest (tour-0) pruned, newest kept.
      expect(patched["tour-0"]).toBeUndefined();
      expect(patched["tour-204"]).toBeDefined();
    });

    it("does not prune when under the cap", async () => {
      repo.findOne.mockResolvedValue(
        prefs({ a: { status: "completed", updatedAt: "x" } }),
      );

      await service.saveProgress("user-1", "intro/basics", "completed");

      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe("resetProgress", () => {
    it("clears the map via SQL", async () => {
      const result = await service.resetProgress("user-1");

      expect(result).toEqual({ reset: true });
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain("tour_progress = '{}'::jsonb");
      expect(params[0]).toBe("user-1");
    });
  });
});
