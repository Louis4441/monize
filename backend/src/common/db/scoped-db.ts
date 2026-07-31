import { AsyncLocalStorage } from "node:async_hooks";
import { DataSource, EntityManager } from "typeorm";
import { getRequestContext } from "../request-context";
import { getRlsMode } from "./rls-config";

/**
 * The single sanctioned door to the database under Row-Level Security.
 *
 * `withScopedDb` opens a transaction, sets the identity GUC transaction-locally
 * (`set_config(..., true)`, i.e. `SET LOCAL` semantics) as its first statement,
 * and runs `fn` with the transaction's EntityManager. Because the GUC dies with
 * the transaction, no pooled connection can ever carry a prior request's
 * identity -- there is no reset code, no release hook. See the RLS design doc,
 * Phase 2b.
 *
 * It **throws** when no ambient context exists: a silent fallback to
 * `dataSource.manager` would run a query with no GUC under enforcement (zero
 * rows that look exactly like empty data). Refusing instead moves that whole
 * failure class to dev/CI at `RLS_MODE=off`, long before enforcement.
 *
 * The "scope" is whatever identity `withUserContext`/`withSystemContext` (or the
 * RequestContextInterceptor) put in the ambient context: those establish an
 * identity, this spends it on a database handle. Formerly named `tenantTx` --
 * older commits, the 1.13.0 release note and migration 107 still say that.
 */

// The active transaction's EntityManager, carried in its own ALS scope so a
// nested withScopedDb can join the ambient transaction instead of opening a
// second one. A second `dataSource.transaction` would take a second pooled
// connection inside the first and deadlock the pool under load (design 2b).
const activeManagerStorage = new AsyncLocalStorage<EntityManager>();

export function getActiveScopedManager(): EntityManager | undefined {
  return activeManagerStorage.getStore();
}

/**
 * Run `fn` while `manager` is registered as the ambient transaction. Exported
 * for tests and for advanced callers that already hold a manager; ordinary code
 * should use `withScopedDb`.
 */
export function runWithActiveScopedManager<T>(
  manager: EntityManager,
  fn: () => T,
): T {
  return activeManagerStorage.run(manager, fn);
}

/**
 * Run `fn` with no ambient transaction, so a `withScopedDb` inside it opens its
 * **own** transaction on its own connection instead of joining the caller's.
 *
 * This is the deliberate exception to the re-entrancy rule above, and it exists
 * for one shape: a long write that has to publish progress a concurrent reader
 * can see. A row written inside the outer transaction is invisible until commit,
 * so a wizard polling an import job would watch a frozen progress bar for three
 * minutes. See the `.mny` import job service (design ADR-3).
 *
 * It costs one extra pooled connection for the duration of the inner call, which
 * is why it is only ever correct for a small, short statement at a phase
 * boundary -- never per row, and never for another long transaction. Used in a
 * loop it would reproduce exactly the pool exhaustion the nesting rule prevents.
 */
export function runOutsideActiveScopedManager<T>(fn: () => T): T {
  return activeManagerStorage.exit(fn);
}

export const MISSING_CONTEXT_MESSAGE =
  "DB access outside request/user/system context -- wrap the call path in withUserContext/withSystemContext";

/**
 * Isolation levels callers may request. Only the registration paths need one
 * (SERIALIZABLE, to close the first-user-admin race); everything else uses the
 * connection default, exactly as before.
 *
 * Spelled out rather than imported from `typeorm/driver/types/IsolationLevel`:
 * that deep path type-checks under tsc but does not resolve under ts-jest, so
 * importing it takes every suite in the repo down.
 */
export type ScopedDbIsolation =
  | "READ UNCOMMITTED"
  | "READ COMMITTED"
  | "REPEATABLE READ"
  | "SERIALIZABLE";

export async function withScopedDb<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => Promise<T>,
  isolation?: ScopedDbIsolation,
): Promise<T> {
  const ctx = getRequestContext();
  if (!ctx || (!ctx.userId && !ctx.system)) {
    throw new Error(MISSING_CONTEXT_MESSAGE);
  }

  const active = getActiveScopedManager();
  if (active) {
    if (isolation) {
      // A joined transaction already has an isolation level, chosen by whoever
      // opened it. Silently downgrading a SERIALIZABLE request to whatever the
      // caller happened to be running under would reintroduce exactly the race
      // the caller asked to prevent, invisibly -- so refuse instead.
      throw new Error(
        `withScopedDb cannot apply isolation "${isolation}": it is joining an ambient transaction`,
      );
    }
    // Re-entrant call: join the ambient transaction (same connection, same
    // GUCs, same atomicity). Never open a second transaction.
    return fn(active);
  }

  const runInTransaction = async (manager: EntityManager) => {
    const mode = getRlsMode();
    if (mode !== "off") {
      if (ctx.system) {
        // Privileged escape hatch -- policies OR in app_bypass_rls().
        await manager.query("SELECT set_config('app.bypass_rls', 'on', true)");
      } else {
        // Both identity GUCs. `real` defaults to `current` outside delegation.
        await manager.query(
          "SELECT set_config('app.current_user_id', $1, true)",
          [ctx.userId],
        );
        await manager.query("SELECT set_config('app.real_user_id', $1, true)", [
          ctx.realUserId ?? ctx.userId,
        ]);
      }
    }

    if (ctx.preserveTimestamps) {
      // NOT gated on the RLS mode: this replaces the backup restore path's old
      // `DISABLE TRIGGER` DDL and must work in every mode (including `off`) once
      // the GUC-aware `updated_at` trigger has shipped (migration M1).
      await manager.query(
        "SELECT set_config('app.preserve_timestamps', 'on', true)",
      );
    }

    return runWithActiveScopedManager(manager, () => fn(manager));
  };

  return isolation
    ? dataSource.transaction(isolation, runInTransaction)
    : dataSource.transaction(runInTransaction);
}
