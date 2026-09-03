# MCP Server

Monize exposes its financial data over the **Model Context Protocol** so MCP clients (Claude Desktop's "Add Connector", IDE agents, etc.) can query and act on a user's finances. This directory is the whole server: transport, the per-session `McpServer` factory, and the tool/resource/prompt definitions. Built on `@modelcontextprotocol/sdk` (`McpServer` + `StreamableHTTPServerTransport`).

## Architecture

- **Transport** (`mcp-http.controller.ts`): Streamable HTTP at `POST/GET/DELETE /mcp`. One transport + one `McpServer` per session, keyed by the `Mcp-Session-Id` header; 1h TTL, per-user cap, periodic cleanup. `@SkipCsrf()` + bearer auth only (no cookies).
- **Auth** (`validatePat`): `Authorization: Bearer <token>`. `pat_*` tokens go through `PatService`; everything else is treated as an OAuth 2.1 access token (`OAuthProviderService`). A 401 returns `WWW-Authenticate` with `resource_metadata` (RFC 9728) pointing at `/.well-known/oauth-protected-resource`.
- **Server factory** (`mcp-server.service.ts`): `createServer(resolve)` builds a fresh `McpServer`, sets `instructions` + capabilities, and registers every tool/resource/prompt. The server `version` is read from `backend/package.json` -- never hardcode it.
- **Per-request user context** (`mcp-context.ts`): handlers call `resolve(extra.sessionId)` to get `{ userId, scopes }`; `userId` always comes from the session, never from tool arguments.

## Directory layout

```
mcp/
  mcp-http.controller.ts     # Streamable HTTP transport + sessions + auth
  mcp-server.service.ts      # createServer(): wires everything onto an McpServer
  mcp-context.ts             # resolve, requireScope, toolResult/toolError, sanitization
  mcp-annotations.ts         # shared tool annotation presets (READ_ONLY/CREATE/UPDATE)
  mcp-write-limiter.ts       # per-user daily write cap for mutating tools
  mcp-elicitation-support.ts # what each session's client does with elicitation
  tool-output-schemas.ts     # one Zod output schema (raw shape) per tool
  tools/<domain>.tool.ts     # tool definitions, grouped by domain
  resources/<name>.resource.ts
  prompts/<name>.prompt.ts
  mcp.module.ts              # NestJS providers/imports
```

Each tool/resource/prompt is an `@Injectable()` class with a `register(server, resolve)` method, listed in both `mcp.module.ts` (providers) and `mcp-server.service.ts` (wired into `createServer`).

## Adding a tool (required format)

Every tool MUST declare **`title`**, **`description`**, **`inputSchema`**, **`outputSchema`**, and **`annotations`**. The handler MUST resolve context, check scope, run inside try/catch, and return via `toolResult` / `safeToolError`.

```typescript
server.registerTool(
  "get_thing",
  {
    title: "Get thing",                 // human-readable display name
    annotations: READ_ONLY,             // from mcp-annotations.ts
    description: "What it does and when to use it (guide the model).",
    inputSchema: {                      // Zod raw shape; {} if no args
      id: z.string().uuid().describe("Thing ID"),
    },
    outputSchema: getThingOutput,       // from tool-output-schemas.ts
  },
  async (args, extra) => {
    const ctx = resolve(extra.sessionId);
    if (!ctx) return toolError("No user context");
    const check = requireScope(ctx.scopes, "read");
    if (check.error) return check.result;
    try {
      const data = await this.thingService.getLlmThing(ctx.userId, args.id);
      return toolResult(data);
    } catch (err: unknown) {
      return safeToolError(err);        // never leak 5xx internals
    }
  },
);
```

Checklist for a new tool:

1. Put the data logic on the **domain service** (e.g. `getLlm*`), not in the tool. Per the repo rule, the same logic is shared with the AI Assistant tool executor and both must return the same shape -- wire both surfaces in the same PR.
2. Add the tool to its domain `tools/*.tool.ts` with the five config fields above.
3. Add its output schema to `tool-output-schemas.ts` (conventions below) and import it.
4. Pick the right annotation preset (below).
5. If it mutates data, derive scope `"write"`, enforce the daily write limit via `McpWriteLimiter` (see `transactions.tool.ts`), and sanitize user strings with `stripHtml(...)` before persisting. Gate the write behind a user confirmation with `confirmWrite(server, message, extra.requestId)` (pass `extra.requestId` so the elicitation is delivered on the tool call's own SSE stream, not the standalone GET stream); persist only on `"accepted"`/`"unsupported"`, return a `toolError` without writing on `"declined"`. `"unsupported"` means no dialog reached a human -- the client still gates every tool call with its own approval prompt, so proceeding is not a consent bypass.
   - **Relay first.** When the call is serving a prompt the user typed in the Monize web chat (reverse relay), confirm there instead: build the signed `PendingAiAction` with `AiActionBuilderService` (shared with the AI Assistant tool executor) and emit it. If the card is shown in the browser (committed via `/ai/actions/confirm` on approval), return `RELAY_PREVIEW_SHOWN` and do NOT write or `confirmWrite`; otherwise fall through to `confirmWrite`.
6. Update `mcp-server.service.ts` count and `mcp.module.ts` if it's a new provider class.
7. Add/extend tests (below). `mcp-annotations.spec.ts` enforces that every tool has title + input/output schema + annotations with the right read/write hints -- bump `EXPECTED_TOOL_COUNT` and `WRITE_TOOLS`/`IDEMPOTENT_WRITES`.

## An advertised capability is not evidence; observed behaviour is

`confirmWrite` used to read `getClientCapabilities().elicitation.form` as proof that a confirmation dialog could be shown, and therefore treated every failure of that dialog as the user saying no. `@modelcontextprotocol/sdk` >= 1.23 rewrites the legacy 2025-06-18 shape `{"elicitation":{}}` into `{"elicitation":{"form":{}}}` before `getClientCapabilities()` ever sees it, so the check stopped separating a client that shows dialogs from one that answers `-32601` or never answers at all -- and every write through such a client was refused, or hung until the client abandoned the tool call. **A capability the SDK synthesizes cannot carry a decision.**

So the outcome decides, not the advertisement:

- Only a returned `action` is a user's answer. A rejection whose code says the client answered for itself (`clientAnsweredForItself` in `mcp-elicitation-support.ts`: method not found, invalid request/params, parse error, connection closed, request timeout) is `"unsupported"`; an unaccounted-for failure shape stays `"declined"`, so a case nobody has reasoned about refuses the write.
- Behaviour is remembered per session, in a `WeakMap` keyed on the session's `McpServer` so the record dies with the session. A client caught answering for itself is not asked again (the round trip costs `CONFIRM_TIMEOUT_MS` per row otherwise); a client that has answered once is never demoted, so a later unanswered dialog on it is `"declined"`.
- **The wait must expire before the client abandons the tool call waiting on it.** Claude's MCP tool deadline is 60s; a five-minute server-side wait produced no result at all, only an opaque client-side timeout. `mcp-context.spec.ts` fails if `CONFIRM_TIMEOUT_MS` leaves that range, and pins the SDK normalization above so it cannot silently become load-bearing again.

## A relay turn belongs to one MCP session, for a bounded time

The same user can have two MCP sessions at once -- the agent running the web-chat relay loop, and a direct client (Claude Desktop) they are typing at. Only one is serving a browser prompt, so **"does this write belong to the web chat" is a question about the calling session, not about the user**.

- Emit a card with `emitRelayCard(this.relayService, userId, action)` (`mcp-relay-confirm.ts`), never `relayService.emitPendingAction` directly: the helper supplies the ambient MCP session id the decision depends on. `mcp-relay-confirm.spec.ts` scans the tool sources and fails on a direct call.
- A relay turn is a prompt **claimed by this session** (`waitForPrompt` records `claimedBy`), or one of its claims that timed out within the late-answer retention window. It is not connection liveness, not user-wide, and not unbounded in time -- each of those was tried, and each routed a direct client's confirmation into a web chat nobody was watching (the worst version captured every direct write the user made afterwards, permanently).
- Liveness is session-scoped for the same reason: a direct client's tool calls are not evidence that another session's agent is still working.

## `toolResult` and structured content

`toolResult(data)` is the only success path. It sanitizes every string in the payload (`sanitizeToolResultStrings`), normalizes non-finite numbers to `null`, and returns **`structuredContent` alone**: objects pass through; bare arrays are wrapped under `items`; primitives under `value`.

**It deliberately does not also emit the payload as a text block.** The spec suggests a serialized-JSON `content` entry for clients too old to read `structuredContent`, and this server did that -- pretty-printed, so every answer travelled twice and a model paid for both halves. A page of transactions or a portfolio summary dwarfs the tool definition that asked for it, so the duplicate was the larger half of the per-request cost. The trade is explicit: a client that cannot read `structuredContent` now sees an empty result rather than a degraded one, and restoring the block is a one-line change in `mcp-context.ts`. Errors keep their text (`toolError` carries no structured content and bypasses output validation).

A tool's own spec therefore asserts on `result.structuredContent`, not on parsed `content[0].text`.

## A tool definition is paid for on every request

Every byte of `tools/list` -- title, description, both schemas, annotations -- rides in the model's context on **every** request, and the server instructions ride beside it. This payload reached 78,207 bytes (~11,600 tokens) for 20 tools before anything measured it, because each defect fix appended a paragraph and the same fact was stated in the tool description, again in the field's `.describe()`, and again in the instructions.

A fact lives in exactly one place:

| Place | Carries |
|---|---|
| `description` | What the tool does, when to prefer it, and the one or two semantics a model gets wrong (a withheld total, an editing contract). |
| A field's `.describe()` | How to fill *that* field, terse. An enum's own field is where its members are explained. |
| Server `instructions` | Cross-tool conventions, once: signed amounts, name resolution, date formats, the approval rule shared by every `manage_*` tool. |

- **Never restate an enum's members in prose.** The `z.enum` already ships them.
- **Never describe another surface or the codebase's history.** "Returns the same shape as the AI Assistant's tool" and "replaces the former get_accounts" guide nobody holding this tool.
- **Shared input shapes live in `tools/schema-fragments.ts`** (`uuidString`, `ymdDate`, `nameList`, `manageOperation`, `approvalMode`, `dryRun`, `itemsArray`). `z.string().uuid()` emits `format: "uuid"` *and* a 166-character pattern, per tool; the fragment is 75 characters. Its regex carries no flags on purpose -- zod serializes `regex.source`, so a flag would be enforced by the server's parse and silently absent from the client's schema. `schema-fragments.guard.spec.ts` fails on a second copy.
- **Guidance for one kind of turn travels with that turn.** The relay's heartbeat and batching rules are returned as `guidance` on a claimed prompt (`relay-guidance.ts`), not carried by every client that never relays.

`tools-list-budget.spec.ts` serializes the real `tools/list` through the SDK and fails above a per-tool cap, a total cap and an instructions cap, printing the whole table on failure. The caps are a **ratchet**: lower one when a tool shrinks; raising one is a reviewed decision, not the fix for a red build. It also pins the listed order (2026-07-28 asks for a deterministic one) and scans for restated enum lists and banned phrases.

## Output schema conventions (`tool-output-schemas.ts`)

Each export is a **loose `z.object`** built with `toolOutput(...)` -- a schema instance, which `registerTool` accepts alongside a raw shape.

**The declaration does not decide what reaches the caller.** The server validates `structuredContent` with `safeParseAsync` and then sends the handler's *original* object, so no field is ever stripped on the way out. What it decides is the JSON Schema the **client** validates against with ajv: a raw shape is wrapped in a strip-mode object, serialized as `additionalProperties: false`, and the client then rejects the very fields the tools return. Loose emits `additionalProperties: {}`.

So declare what a model must **reason about**, and let the rest ride in the payload:

- **Declare** totals, counts, completeness flags (`fxComplete`, `valuationComplete`, `amountsComplete`, and the per-account ones -- an account's totals are in *its* currency, so a global flag cannot speak for them), the currency a total is in (`totalsCurrency`), a `known*Subtotal`, a skipped row's `reason`, and any id the model must copy back (`securityId`, a scheduled item's `id`, an attachment's `uri`).
- **Do not declare** row-level display columns. `rows()` is `z.array(looseObject({}))`.
- Build every nested object with `looseObject(...)`, never a bare `z.object(...)`.
- Money/decimals are numbers at runtime (entity `numericTransformer`). Use the shared `num` (`z.number().nullable()`). A divide-by-zero percentage is `NaN`, which `toolResult` normalizes to `null`. Do **not** use `z.nan()`: the SDK's JSON Schema serialization throws, failing the entire `tools/list` response and leaving every client showing zero tools.
- Use `.nullable()` for documented-null fields and `.optional()` for fields that may be absent, including alternate result branches.
- Array-returning tools wrap under `items`, matching `toolResult`'s array wrapping.

`tool-output-schemas.spec.ts` asserts the property the shallowness depends on: an undeclared field, top-level and inside a row, still reaches the client. Its `listTools()` call is load-bearing -- the client builds its output validator there, so a `callTool` without it validates nothing and the assertion would prove nothing.

## Annotation presets (`mcp-annotations.ts`)

All tools operate on the user's own closed dataset, so `openWorldHint` is always `false`. Pick by effect:

| Preset | Use for | Hints |
|--------|---------|-------|
| `READ_ONLY` | queries/aggregations/`calculate` | `readOnlyHint: true` |
| `CREATE` | adds a new record | `readOnlyHint:false, destructiveHint:false, idempotentHint:false` |
| `UPDATE` | sets fields to given values | `readOnlyHint:false, destructiveHint:false, idempotentHint:true` |

There is no destructive preset for a read tool. The four `manage_*` tools take `operation: "delete"` and are annotated `destructiveHint: true`.

**A scanner flagging "delete" in those descriptions is reporting a real capability, not a defect.** Do not reword it away: a description that hides what the tool can do is worse than the finding. The mitigations are the annotation, the `write` scope, `McpWriteLimiter`'s daily cap, and a user confirmation before every write (a relay card, or an elicitation dialog). `lookup_securities` is the one rename that was worth making -- its text field is `search`, matching every other read tool, because `query` was flagged purely as a name and nothing there builds SQL.

## Scopes

`requireScope(ctx.scopes, ...)` gates each handler. Scopes in use: `read` (queries, including report/anomaly tools) and `write` (mutations). Resources gate with `hasScope(ctx.scopes, "read")`. There is no separate `reports` scope: the OAuth layer only issues `monize:read`/`monize:write`, so reports are folded into `read`.

## Resources & prompts

- **Resources** (`registerResource`): `title` + `description`, return `contents[]` with `mimeType: "application/json"` and the JSON `text`. Same context-resolve + `hasScope` check; on error return a `contents` entry with an `Error: ...` text rather than throwing.
- **Prompts** (`registerPrompt`): `title` + `description` + `argsSchema` (Zod raw shape of optional args), return `messages[]`. Prompts are templates only -- no data access, no scope check.

## Security (do not regress)

- `userId` is always from the session context, never from tool args.
- Sanitize user-controlled strings written back: `stripHtml()` before persist; `toolResult` runs `sanitizeToolResultStrings` on all outgoing strings.
- `safeToolError` passes through 4xx messages but returns a generic message for 5xx/unknown errors -- never leak internals.
- Transport is bearer-only and `@SkipCsrf()`; do not add cookie auth here.

## Testing

Tools/resources/prompts unit tests mock `registerTool`/`registerResource`/`registerPrompt` to capture the handler, then drive it with a mocked service and assert on `result.content[0].text` (parsed JSON) and `result.isError`. Plus:

- `mcp-annotations.spec.ts` -- every tool has title + input/output schema + annotations with correct read/write hints (update its constants when adding a tool).
- `tool-output-schemas.spec.ts` -- each output schema accepts a representative `toolResult` payload (incl. NaN, null, and alternate branches), and an end-to-end round-trip through the real SDK via `InMemoryTransport`.
- `mcp-server.service.spec.ts` -- registration counts and that the advertised version tracks `package.json`.

## Spec compliance notes

Implemented: Streamable HTTP transport, session management, OAuth 2.1 + RFC 9728 protected-resource metadata, tools (title/description/input+output schema/annotations), resources (title/description/mimeType), prompts (title/description/arguments), logging/tools/resources/prompts capabilities.

Intentionally not implemented: `completions` (argument autocompletion) and resource `subscribe`/`listChanged`. DNS-rebinding protection on the transport is omitted because auth is bearer-only (no ambient browser credentials to steal). Add these if a client need arises.
