import {
  CLUSTER_MODES,
  MIN_JWT_SECRET_LENGTH,
  checkClusterBoot,
  getClusterMode,
  parseClusterMode,
} from "./cluster-mode";

const GOOD_SECRET = "x".repeat(MIN_JWT_SECRET_LENGTH);

/**
 * What a `multi` deployment must assert about its storage before it can boot.
 *
 * Spread into the rows below that are about something else, so a row testing
 * the JWT secret is not also silently testing the storage refusals. The
 * storage rows state their own inputs.
 */
const SHARED_STORAGE = { BACKUP_SHARED_VOLUME: "true" } as const;

describe("parseClusterMode", () => {
  it.each([
    [undefined, "single"],
    [null, "single"],
    ["", "single"],
    ["   ", "single"],
    ["single", "single"],
    ["multi", "multi"],
    ["MULTI", "multi"],
    [" Multi ", "multi"],
  ])("parses %p as %s", (raw, expected) => {
    expect(parseClusterMode(raw as string | undefined | null)).toBe(expected);
  });

  it("throws on an unrecognized value rather than defaulting", () => {
    expect(() => parseClusterMode("cluster")).toThrow(
      /Invalid CLUSTER_MODE "cluster"/,
    );
  });

  it("names every mode in the error, so the message is the fix", () => {
    try {
      parseClusterMode("nope");
      fail("expected a throw");
    } catch (error) {
      for (const mode of CLUSTER_MODES) {
        expect((error as Error).message).toContain(mode);
      }
    }
  });
});

describe("getClusterMode", () => {
  const original = process.env.CLUSTER_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.CLUSTER_MODE;
    else process.env.CLUSTER_MODE = original;
  });

  it("reads process.env fresh", () => {
    delete process.env.CLUSTER_MODE;
    expect(getClusterMode()).toBe("single");
    process.env.CLUSTER_MODE = "multi";
    expect(getClusterMode()).toBe("multi");
  });
});

describe("checkClusterBoot", () => {
  it("passes a default single-replica deployment", () => {
    const report = checkClusterBoot({ JWT_SECRET: GOOD_SECRET });
    expect(report).toEqual({ mode: "single", refusals: [], warnings: [] });
  });

  describe("the boot matrix", () => {
    const cases: {
      name: string;
      env: Parameters<typeof checkClusterBoot>[0];
      mode: string | null;
      refusals: RegExp[];
      warnings: RegExp[];
    }[] = [
      {
        // multi asks for no setting of its own: PostgreSQL is the only shared
        // store, so a secret is the whole of what the matrix can check here.
        // What multi additionally needs -- a database host that can hold
        // LISTEN, and cluster-safe attachment and backup storage -- is a
        // connection and a module's configuration, which F2 and S1 add.
        name: "multi with a secret",
        env: {
          CLUSTER_MODE: "multi",
          JWT_SECRET: GOOD_SECRET,
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [],
        // The default attachment provider is `database`, which is cluster-safe
        // and says so rather than passing in silence.
        warnings: [/ATTACHMENT_STORAGE_PROVIDER=database/],
      },
      {
        name: "multi with attachments on s3",
        env: {
          CLUSTER_MODE: "multi",
          JWT_SECRET: GOOD_SECRET,
          ATTACHMENT_STORAGE_PROVIDER: "s3",
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [],
        warnings: [],
      },
      {
        name: "multi with per-pod attachments",
        env: {
          CLUSTER_MODE: "multi",
          JWT_SECRET: GOOD_SECRET,
          ATTACHMENT_STORAGE_PROVIDER: "local",
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [/ATTACHMENT_SHARED_VOLUME=true/],
        warnings: [],
      },
      {
        name: "multi with local attachments on an asserted shared volume",
        env: {
          CLUSTER_MODE: "multi",
          JWT_SECRET: GOOD_SECRET,
          ATTACHMENT_STORAGE_PROVIDER: "local",
          ATTACHMENT_SHARED_VOLUME: "true",
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [],
        warnings: [],
      },
      {
        // The provider is read case- and whitespace-insensitively, as the
        // module that selects it reads it.
        name: "multi with LOCAL attachments spelled loudly",
        env: {
          CLUSTER_MODE: "multi",
          JWT_SECRET: GOOD_SECRET,
          ATTACHMENT_STORAGE_PROVIDER: "  LOCAL ",
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [/ATTACHMENT_SHARED_VOLUME=true/],
        warnings: [],
      },
      {
        name: "multi without the backup assertion",
        env: {
          CLUSTER_MODE: "multi",
          JWT_SECRET: GOOD_SECRET,
          ATTACHMENT_STORAGE_PROVIDER: "s3",
        },
        mode: "multi",
        refusals: [/BACKUP_SHARED_VOLUME=true/],
        warnings: [],
      },
      {
        // Anything but the exact assertion is not an assertion. "yes" and "1"
        // are what an operator reaches for, and accepting them would mean the
        // check passes on a value nobody chose deliberately.
        name: "multi with a backup assertion that is not true",
        env: {
          CLUSTER_MODE: "multi",
          JWT_SECRET: GOOD_SECRET,
          ATTACHMENT_STORAGE_PROVIDER: "s3",
          BACKUP_SHARED_VOLUME: "yes",
        },
        mode: "multi",
        refusals: [/BACKUP_SHARED_VOLUME=true/],
        warnings: [],
      },
      {
        name: "single ignores the storage settings entirely",
        env: {
          CLUSTER_MODE: "single",
          JWT_SECRET: GOOD_SECRET,
          ATTACHMENT_STORAGE_PROVIDER: "local",
        },
        mode: "single",
        refusals: [],
        warnings: [],
      },
      {
        name: "JWT_SECRET missing in single",
        env: {},
        mode: "single",
        refusals: [/JWT_SECRET is not set/],
        warnings: [],
      },
      {
        name: "JWT_SECRET missing in multi",
        env: { CLUSTER_MODE: "multi", ...SHARED_STORAGE },
        mode: "multi",
        refusals: [/JWT_SECRET is not set/],
        warnings: [/ATTACHMENT_STORAGE_PROVIDER=database/],
      },
      {
        name: "JWT_SECRET too short",
        env: { JWT_SECRET: "short" },
        mode: "single",
        refusals: [/JWT_SECRET is shorter than 32 characters/],
        warnings: [],
      },
      {
        // Measured the way JwtStrategy measures it: this one boots there, so it
        // must boot here. A trimmed length would refuse a running deployment.
        name: "JWT_SECRET long enough only with its whitespace",
        env: { JWT_SECRET: `  ${"y".repeat(MIN_JWT_SECRET_LENGTH - 2)}  ` },
        mode: "single",
        refusals: [],
        warnings: [],
      },
      {
        name: "an unparsable CLUSTER_MODE",
        env: { CLUSTER_MODE: "cluster", JWT_SECRET: GOOD_SECRET },
        mode: null,
        refusals: [/Invalid CLUSTER_MODE "cluster"/],
        warnings: [],
      },
    ];

    it.each(cases)("$name", ({ env, mode, refusals, warnings }) => {
      const report = checkClusterBoot(env);
      expect(report.mode).toBe(mode);
      expect(report.refusals).toHaveLength(refusals.length);
      refusals.forEach((pattern, i) =>
        expect(report.refusals[i]).toMatch(pattern),
      );
      expect(report.warnings).toHaveLength(warnings.length);
      warnings.forEach((pattern, i) =>
        expect(report.warnings[i]).toMatch(pattern),
      );
    });
  });

  it("names the directory an operator has to share", () => {
    // The refusal is only useful if it says which path to mount, and the
    // deprecated alias names the same directory as the current variable.
    const withAlias = checkClusterBoot({
      CLUSTER_MODE: "multi",
      JWT_SECRET: GOOD_SECRET,
      ATTACHMENT_STORAGE_PROVIDER: "local",
      ATTACHMENT_LOCAL_DIR: "/srv/legacy-attachments",
      BACKUP_CONTAINER_DIR: "/srv/backups",
    });

    expect(withAlias.refusals.join("\n")).toContain("/srv/legacy-attachments");
    expect(withAlias.refusals.join("\n")).toContain("/srv/backups");
  });

  it("prefers the current directory variable over the deprecated alias", () => {
    const both = checkClusterBoot({
      CLUSTER_MODE: "multi",
      JWT_SECRET: GOOD_SECRET,
      ATTACHMENT_STORAGE_PROVIDER: "local",
      ATTACHMENT_CONTAINER_DIR: "/srv/current",
      ATTACHMENT_LOCAL_DIR: "/srv/legacy",
      ...SHARED_STORAGE,
    });

    expect(both.refusals.join("\n")).toContain("/srv/current");
    expect(both.refusals.join("\n")).not.toContain("/srv/legacy");
  });

  it("names the container defaults when no directory is set", () => {
    // An operator who never set the paths still has to be told which ones to
    // mount, and the defaults are the chart's.
    const defaults = checkClusterBoot({
      CLUSTER_MODE: "multi",
      JWT_SECRET: GOOD_SECRET,
      ATTACHMENT_STORAGE_PROVIDER: "local",
    });

    expect(defaults.refusals.join("\n")).toContain("/data/attachments");
    expect(defaults.refusals.join("\n")).toContain("/data/backups");
  });

  it("reports every problem at once, so one restart is enough", () => {
    // An unreadable mode does not stop the secret being judged: an operator
    // who fixed one and restarted to find the other waiting is the failure
    // this asserts against.
    const report = checkClusterBoot({ CLUSTER_MODE: "cluster" });
    expect(report.refusals).toHaveLength(2);
    expect(report.refusals.join("\n")).toMatch(/Invalid CLUSTER_MODE/);
    expect(report.refusals.join("\n")).toMatch(/JWT_SECRET/);
  });
});
