import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Blank comments while keeping line numbers, so an offender report still points
 * at the right line and prose may name the banned shape.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The identifiers a file binds to the raw Express response with `@Res()`.
 * Derived per file rather than assumed to be `res`, because the ban has to
 * follow the parameter's real name and must not catch an unrelated `response`
 * (a `fetch` result, a provider reply) in a file that never touches `@Res()`.
 */
function resParameterNames(source: string): string[] {
  const names = new Set<string>();
  const decl = /@Res\(\s*\)\s*([A-Za-z_$][\w$]*)/g;
  for (let m = decl.exec(source); m; m = decl.exec(source)) {
    names.add(m[1]);
  }
  return [...names];
}

/**
 * A `@Res()` handler sends the response and returns nothing.
 *
 * `return res.json(...)` reads as a tidy early exit, and the reply it sends is
 * correct -- but the value a handler returns still travels through the global
 * interceptor chain, and `ClassSerializerInterceptor` is registered app-wide
 * (`app.module.ts`). Handed an Express `Response`, `instanceToPlain` walks the
 * live object graph (`res` -> `socket` -> `_events`) and *calls* the Node HTTP
 * internals it finds on the way with a plain object as the receiver. Node's
 * socket bookkeeping is cleared by that walk, so when the already-sent response
 * finishes, `ServerResponse.detachSocket` fails its own assertion and the
 * process dies with an uncatchable `ERR_INTERNAL_ASSERTION`.
 *
 * That is not a theory about a Node bug: the reply is on the wire before the
 * crash, which is why it read as "the backend restarts right after the 2FA
 * challenge" and locked every 2FA account out of the product. Three of the five
 * sites that had this shape were on the unauthenticated auth surface.
 *
 * `Promise<void>` on a handler is the stronger form of the same rule and is
 * preferred where a handler is being touched; this scan is what covers the 30-odd
 * `@Res()` handlers that carry no explicit return type.
 */
describe("a @Res() handler returns nothing", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds the @Res() handlers it is meant to scan", () => {
    const withRes = files.filter(
      (file) => resParameterNames(readFileSync(file, "utf8")).length > 0,
    );
    // A regression in `resParameterNames` would empty the scan and read green.
    expect(withRes.length).toBeGreaterThan(5);
  });

  it("no handler returns the raw Express response", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const names = resParameterNames(source);
      if (names.length === 0) continue;
      const banned = bannedReturn(names);
      const lines = stripComments(source).split("\n");
      for (const [index, line] of lines.entries()) {
        if (banned.test(line)) {
          offenders.push(`${relative(SRC_ROOT, file)}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the scan recognises the shape it was written for", () => {
    const banned = bannedReturn(["res"]);

    expect(banned.test("    return res.json({ requires2FA: true });")).toBe(
      true,
    );
    expect(banned.test("    return res.status(405).end();")).toBe(true);
    expect(banned.test("    return res;")).toBe(true);
    // The fixed shape, and a return of something that merely reads from the
    // response, are both fine.
    expect(banned.test("    res.json({ requires2FA: true });")).toBe(false);
    expect(banned.test("    return;")).toBe(false);
    expect(banned.test("    return resolveFxRate(date);")).toBe(false);
    expect(banned.test("    return response.ok;")).toBe(false);
  });

  it("the scan reads code, not prose", () => {
    const banned = bannedReturn(["res"]);
    const prose = "/**\n * Never `return res.json(...)` from a handler.\n */\n";
    const code = "    return res.json({ ok: true });\n";

    expect(banned.test(stripComments(prose))).toBe(false);
    expect(banned.test(stripComments(code))).toBe(true);
    // Blanking keeps the line count, so reported line numbers stay true.
    expect(stripComments(prose).split("\n")).toHaveLength(
      prose.split("\n").length,
    );
  });

  it("the parameter scan follows the declared name", () => {
    expect(resParameterNames("async get(@Res() res: Response) {}")).toEqual([
      "res",
    ]);
    expect(resParameterNames("async get(@Res() reply: Response) {}")).toEqual([
      "reply",
    ]);
    expect(resParameterNames("const r = await fetch(u); return r.ok;")).toEqual(
      [],
    );
  });
});

/**
 * `return <resName>` on its own or followed by a member access. Anything else
 * that happens to start with the same letters (`resolveFxRate`) is excluded by
 * requiring the identifier to end there.
 */
function bannedReturn(names: string[]): RegExp {
  const alternatives = names.map((name) => name.replace(/\$/g, "\\$"));
  return new RegExp(`\\breturn\\s+(?:${alternatives.join("|")})\\s*[.;)]`);
}
