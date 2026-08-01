import { Logger } from "@nestjs/common";
import { getRequestContext, requestContextStorage } from "../request-context";
import { UUID_REGEX } from "../query-param-utils";

/**
 * Ambient-context helpers for code with no HTTP request (guards/strategies,
 * cron jobs, seeders, backup restore). They seed the same AsyncLocalStorage
 * scope the RequestContextInterceptor does, so every `withScopedDb` inside `fn`
 * emits the matching GUC. They hold no connection and need no cleanup.
 *
 * Importing this module is restricted to an allowlist by lint (task L1) so the
 * `withSystemContext` bypass cannot metastasize: widening the allowlist is a
 * reviewed decision, not a drive-by fix. See the RLS design doc, Phase 4.
 */

const bypassLogger = new Logger("SystemContext");

// Rate-limit the bypass audit log per call site so a hot cron/job path does not
// flood the logs while still making every distinct bypass site observable.
const BYPASS_LOG_INTERVAL_MS = 60 * 1000;
const lastBypassLogByCallSite = new Map<string, number>();

/**
 * Seed a *user* context: `withScopedDb` will emit `app.current_user_id` /
 * `app.real_user_id` for this user. Validates the id is a UUID -- a garbage
 * value would make every policied statement raise 22P02 at enforcement, so we
 * fail here, at the wrap site, instead.
 */
export function withUserContext<T>(userId: string, fn: () => T): T {
  if (!UUID_REGEX.test(userId)) {
    throw new Error(
      `withUserContext requires a valid UUID userId (got "${userId}")`,
    );
  }
  return requestContextStorage.run({ userId }, fn);
}

/**
 * Seed a *delegation* context: the effective user is the owner whose data is
 * being acted on, the authenticated user is the delegate doing the acting, so
 * `withScopedDb` emits `app.current_user_id = owner` and
 * `app.real_user_id = delegate`.
 *
 * `withUserContext` cannot express this. It seeds one id into both GUCs, which
 * collapses a delegate request onto a single identity -- and the three special
 * policies M2 wrote for delegation (`users`, `account_delegates`,
 * `delegate_account_favourites`, plus the authenticated-user arm on
 * `user_preferences` / `trusted_devices` / `refresh_tokens`) each need the two
 * ids to differ. Seeding only the delegate hides the owner's rows; seeding only
 * the owner hides the delegate's own. Both failures return zero rows rather than
 * raising, inside ordinary request scope where nothing logs -- which is exactly
 * why this has its own helper instead of a second `withUserContext` call.
 *
 * Callers are the two places that hold both ids before the request scope exists:
 * `jwt.strategy`'s acting-context re-validation and `AccountDelegateGuard`.
 */
export function withDelegateContext<T>(
  ownerUserId: string,
  delegateUserId: string,
  fn: () => T,
): T {
  for (const [label, id] of [
    ["ownerUserId", ownerUserId],
    ["delegateUserId", delegateUserId],
  ] as const) {
    if (!UUID_REGEX.test(id)) {
      throw new Error(
        `withDelegateContext requires a valid UUID ${label} (got "${id}")`,
      );
    }
  }
  return requestContextStorage.run(
    { userId: ownerUserId, realUserId: delegateUserId },
    fn,
  );
}

/**
 * Extend the ambient context with `preserveTimestamps`, so every transaction
 * `withScopedDb` opens inside `fn` emits `app.preserve_timestamps` and the
 * GUC-aware `updated_at` trigger (migration M1) keeps supplied values instead
 * of stamping. This is the backup restore's replacement for the old
 * `ALTER TABLE ... DISABLE TRIGGER` DDL (task C5): a plain flag on the caller's
 * own identity, no system bypass, and it works in every RLS mode -- the GUC
 * emission is deliberately not mode-gated (see scoped-db.ts).
 *
 * Identity is inherited, not granted: with no ambient user/system context,
 * `withScopedDb` inside `fn` still throws exactly as it would without this
 * wrapper.
 */
export function withPreserveTimestamps<T>(fn: () => T): T {
  return requestContextStorage.run(
    { ...getRequestContext(), preserveTimestamps: true },
    fn,
  );
}

/**
 * Seed a *system* context: `withScopedDb` will emit `app.bypass_rls` so the body
 * can read/write across users (admin, auth bootstrap, cron fan-out, seeders,
 * emergency-access claim, expiry sweeps). Each invocation is logged (rate-
 * limited, with its call site) so bypass usage is auditable in prod.
 */
export function withSystemContext<T>(fn: () => T): T {
  auditBypassInvocation();
  return requestContextStorage.run({ system: true }, fn);
}

function auditBypassInvocation(): void {
  const callSite = resolveCallSite();
  const now = Date.now();
  const last = lastBypassLogByCallSite.get(callSite) ?? 0;
  if (now - last < BYPASS_LOG_INTERVAL_MS) {
    return;
  }
  lastBypassLogByCallSite.set(callSite, now);
  bypassLogger.log(`RLS bypass (withSystemContext) entered from ${callSite}`);
}

/**
 * Best-effort caller location: the first stack frame outside this module.
 * Used only as a rate-limit key and a log detail, so an "unknown" fallback is
 * harmless.
 */
function resolveCallSite(): string {
  return callSiteFromStack(new Error().stack);
}

// This module's own frames (with-context.ts / with-context.js). The
// `\.(?:ts|js)` anchor deliberately does NOT match a `with-context.spec.ts`
// caller, so a test (or any legitimately similarly-named caller) is reported,
// not skipped.
const OWN_FRAME = /with-context\.(?:ts|js)/;

/**
 * Extract the first caller frame from a stack trace, skipping this module's own
 * frames. Exported for unit testing; returns "unknown" when the stack is absent
 * or holds no external frame.
 */
export function callSiteFromStack(stack: string | undefined): string {
  if (!stack) {
    return "unknown";
  }
  for (const raw of stack.split("\n").slice(1)) {
    const line = raw.trim();
    if (line.startsWith("at ") && !OWN_FRAME.test(line)) {
      return line.replace(/^at\s+/, "");
    }
  }
  return "unknown";
}
