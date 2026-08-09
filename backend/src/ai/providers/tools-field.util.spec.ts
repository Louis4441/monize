import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { AiToolDefinition } from "./ai-provider.interface";
import { toolsField } from "./tools-field.util";

const tool = (name: string): AiToolDefinition => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object", properties: {} },
});

describe("toolsField", () => {
  it("omits the field entirely for an empty list", () => {
    const field = toolsField([], (t) => t.name);

    expect(field).toEqual({});
    // Not `{ tools: undefined }` -- a present-but-undefined key still
    // serializes into some request builders.
    expect("tools" in field).toBe(false);
  });

  it("emits the mapped list when there are tools", () => {
    expect(toolsField([tool("a"), tool("b")], (t) => t.name)).toEqual({
      tools: ["a", "b"],
    });
  });

  it("spreads to nothing, leaving the rest of the request untouched", () => {
    expect({ model: "m", ...toolsField([], (t) => t.name) }).toEqual({
      model: "m",
    });
  });

  it("does not call the mapper when there is nothing to map", () => {
    const map = jest.fn();
    toolsField([], map);
    expect(map).not.toHaveBeenCalled();
  });
});

/**
 * A provider that writes `tools:` straight into its request object sends
 * `tools: []` on a tool-free turn, which OpenAI rejects outright -- so the AI
 * Assistant's final synthesis pass would 400 instead of answering. The rule is
 * mechanical, so it gets a scan rather than a paragraph: every provider must
 * route the field through `toolsField`.
 */
describe("providers build the tools field through toolsField", () => {
  const dir = __dirname;
  const providerFiles = readdirSync(dir).filter(
    (f) => f.endsWith(".provider.ts") && !f.endsWith(".spec.ts"),
  );

  it("finds the provider sources to scan", () => {
    // A scan that silently matches nothing passes forever.
    expect(providerFiles.length).toBeGreaterThanOrEqual(5);
  });

  it.each(providerFiles)("%s sets no bare tools field", (file) => {
    const source = readFileSync(join(dir, file), "utf8");
    const offenders = source
      .split("\n")
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      // `tools:` as an object-literal key. `...toolsField(...)` and
      // `...ollamaTools` are spreads, so they do not match; the
      // `tools: AiToolDefinition[],` method parameters are a type
      // annotation, which is excluded by shape rather than by name so a
      // renamed type does not quietly disarm the scan.
      .filter(
        ({ line }) =>
          /^tools:/.test(line) && !/^tools:\s*[A-Z][\w.]*\[\],?$/.test(line),
      );

    expect(offenders).toEqual([]);
  });

  it("at least one provider actually uses the helper", () => {
    const users = providerFiles.filter((f) =>
      readFileSync(join(dir, f), "utf8").includes("toolsField("),
    );
    expect(users.length).toBeGreaterThan(0);
  });
});
