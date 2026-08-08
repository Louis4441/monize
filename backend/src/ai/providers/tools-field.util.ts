import { AiToolDefinition } from "./ai-provider.interface";

/**
 * Build the `tools` field of a provider request, omitting it entirely when
 * there are no tools to offer.
 *
 * Every provider must spread this rather than writing `tools: tools.map(...)`
 * directly. An empty array is not the same as an absent field: OpenAI rejects
 * `tools: []` outright ("Invalid 'tools': empty array"), so a caller that
 * genuinely wants a tool-free turn -- the AI Assistant's final synthesis pass,
 * which hands the model the data it already gathered and asks for an answer --
 * would get a 400 instead of a completion.
 *
 * Callers that always pass a populated list are unaffected: the field is
 * emitted exactly as before.
 */
export function toolsField<T>(
  tools: AiToolDefinition[],
  map: (tool: AiToolDefinition) => T,
): { tools?: T[] } {
  return tools.length > 0 ? { tools: tools.map(map) } : {};
}
