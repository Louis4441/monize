import {
  BackupData,
  LEGACY_TABLE_KEYS,
  backupTables,
  renameLegacyTableKeys,
} from "./backup-format";

/**
 * A backup keys its tables by SQL table name, so renaming a table renames a key
 * every artifact written before the rename does not carry.
 *
 * Nothing about that is loud: `insertRows` is handed `undefined` for the new
 * key, restores zero rows and reports zero -- silent data loss inside an
 * operation whose whole promise is that nothing is lost. The version cannot
 * carry the fix either, since `validateBackupFormat` compares it for equality
 * and bumping it would reject every existing artifact instead of reading one.
 */
function artifact(tables: Record<string, unknown[]>): BackupData {
  return {
    version: "1.0",
    exportedAt: "2026-08-30T00:00:00.000Z",
    ...tables,
  } as unknown as BackupData;
}

describe("renameLegacyTableKeys", () => {
  it("moves a legacy key onto the name the restore uses", () => {
    const data = artifact({ budget_alerts: [{ id: "n-1" }] });

    expect(renameLegacyTableKeys(data)).toEqual([
      "budget_alerts -> notifications",
    ]);
    const tables = backupTables(data);
    expect(tables.notifications).toEqual([{ id: "n-1" }]);
    // The old key is gone rather than left beside the new one: the insert path
    // is allowlisted by table name and would refuse it, and a reader finding
    // both cannot tell which one the restore used.
    expect("budget_alerts" in tables).toBe(false);
  });

  it("moves an empty table, because empty is not absent", () => {
    // A user with no notifications exports `[]`. Treating that as "no key" would
    // work by accident here and hide the rename for the next table, whose empty
    // case may not be harmless.
    const data = artifact({ budget_alerts: [] });

    expect(renameLegacyTableKeys(data)).toEqual([
      "budget_alerts -> notifications",
    ]);
    expect(backupTables(data).notifications).toEqual([]);
  });

  it("leaves a current artifact untouched and reports nothing moved", () => {
    const data = artifact({ notifications: [{ id: "n-1" }] });

    expect(renameLegacyTableKeys(data)).toEqual([]);
    expect(backupTables(data).notifications).toEqual([{ id: "n-1" }]);
  });

  it("keeps the current key when an artifact carries both", () => {
    // Written by an instance that already knew the new name, so the old key is
    // whatever it is -- not something to overwrite the real rows with.
    const data = artifact({
      budget_alerts: [{ id: "stale" }],
      notifications: [{ id: "n-1" }],
    });

    renameLegacyTableKeys(data);

    const tables = backupTables(data);
    expect(tables.notifications).toEqual([{ id: "n-1" }]);
    expect("budget_alerts" in tables).toBe(false);
  });

  it("does not invent a key for a table the artifact does not carry", () => {
    // A partial artifact (a support backup section, an older export) omits
    // tables entirely, and an empty array is a different claim from a missing
    // key: `insertRows` skips the second and truncates on the first.
    const data = artifact({ transactions: [] });

    expect(renameLegacyTableKeys(data)).toEqual([]);
    expect("notifications" in backupTables(data)).toBe(false);
  });

  it("declares no alias for a name that is also a current table", () => {
    // An alias pointing at a live table would move real rows out of it. The
    // schema side of this is checked by migration-table-renames.spec.ts; this is
    // the shape check that needs no filesystem.
    for (const [current, legacyNames] of Object.entries(LEGACY_TABLE_KEYS)) {
      expect(legacyNames.length).toBeGreaterThan(0);
      expect(legacyNames).not.toContain(current);
      expect(new Set(legacyNames).size).toBe(legacyNames.length);
    }
  });
});
