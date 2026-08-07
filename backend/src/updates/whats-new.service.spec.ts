import { DataSource, EntityManager } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { DemoModeService } from "../common/demo-mode.service";
import { ReleaseNotesService } from "./release-notes.service";
import { ReleaseNotes } from "./release-notes.parser";
import { WhatsNewService } from "./whats-new.service";
import { withScopedDb } from "../common/db/scoped-db";
import {
  createUserPreferenceRepoMock,
  type UserPreferenceRepoMock,
} from "../test-helpers/user-preference-testing";

// Unit-test the service against a mocked withScopedDb (its own behaviour -- context
// requirement, GUCs, re-entrancy -- is covered by scoped-db.spec.ts). The mock
// simply runs the callback with a manager whose repository is our mock repo.
jest.mock("../common/db/scoped-db");
const mockedTenantTx = withScopedDb as jest.MockedFunction<typeof withScopedDb>;

const CURRENT_VERSION = "1.12.1";

const SAMPLE_NOTES: ReleaseNotes = {
  version: CURRENT_VERSION,
  intro: "Intro.",
  sections: [{ heading: "Feature", body: "Body.", children: [] }],
  releaseUrl: `https://github.com/kenlasko/monize/releases/tag/v${CURRENT_VERSION}`,
};

describe("WhatsNewService", () => {
  let prefsMock: UserPreferenceRepoMock;
  let repo: Record<string, jest.Mock>;
  let releaseNotes: jest.Mocked<
    Pick<ReleaseNotesService, "getForCurrentVersion" | "currentVersion">
  >;
  let demoMode: { isDemo: boolean };
  let service: WhatsNewService;

  beforeEach(() => {
    // Row-modelling double: markSeen/remindNextLogin write through the
    // column-scoped writer (insert-if-absent + UPDATE of one column), so the
    // double has to model the row and record which columns a write touched --
    // a `save`-recording mock could not tell a scoped patch from a whole-row
    // save, which is the exact regression finding 3 removes.
    prefsMock = createUserPreferenceRepoMock(null);
    repo = prefsMock.repo;

    const manager = {
      getRepository: jest.fn(() => repo),
    } as unknown as EntityManager;

    // Run the withScopedDb callback immediately with our mock manager.
    mockedTenantTx.mockImplementation((_dataSource, fn) => fn(manager));

    releaseNotes = {
      getForCurrentVersion: jest.fn().mockReturnValue(SAMPLE_NOTES),
      currentVersion: CURRENT_VERSION,
    } as unknown as jest.Mocked<
      Pick<ReleaseNotesService, "getForCurrentVersion" | "currentVersion">
    >;
    demoMode = { isDemo: false };

    service = new WhatsNewService(
      {} as DataSource,
      releaseNotes as unknown as ReleaseNotesService,
      demoMode as DemoModeService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function prefs(overrides: Partial<UserPreference> = {}): UserPreference {
    return {
      userId: "user-1",
      showWhatsNew: true,
      lastSeenVersion: null,
      ...overrides,
    } as UserPreference;
  }

  describe("getWhatsNew", () => {
    it("auto-shows for a user who has not seen the current version", async () => {
      repo.findOne.mockResolvedValue(prefs({ lastSeenVersion: "1.11.0" }));

      const status = await service.getWhatsNew("user-1");

      expect(status.currentVersion).toBe(CURRENT_VERSION);
      expect(status.notes).toBe(SAMPLE_NOTES);
      expect(status.autoShow).toBe(true);
      expect(mockedTenantTx).toHaveBeenCalledTimes(1);
    });

    it("does not auto-show on a first login (no preferences row yet)", async () => {
      repo.findOne.mockResolvedValue(null);

      const status = await service.getWhatsNew("user-1");

      expect(status.autoShow).toBe(false);
      // The notes still come back so the version label can open the modal.
      expect(status.notes).toBe(SAMPLE_NOTES);
    });

    it("auto-shows for a legacy row that predates the digest columns", async () => {
      repo.findOne.mockResolvedValue(
        prefs({
          showWhatsNew: null as unknown as boolean,
          lastSeenVersion: null,
        }),
      );

      const status = await service.getWhatsNew("user-1");

      expect(status.autoShow).toBe(true);
    });

    it("does not auto-show once the current version has been acknowledged", async () => {
      repo.findOne.mockResolvedValue(
        prefs({ lastSeenVersion: CURRENT_VERSION }),
      );

      const status = await service.getWhatsNew("user-1");

      expect(status.autoShow).toBe(false);
      // Notes are still returned so the modal can open manually.
      expect(status.notes).toBe(SAMPLE_NOTES);
    });

    it("does not auto-show when the user disabled the popup", async () => {
      repo.findOne.mockResolvedValue(prefs({ showWhatsNew: false }));

      const status = await service.getWhatsNew("user-1");

      expect(status.autoShow).toBe(false);
    });

    it("does not auto-show in a demo instance", async () => {
      demoMode.isDemo = true;
      repo.findOne.mockResolvedValue(prefs());

      const status = await service.getWhatsNew("user-1");

      expect(status.autoShow).toBe(false);
    });

    it("does not auto-show when no notes exist for the version", async () => {
      releaseNotes.getForCurrentVersion.mockReturnValue(null);
      repo.findOne.mockResolvedValue(prefs());

      const status = await service.getWhatsNew("user-1");

      expect(status.notes).toBeNull();
      expect(status.autoShow).toBe(false);
    });
  });

  describe("markSeen", () => {
    it("writes only last_seen_version onto an existing row", async () => {
      prefsMock.seed({ lastSeenVersion: "1.11.0" });

      const result = await service.markSeen("user-1");

      // Column-scoped patch, never a whole-entity save: only last_seen_version
      // is touched, so a concurrent change to another preference survives
      // (maintainer review PR #1097, finding 3).
      expect(prefsMock.patches()).toEqual([
        { lastSeenVersion: CURRENT_VERSION },
      ]);
      expect(prefsMock.row()?.lastSeenVersion).toBe(CURRENT_VERSION);
      expect(result).toEqual({ seen: true, version: CURRENT_VERSION });
    });

    it("materializes a preferences row when none exists, then stores the version", async () => {
      prefsMock.seed(null);

      const result = await service.markSeen("user-1");

      // Insert-if-absent first so the UPDATE has a row to hit, then the scoped
      // patch -- no read-modify-write, no whole-row save.
      expect(prefsMock.insertAttempts()).toHaveLength(1);
      expect(prefsMock.insertAttempts()[0].userId).toBe("user-1");
      expect(prefsMock.patches()).toEqual([
        { lastSeenVersion: CURRENT_VERSION },
      ]);
      expect(prefsMock.row()?.lastSeenVersion).toBe(CURRENT_VERSION);
      expect(result.seen).toBe(true);
    });
  });

  describe("remindNextLogin", () => {
    it("clears last_seen_version on an existing row so the digest shows again", async () => {
      prefsMock.seed({ lastSeenVersion: CURRENT_VERSION });

      const result = await service.remindNextLogin("user-1");

      expect(prefsMock.patches()).toEqual([{ lastSeenVersion: null }]);
      expect(prefsMock.row()?.lastSeenVersion).toBeNull();
      expect(result).toEqual({ reminded: true });
    });

    it("writes unconditionally even when it is already clear", async () => {
      // The old code gated the write on a snapshot saying there was something to
      // clear, and could skip it entirely. Setting an already-null column to
      // null is a harmless idempotent write; gating it on a stale read is the
      // lost-write shape finding 3 removes, so the patch is applied every time.
      prefsMock.seed({ lastSeenVersion: null });

      const result = await service.remindNextLogin("user-1");

      expect(prefsMock.patches()).toEqual([{ lastSeenVersion: null }]);
      expect(result.reminded).toBe(true);
    });

    it("materializes an unacknowledged row when none exists", async () => {
      prefsMock.seed(null);

      const result = await service.remindNextLogin("user-1");

      // Defaults stamp the running version; the reminder has to clear it, or the
      // digest the user just asked for would be suppressed as a first login.
      expect(prefsMock.insertAttempts()).toHaveLength(1);
      expect(prefsMock.patches()).toEqual([{ lastSeenVersion: null }]);
      expect(prefsMock.row()?.lastSeenVersion).toBeNull();
      expect(result.reminded).toBe(true);
    });

    it("re-enables auto-show after an acknowledgement was cleared", async () => {
      // Acknowledged -> would not auto-show...
      repo.findOne.mockResolvedValue(
        prefs({ lastSeenVersion: CURRENT_VERSION }),
      );
      expect((await service.getWhatsNew("user-1")).autoShow).toBe(false);

      // ...clearing it brings the popup back on the next status check.
      const cleared = prefs({ lastSeenVersion: null });
      repo.findOne.mockResolvedValue(cleared);
      expect((await service.getWhatsNew("user-1")).autoShow).toBe(true);
    });
  });
});
