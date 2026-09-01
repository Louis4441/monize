/**
 * Every mutating push route is rate-limited beyond the global ceiling.
 *
 * The global `ThrottlerGuard` allows 100 requests a minute, which is sized for
 * ordinary reads. `POST /push/test` is not one: it fans out to every live device
 * on the account, so at the global limit alone one authenticated user could
 * drive `100 x MAX_LIVE_DEVICES_PER_USER` = 2,000 signed push requests a minute
 * out of this instance. The resource that buys is deployment-wide -- there is one
 * VAPID key pair per instance -- so a push service that throttles or penalises
 * the origin degrades push for every user, not for the account that did it.
 * `POST /push/vapid/rotate` is worse in a different direction: it retires every
 * registered device on the deployment and derives a new key pair through scrypt.
 *
 * Every other endpoint in this codebase that reaches an outbound provider
 * carries an explicit `@Throttle` (the AI controllers at 5-20 a minute, the
 * OAuth interaction controller at 10-30). These two shipped without one, so the
 * rule is checked here rather than remembered: a scan, because the next route
 * added to this module is the one that would forget.
 */
import * as fs from "fs";
import * as path from "path";

const CONTROLLERS = ["push.controller.ts", "admin-notifications.controller.ts"];

/** The per-minute ceiling a mutating push route may not exceed. */
const MAX_LIMIT = 20;

interface Route {
  controller: string;
  method: string;
  route: string;
  line: number;
  throttleLimit: number | null;
}

/**
 * Every route decorator in a controller, with the `@Throttle` limit that
 * precedes it when there is one.
 *
 * Comments are blanked first: this file's own header has to name the decorators
 * it looks for, and the prose in the controllers explains the limits.
 */
function routesOf(controller: string): Route[] {
  const raw = fs.readFileSync(path.join(__dirname, controller), "utf8");
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
  const lines = source.split("\n");
  const routes: Route[] = [];
  let pendingThrottle: number | null = null;
  for (const [index, line] of lines.entries()) {
    const throttle = /@Throttle\(\{[^}]*limit:\s*([\d_]+)/.exec(line);
    if (throttle) {
      pendingThrottle = Number(throttle[1].replace(/_/g, ""));
      continue;
    }
    const route = /@(Get|Post|Patch|Put|Delete)\(\s*(?:"([^"]*)")?/.exec(line);
    if (route) {
      routes.push({
        controller,
        method: route[1],
        route: route[2] ?? "",
        line: index + 1,
        throttleLimit: pendingThrottle,
      });
      pendingThrottle = null;
      continue;
    }
    // A blank line or another decorator keeps the pending throttle; anything
    // that is code ends its reach.
    if (line.trim() !== "" && !line.trim().startsWith("@")) {
      pendingThrottle = null;
    }
  }
  return routes;
}

describe("push routes are rate-limited", () => {
  const routes = CONTROLLERS.flatMap(routesOf);

  it("finds the routes it is meant to check", () => {
    // A parser that stops matching would make every assertion below vacuous.
    const names = routes.map((r) => `${r.method} ${r.route}`);
    expect(names).toContain("Post test");
    expect(names).toContain("Post vapid/rotate");
    expect(routes.length).toBeGreaterThanOrEqual(7);
  });

  it("throttles every mutating route", () => {
    const unthrottled = routes
      .filter((r) => r.method !== "Get")
      .filter((r) => r.throttleLimit === null)
      .map((r) => `${r.controller}:${r.line} ${r.method} ${r.route}`);
    expect(unthrottled).toEqual([]);
  });

  it("keeps every mutating route inside the ceiling", () => {
    const tooHigh = routes
      .filter((r) => r.method !== "Get" && r.throttleLimit !== null)
      .filter((r) => (r.throttleLimit as number) > MAX_LIMIT)
      .map((r) => `${r.method} ${r.route}: ${r.throttleLimit}`);
    expect(tooHigh).toEqual([]);
  });

  it("holds the two expensive routes to the tightest bound", () => {
    // The fan-out and the rotation are the two that spend a deployment-wide
    // resource, so they carry the same limit as the other expensive outbound
    // operations in this repository rather than the module's ceiling.
    for (const name of ["test", "vapid/rotate"]) {
      const route = routes.find((r) => r.route === name && r.method === "Post");
      expect(route?.throttleLimit).toBe(5);
    }
  });
});
