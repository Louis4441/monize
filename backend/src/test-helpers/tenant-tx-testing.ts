import { EntityManager, EntityTarget } from "typeorm";

/**
 * Unit-test harness for services refactored onto `tenantTx` (RLS tasks R1-R7).
 *
 * Real `tenantTx` refuses to run without an ambient request/user/system
 * context and opens a real transaction; unit tests need neither. Specs mock
 * the module so `tenantTx(ds, fn)` simply delegates to the (mock)
 * `dataSource.transaction(fn)`:
 *
 *   jest.mock("../common/db/tenant-tx", () =>
 *     jest.requireActual("../test-helpers/tenant-tx-testing").tenantTxMockModule(),
 *   );
 *
 * and build the manager/dataSource pair with `createTenantTxMocks`, routing
 * `manager.getRepository(Entity)` to the same per-entity mock repositories the
 * specs already assert against. The context-throw and GUC-emission behavior of
 * the real tenantTx stays covered by its own spec (tenant-tx.spec.ts).
 */

/** Mock EntityManager: every method a jest.fn, plus entity-routed getRepository. */
export type ManagerMock = Record<string, jest.Mock>;

/** Mock DataSource whose transaction() runs the callback with the ManagerMock. */
export interface DataSourceMock {
  transaction: jest.Mock;
  query: jest.Mock;
  manager: ManagerMock;
}

/**
 * Module factory for `jest.mock` of `src/common/db/tenant-tx`. The replacement
 * `tenantTx` skips the ambient-context check and runs the callback through the
 * caller-provided (mock) `dataSource.transaction`, so specs can both drive the
 * callback (via `createTenantTxMocks`) and assert transactional grouping (via
 * `dataSource.transaction.mock.calls`).
 */
export function tenantTxMockModule() {
  return {
    tenantTx: jest.fn(
      (
        dataSource: { transaction: (fn: (m: unknown) => unknown) => unknown },
        fn: (m: unknown) => unknown,
      ) => dataSource.transaction(fn),
    ),
  };
}

/**
 * Build the mock manager + dataSource pair for a spec.
 *
 * @param repos entity-class -> mock-repository entries backing
 *   `manager.getRepository`. Entities the service never asks for may be
 *   omitted; asking for an unregistered entity throws with a clear message so
 *   the spec failure names the missing mock instead of dying on `undefined`.
 */
export function createTenantTxMocks(
  repos: Array<[EntityTarget<unknown>, Record<string, jest.Mock>]> = [],
): { manager: ManagerMock; dataSource: DataSourceMock } {
  const repoMap = new Map<EntityTarget<unknown>, Record<string, jest.Mock>>(
    repos,
  );

  const manager: ManagerMock = {
    getRepository: jest.fn((entity: EntityTarget<unknown>) => {
      const repo = repoMap.get(entity);
      if (!repo) {
        const name =
          typeof entity === "function" ? entity.name : String(entity);
        throw new Error(
          `createTenantTxMocks: no mock repository registered for entity "${name}"`,
        );
      }
      return repo;
    }),
    // Direct EntityManager methods, for code converted from queryRunner.manager.
    find: jest.fn(),
    findBy: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    remove: jest.fn(),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const dataSource: DataSourceMock = {
    transaction: jest.fn(
      async (fn: (m: EntityManager) => unknown) =>
        fn(manager as unknown as EntityManager) as Promise<unknown>,
    ),
    query: jest.fn(),
    manager,
  };

  return { manager, dataSource };
}
