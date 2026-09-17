import {
  CLUSTER_MODES,
  MIN_JWT_SECRET_LENGTH,
  checkClusterBoot,
  getClusterMode,
  parseClusterMode,
} from "./cluster-mode";

const GOOD_SECRET = "x".repeat(MIN_JWT_SECRET_LENGTH);

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
        name: "multi with Redis and a secret",
        env: {
          CLUSTER_MODE: "multi",
          REDIS_URL: "redis://redis:6379",
          JWT_SECRET: GOOD_SECRET,
        },
        mode: "multi",
        refusals: [],
        warnings: [],
      },
      {
        name: "multi without REDIS_URL",
        env: { CLUSTER_MODE: "multi", JWT_SECRET: GOOD_SECRET },
        mode: "multi",
        refusals: [/CLUSTER_MODE=multi requires REDIS_URL/],
        warnings: [],
      },
      {
        name: "multi with a blank REDIS_URL",
        env: {
          CLUSTER_MODE: "multi",
          REDIS_URL: "  ",
          JWT_SECRET: GOOD_SECRET,
        },
        mode: "multi",
        refusals: [/requires REDIS_URL/],
        warnings: [],
      },
      {
        name: "single with REDIS_URL set",
        env: {
          CLUSTER_MODE: "single",
          REDIS_URL: "redis://redis:6379",
          JWT_SECRET: GOOD_SECRET,
        },
        mode: "single",
        refusals: [],
        warnings: [/REDIS_URL is set but CLUSTER_MODE is single/],
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
        env: { CLUSTER_MODE: "multi", REDIS_URL: "redis://redis:6379" },
        mode: "multi",
        refusals: [/JWT_SECRET is not set/],
        warnings: [],
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

  it("reports every problem at once, so one restart is enough", () => {
    const report = checkClusterBoot({ CLUSTER_MODE: "multi" });
    expect(report.refusals).toHaveLength(2);
    expect(report.refusals.join("\n")).toMatch(/JWT_SECRET/);
    expect(report.refusals.join("\n")).toMatch(/REDIS_URL/);
  });

  it("does not warn about an unused REDIS_URL when the mode did not parse", () => {
    const report = checkClusterBoot({
      CLUSTER_MODE: "sngle",
      REDIS_URL: "redis://redis:6379",
      JWT_SECRET: GOOD_SECRET,
    });
    expect(report.warnings).toEqual([]);
  });
});
