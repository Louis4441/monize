import { EntityManager } from "typeorm";
import {
  ensureUserPreferencesRow,
  patchUserPreferences,
} from "./user-preference-writer";
import { createUserPreferenceRepoMock } from "../test-helpers/user-preference-testing";

/**
 * The writer is the one sanctioned way to write a few columns of a
 * `user_preferences` row (maintainer review PR #1097, finding 4: it was only
 * exercised indirectly through the 2FA specs). These specs pin the two
 * properties that are the whole reason it exists:
 *
 * - it never issues a whole-entity `save` (which re-reads the row and writes
 *   back every column the caller's stale copy still held), and
 * - it writes *only* the columns handed to it, so a concurrent change to a
 *   different preference survives.
 */
describe("user-preference-writer", () => {
  let prefsMock: ReturnType<typeof createUserPreferenceRepoMock>;
  let manager: EntityManager;

  beforeEach(() => {
    prefsMock = createUserPreferenceRepoMock(null);
    manager = {
      getRepository: jest.fn(() => prefsMock.repo),
    } as unknown as EntityManager;
  });

  describe("ensureUserPreferencesRow", () => {
    it("materializes a defaults row for a user who has none", async () => {
      await ensureUserPreferencesRow(manager, "user-1");

      expect(prefsMock.insertAttempts()).toHaveLength(1);
      expect(prefsMock.insertAttempts()[0].userId).toBe("user-1");
      expect(prefsMock.row()).not.toBeNull();
      // Never a whole-row save, and never an UPDATE -- it only creates.
      expect(prefsMock.repo.save).not.toHaveBeenCalled();
      expect(prefsMock.patches()).toHaveLength(0);
    });

    it("leaves an existing row untouched (ON CONFLICT DO NOTHING)", async () => {
      prefsMock.seed({
        userId: "user-1",
        theme: "dark",
        defaultCurrency: "EUR",
      });

      await ensureUserPreferencesRow(manager, "user-1");

      // The insert is attempted, but the conflict leaves the row alone: no
      // column is overwritten and no patch is issued.
      expect(prefsMock.patches()).toHaveLength(0);
      expect(prefsMock.row()?.theme).toBe("dark");
      expect(prefsMock.row()?.defaultCurrency).toBe("EUR");
      expect(prefsMock.repo.save).not.toHaveBeenCalled();
    });
  });

  describe("patchUserPreferences", () => {
    it("writes only the named columns onto an existing row", async () => {
      prefsMock.seed({
        userId: "user-1",
        theme: "dark",
        defaultCurrency: "EUR",
      });

      await patchUserPreferences(manager, "user-1", { theme: "light" });

      // Exactly one UPDATE, carrying only `theme`. `defaultCurrency` is not in
      // the patch, so a concurrent writer's change to it is not reverted -- the
      // whole point of the writer.
      expect(prefsMock.patches()).toEqual([{ theme: "light" }]);
      expect(prefsMock.row()?.theme).toBe("light");
      expect(prefsMock.row()?.defaultCurrency).toBe("EUR");
      expect(prefsMock.repo.save).not.toHaveBeenCalled();
    });

    it("materializes the row first when none exists, then patches it", async () => {
      await patchUserPreferences(manager, "user-1", { theme: "light" });

      // Insert-if-absent so the UPDATE has a row to hit, then the scoped patch.
      expect(prefsMock.insertAttempts()).toHaveLength(1);
      expect(prefsMock.patches()).toEqual([{ theme: "light" }]);
      expect(prefsMock.row()?.theme).toBe("light");
      expect(prefsMock.repo.save).not.toHaveBeenCalled();
    });

    it("only materializes the row for an empty patch, issuing no UPDATE", async () => {
      // Callers use an empty patch to lazily create the row on first access;
      // there is nothing to set, so no UPDATE should run.
      await patchUserPreferences(manager, "user-1", {});

      expect(prefsMock.insertAttempts()).toHaveLength(1);
      expect(prefsMock.patches()).toHaveLength(0);
      expect(prefsMock.row()).not.toBeNull();
    });
  });
});
