import { AppModule } from "./app.module";

/**
 * Every module in the graph resolves to a real class.
 *
 * The failure this guards is invisible to every other suite. Module files are
 * CommonJS, so a circular `import` between two of them hands the second one a
 * half-filled `exports` object: the `@Module({ imports: [...] })` decorator
 * evaluates with `undefined` in the array, and Nest refuses to build the
 * application at boot with "Nest cannot create the module instance" -- naming a
 * module, not the edge that broke it. Unit specs assemble their own testing
 * modules and never touch `AppModule`, so a new module edge that closes a cycle
 * ships green and fails on container start (issue #1247 added
 * NotificationsModule -> ScheduledTransactionsModule and BudgetsModule ->
 * ScheduledTransactionsModule).
 *
 * `forwardRef(() => X)` is the fix, and it is what this spec checks is present
 * wherever it is needed: the metadata is read exactly as Nest reads it, so a
 * missing one shows up here as an `undefined` entry.
 *
 * This walks metadata only -- no provider is instantiated and no database
 * connection is opened, so it stays a unit test.
 */
describe("module graph", () => {
  type ModuleClass = { name?: string };
  type ForwardRefLike = { forwardRef: () => unknown };
  type DynamicModuleLike = { module: unknown };

  const isForwardRef = (entry: unknown): entry is ForwardRefLike =>
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as ForwardRefLike).forwardRef === "function";

  const isDynamicModule = (entry: unknown): entry is DynamicModuleLike =>
    typeof entry === "object" &&
    entry !== null &&
    "module" in (entry as DynamicModuleLike);

  /**
   * Unwrap whatever an `imports` entry can be into the module class itself:
   * Nest accepts a class, a `forwardRef`, a `DynamicModule`, and a promise of
   * either of the last two.
   */
  const resolveEntry = async (entry: unknown): Promise<unknown> => {
    if (entry instanceof Promise) return resolveEntry(await entry);
    if (isForwardRef(entry)) return resolveEntry(entry.forwardRef());
    if (isDynamicModule(entry)) return resolveEntry(entry.module);
    return entry;
  };

  it("resolves every imports entry to a class (no circular-import holes)", async () => {
    const problems: string[] = [];
    const seen = new Set<unknown>();
    const queue: unknown[] = [AppModule];

    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);

      const imports: unknown[] =
        Reflect.getMetadata("imports", current as object) ?? [];
      for (const [index, entry] of imports.entries()) {
        const resolved = await resolveEntry(entry);
        if (typeof resolved !== "function") {
          problems.push(
            `${(current as ModuleClass)?.name ?? String(current)} imports[${index}] is ` +
              `${String(resolved)} -- a circular module import that needs forwardRef(() => X)`,
          );
          continue;
        }
        queue.push(resolved);
      }
    }

    expect(problems).toEqual([]);
    // A sanity floor: if the walk found almost nothing, it is measuring the
    // wrong thing rather than proving the graph is clean.
    expect(seen.size).toBeGreaterThan(20);
  });
});
