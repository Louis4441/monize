# Backend: modules, boot, environment and logging

Module wiring (require cycles, test stubs), the global providers and `main.ts` setup, environment knobs and whose resource they configure, logging shape, the OIDC provider, CodeQL and the demo login. Read this before adding a module edge, an environment variable, a log line or a boot-time hook.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## An edge on a require cycle is deferred, or it is `undefined`

Module and service files are CommonJS, so a circular `import` hands the second
file a half-filled `exports`: the `@Module({ imports: [...] })` array holds an
`undefined`, or a constructor's reflected parameter type does, and Nest refuses
to build the application -- "Nest cannot create the NetWorthModule instance...
index [1] ... is undefined", or "can't resolve dependencies of the
ScheduledTransactionsService (AccountsService, TransactionsService, ?, ...)".

**Whether it bites depends on which file `require` reached first**, so the same
code boots from one entry point and dies from another: `AppModule` from the
compiled server entry point, `TransactionsModule` from an integration
`RootTestModule`,
whichever module a spec happens to import. Issue #1247 shipped green through
`npm run test:unit` and took out the integration suite, all four E2E shards and
Lighthouse.

The rule is exact and it is checked: an `imports` entry, or a constructor
parameter, whose class can reach the declaring file back through `import`
statements must be `forwardRef(() => X)` / `@Inject(forwardRef(() => X))`.
`src/module-graph.spec.ts` proves it two ways -- statically over every load order
at once (naming the offending edge), then at runtime from every module file in
turn, walking `imports` and every provider's `design:paramtypes` as Nest reads
them. Reordering imports is not a fix; defer the edge.

## A stub standing in for a real module inherits its export list

`test/helpers/integration-setup.ts` replaces `ScheduledTransactionsModule` with
a stub, so that stub's `exports` are a claim about the real module. It derives
them from `Reflect.getMetadata("exports", ScheduledTransactionsModule)` rather
than restating them: a hand-written copy keeps compiling until a consumer of the
newly added export appears, and then eighteen suites fail somewhere else
entirely ("argument ScheduledOccurrenceService at index [5] is available in the
NotificationsModule module").

## Global Providers (app.module.ts)

Registered globally via `APP_FILTER`, `APP_GUARD`, `APP_INTERCEPTOR`:

| Provider | Purpose |
|----------|---------|
| `GlobalExceptionFilter` | Catches all exceptions; handles HttpException and TypeORM QueryFailedError |
| `ThrottlerGuard` | Rate limiting (100 requests/minute) |
| `CsrfGuard` | CSRF double-submit cookie validation |
| `MustChangePasswordGuard` | Blocks access until password change (admin-reset users) |
| `DemoModeGuard` | Restricts write operations in demo mode |
| `CsrfRefreshInterceptor` | Refreshes CSRF token cookie on responses |
| `ClassSerializerInterceptor` | Applies `@Exclude()` / `@Expose()` from class-transformer |

Also configured: `ConfigModule` (global), `TypeOrmModule` (async, PostgreSQL), `ThrottlerModule`, `ScheduleModule`.

## main.ts Setup

- **API prefix:** `api/v1`
- **Body limit:** 10mb (for large QIF file imports)
- **Swagger:** Enabled at `/api/docs` in non-production only
- **DATE column parser:** `pg.types.setTypeParser(1082, val => val)` -- returns DATE columns as strings to prevent timezone-related date shifting
- **Validation pipe:** Global with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`
- **Security:** Helmet (CSP, HSTS, frame-deny), CORS (credentials, configurable origins)
- **Cookie parser:** Required for OIDC state/nonce and auth tokens
- **Trust proxy:** Level 1 (Docker/nginx real client IP)

## A numeric env knob is declared as data, next to its documentation

Coerce every numeric environment variable through `resolvePositiveInt` (`src/common/env-number.util.ts`), never a bare `Number(...)` -- it separates *absent* from *invalid* so a typo is logged rather than silently running on the default. Where a feature has more than one knob, declare the set as one table of `{ envVar, default, description }` and resolve in a loop (`src/ai/query/query-budgets.ts` is the pattern). `query-budgets.spec.ts` checks `.env.example` in both directions: every declared budget documented with its current default, and no `AI_QUERY_*` line documenting a variable the code does not read.

## An environment variable configures the deployment's own resource, not somebody else's

The AI provider has two owners. `AI_DEFAULT_*` builds the **centrally managed** provider (the operator's, used when a user has configured none, editable nowhere in the UI); everything else in `ai_provider_configs` is a row a *user* created and can edit. So `AI_QUERY_*` sizes the central provider only; a user's provider carries the same five budgets as nullable columns, set in Settings -> AI, defaulting to the built-in numbers -- never to the environment. `resolveQueryBudgetsForConfig` is the single place that decision is made; `AiService.resolveToolUseProvider` hands the caller the configuration alongside the provider, and the transient system-default config is marked `isSystemDefault`.

Before adding an env var for anything a user can also configure, ask which resource it describes -- an operator's ceiling says nothing about a model somebody else is paying for, and the reverse mistake (a per-user knob for the operator's resource) hands out their budget. `query-budgets.spec.ts` holds the split from both sides; a stored value outside the declared range falls back to the documented default rather than being clamped. The bounds live in the same spec table as the defaults, so the DTO (`QueryBudgetFieldsDto`), the migration and the frontend form derive from one place; the form's copy is checked by `frontend/src/lib/ai-query-budgets.contract.test.ts`.

## Every line in the log has the same shape

`[Nest] pid - date LEVEL [Context] message`, produced by the NestJS `Logger` -- including the lines written before the app exists: `db-init`, `db-migrate`, `db-demo-check` and the seeders each construct `new Logger("<Context>")`. Backend `src/` bans `console` outright (`no-console` in `eslint.config.mjs`); the only exception is `oauth/oidc-provider-log-bridge.ts`, which must hold the real console methods to forward non-provider output. `docker-entrypoint.sh` prints nothing itself -- each step logs for itself. `src/startup-logging.spec.ts` scans for both mistakes and for `console` in any pre-boot script.

## OAuth / OIDC provider

**A page whose form submission must redirect off-origin needs its own CSP.** Helmet's app-wide `form-action 'self'` is enforced by Chrome against every redirect hop after a form submit, so the OAuth consent POST's final cross-origin hop to the client's `redirect_uri` was silently cancelled -- server logs `authorization.success`, browser parked on the consent form. The interaction controller sets a per-page `form-action 'self' https:` (`setInteractionPageHeaders`); the redirect_uri is per-client and dynamic, so it cannot be enumerated. Do not loosen the global Helmet `form-action` -- only this page needs it.

`node-oidc-provider` prints `oidc-provider NOTICE:`/`WARNING:` lines with bare `console.info`/`console.warn` and exposes no logger hook, so `oauth/oidc-provider-log-bridge.ts` -- installed at the top of `main.ts` -- re-routes exactly those lines to a `[OidcProvider]` logger. That fixes only the formatting: every such notice means a config option was left at its default, so fix the config. In particular, `ttl` needs an explicit number for every artifact the provider can issue (`AccessToken`, `AuthorizationCode`, `IdToken`, `RefreshToken`, `Grant`, `Interaction`, `Session`); the guard in `src/oauth/oauth-provider.service.spec.ts` fails when one is missing.

## CodeQL runs as default setup, and a suppression annotation closes nothing there

Code scanning on this repository is CodeQL *default setup*, which runs the standard code-scanning suite and never the alert-suppression query -- so a `codeql` bracket annotation in the source does not close an alert on the Security tab. Two of them sat in `password-breach.service.ts` and its spec for months, above the wrong line as well, while the `js/insufficient-password-hash` alerts they named stayed open. An accepted false positive (SHA-1 is what the HIBP k-anonymity protocol hashes with; `fingerprintPublicKey` in `push-config.service.ts` hashes a *public* key, which is not a password hash) is **dismissed on the Security tab, with its reason**, by someone with security-events write. Touching the flagged line in a PR re-reports the alert as new in that PR and fails its CodeQL check, so a false positive is dismissed first and its file left alone. Prefer a test fixture that carries a known hash over one that recomputes it: the spec now holds SHA-1("password123") as a constant, which proves the protocol against an independent value and gives CodeQL nothing to report. The annotation still goes in, on the line directly above the reported location -- the only line CodeQL's suppression library lets it cover, and for `js/insufficient-password-hash` that is the `.update(...)` call, not the `createHash` statement -- so it takes effect the day the suppression query is added to the analysis. `src/common/codeql-suppression.guard.spec.ts` fails an annotation that follows code on its line, names no query id, sits above a blank or a comment, or sits above the wrong line for a query it knows.

## The demo login is written once

`DEMO_USER_EMAIL` and `DEMO_USER_PASSWORD` live in `src/database/demo-credentials.ts`; the seed, the nightly reset, `db-demo-check` and the demo seeder import them. They are public by design (`.env.example` prints them, the login page pre-fills them), so the Bearer hard-coded-secret finding on that file is an accepted exception in `.github/workflows/ci.yml` -- one, not one per copy. `demo-credentials.spec.ts` fails a second spelling under `src/`, and the client's mirror (`frontend/src/lib/demo-credentials.ts`) is contract-tested against this file from its side.

## `.dockerignore` is not `.gitignore`: a filename glob needs an explicit `**/`

A slashless pattern matches only against the path relative to the build context, so `*.spec.ts` excludes nothing under `src/`. Give every filename glob a leading globstar, including its negation (`!**/.env.example`); `frontend/src/test/dockerignore.test.ts` scans all three files and fails on a bare one.

## Code and schema ship in one image; they do not arrive in one process

`db-migrate` runs at container start and the server after it, so "this build calls a SQL function" and "this database has it" are separate facts; the gap surfaces as `function ... does not exist` behind a generic 500. Every SQL function `src/` calls is declared once in `backend/src/common/db/required-db-functions.ts` with the migration that creates it, and both `main.ts` and `db-migrate` refuse to serve a database missing one. `required-db-functions.spec.ts` holds the list in both directions -- crucially, a function defined in `schema.sql` and mentioned anywhere in `src/` must be registered.

## Environment

Key env vars (see `.env.example` for full list):
- `JWT_SECRET` -- minimum 32 chars, enforced at startup
- `ENCRYPTION_KEY` -- minimum 32 chars; encrypts AI provider keys, emergency-access credentials and the stored backup password. Not yet enforced at startup (a deployment without one boots and is warned on every start that a future release will require it), but nothing that needs a secret works without it. `AI_ENCRYPTION_KEY` is the former name, still read and still preferred where both are set
- `DATABASE_*` -- PostgreSQL connection
- `DEMO_MODE=true` -- enables demo restrictions, daily reset at 4 AM UTC
- `LOCAL_AUTH_ENABLED` / `REGISTRATION_ENABLED` -- auth toggles
- `OIDC_*` -- OpenID Connect provider config
