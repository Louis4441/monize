import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import {
  KNOWN_PLACEHOLDER_JWT_SECRETS,
  MIN_JWT_SECRET_LENGTH,
  jwtSecretProblem,
} from "./jwt-secret-policy";

const REPO_ROOT = join(__dirname, "..", "..", "..");

describe("jwtSecretProblem", () => {
  it("refuses a missing or empty secret", () => {
    expect(jwtSecretProblem(undefined)).toMatch(/not set/);
    expect(jwtSecretProblem(null)).toMatch(/not set/);
    expect(jwtSecretProblem("")).toMatch(/not set/);
  });

  it("refuses a secret shorter than the floor", () => {
    expect(jwtSecretProblem("a1B2c3D4e5F6g7H8")).toMatch(
      new RegExp(`shorter than ${MIN_JWT_SECRET_LENGTH}`),
    );
  });

  it("refuses the placeholder .env.example ships, however it is wrapped", () => {
    // Read from the file rather than restated, so a new placeholder in the
    // example cannot slip past this spec: the line an operator copies is the
    // line that must be refused.
    const example = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    const line = /^JWT_SECRET=(.*)$/m.exec(example)?.[1];
    expect(line).toBeDefined();
    const placeholder = line as string;
    expect(placeholder.length).toBeGreaterThanOrEqual(MIN_JWT_SECRET_LENGTH);

    expect(jwtSecretProblem(placeholder)).toMatch(/example placeholder/);
    expect(jwtSecretProblem(`"${placeholder}"`)).toMatch(/example placeholder/);
    expect(jwtSecretProblem(` ${placeholder.toUpperCase()} `)).toMatch(
      /example placeholder/,
    );
  });

  it("refuses every listed placeholder and any value built around one", () => {
    for (const placeholder of KNOWN_PLACEHOLDER_JWT_SECRETS) {
      expect(jwtSecretProblem(placeholder)).not.toBeNull();
    }
    expect(
      jwtSecretProblem("my-own-jwt-secret-please-changeme-now-2024"),
    ).toMatch(/example placeholder/);
  });

  it("refuses a secret with too few distinct characters", () => {
    expect(jwtSecretProblem("x".repeat(64))).toMatch(/too predictable/);
    expect(jwtSecretProblem("ab".repeat(20))).toMatch(/too predictable/);
    expect(jwtSecretProblem("1234567".repeat(6))).toMatch(/too predictable/);
  });

  it("refuses a secret that is one short unit repeated", () => {
    // 12 distinct characters, so only the repetition gives it away.
    expect(jwtSecretProblem("password1234".repeat(3))).toMatch(
      /too predictable/,
    );
  });

  it("accepts what the documented generators print", () => {
    // 200 draws of each shape; the spec's arithmetic puts a false refusal of a
    // 32-byte hex secret near 1e-19, so a failure here is the rule's fault.
    for (let i = 0; i < 200; i++) {
      const bytes = randomBytes(32);
      expect(jwtSecretProblem(bytes.toString("base64"))).toBeNull();
      expect(jwtSecretProblem(bytes.toString("hex"))).toBeNull();
      expect(jwtSecretProblem(bytes.toString("base64url"))).toBeNull();
    }
  });

  it("accepts the secrets the CI and E2E stacks boot with", () => {
    // `.github/workflows/ci.yml` and `docker-compose.e2e.yml`; the rule must
    // not refuse the stacks the test suites start.
    expect(
      jwtSecretProblem("test-jwt-secret-for-ci-minimum-32-characters-long"),
    ).toBeNull();
    expect(
      jwtSecretProblem("test-jwt-secret-that-is-at-least-32-chars-long"),
    ).toBeNull();
  });

  it("measures length untrimmed, as both callers always have", () => {
    const padded = `  ${"aB3dE5gH7jK9mN1pQ3sT5vW7yZ9b"}  `;
    expect(padded.length).toBe(MIN_JWT_SECRET_LENGTH);
    expect(jwtSecretProblem(padded)).toBeNull();
  });
});
