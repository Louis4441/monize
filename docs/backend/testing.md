# Backend: testing conventions

The two Jest configs and why they never run together, the state of the E2E suites, and what a mock, a fixture and a green run each prove. Read this before writing or changing a spec, a test helper or a Jest config.

Paths are relative to `backend/src/` unless rooted. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## The parallel config cannot see `test/`, and `npm test` serializes the two suites

`test/integration/*` rebuilds the schema of the one shared `monize_test`
database (`synchronize` + `dropSchema`), so two Jest workers running any two of
those suites race each other -- `pg_type_typname_nsp_index` conflicts, or a
"connection terminated" reported by whichever spec was innocent. The root Jest
config in `package.json` therefore pins `roots: ["<rootDir>/src"]`: a bare
`jest` (and `test:watch`, `test:debug`) discovers unit specs only. Integration
specs are owned by `test/jest-e2e.json`, which pins `maxWorkers: 1`, and
`npm test` runs `test:unit` then `test:integration` (through
`backend/scripts/test-chain.mjs`) so the default command runs everything without ever
running the two in parallel. That makes `npm test` require a reachable
PostgreSQL (`pretest:integration` creates `monize_test` if it is missing);
`npm run test:unit` is the offline path.
`src/common/jest-config.guard.spec.ts` fails if any of those facts stops being
true.

**`npm test` takes no Jest arguments, and says so rather than ignoring them.**
npm appends `npm test -- <args>` to the *end* of the script, so in a chained
command they become the next `npm run`'s flags: npm swallows them, Jest never
sees them, and the filtered run silently becomes a full one. Filtered runs go
through `npm run test:unit -- <args>` or `npm run test:integration -- <args>`.

**Discovery lives in a config, not in a script.** `--testPathPatterns` and `-t`
may narrow what a config found; `--roots`, `--rootDir`, `--testRegex`,
`--testMatch`, `--testPathIgnorePatterns`, `--projects` and `--preset` redefine
it, and the guard rejects any script that passes one -- `jest --roots ./src
./test` would sweep the database-backed suites back into the parallel run with
every config in the repository still correct.

**The serialization is not a preference, and it stays until the suites stop
sharing a database.** A `dropSchema: true` suite is safe to run beside another
only when each worker owns its own database or schema; until that exists, one
worker is the mechanism, and `--runInBand` at a call site is not a substitute
for the config pinning it.

## `test/*.e2e-spec.ts` is not a gate, and three of the five suites are broken

CI runs `test:unit` and `test:integration` (filtered to `test/integration/*.spec.ts`). Nothing runs `test:e2e`, and separate rot accumulated behind a since-fixed compile error (`npm run typecheck` now closes the compile half in CI):

| Suite | State | Why |
|---|---|---|
| `test/payee-detail.e2e-spec.ts` | passes (9 tests) | fine; this is the spec that caught the raw-select transformer class of bug |
| `test/category-detail.e2e-spec.ts` | passes (9 tests) | fine; same shape as the payee one |
| `test/payees.e2e-spec.ts` | fails | calls services directly, so no request scope; never converted for RLS (`withScopedDb` throws without ambient context) |
| `test/auth.e2e-spec.ts` | fails | `AuthController` gained a `TokenService` dependency its test module does not provide |
| `test/transactions.e2e-spec.ts` | fails | `DelegateTransferMaskInterceptor` gained a `CrossOwnerAccessService` dependency its test module does not provide |

Repair them or delete them -- what they must not stay is present, cited, and dead. Do not add `test:e2e` to CI until the three are fixed; it will be red.

## Testing Conventions

Mock repositories use `Record<string, jest.Mock>`; tests use `Test.createTestingModule` with mocks injected via `getRepositoryToken()`. E2E tests live in `test/` with helpers under `test/helpers/` (`auth-helper.ts`, `test-database.ts`, `test-factories.ts`).

## A mock must return what the real collaborator returns

`Record<string, jest.Mock>` is fine for a repository, whose surface the driver defines. For **one of our own services**, type the double -- `jest.Mocked<TheService>`, or a `Partial<jest.Mocked<T>>` cast once -- so `tsc` rejects a return shape the real method cannot produce. Untyped, a mock quietly becomes fiction, and the branch that reads that fiction is green and unreachable:

- **A shape the driver never returns.** A TypeORM insert result mocked as `{ generatedMaps: [] }` made an entire lost-the-race path testable, tested and dead.
- **A signature that moved.** A method growing from `Promise<boolean>` to `Promise<string | null>` leaves `mockResolvedValue(true)` behind it -- still truthy, still passing. When you change a return type, grep its mocks in the same commit.

## Fixtures are claims about production data

`docs/testing-contract.md` is the shared list of adversarial inputs to choose from. A fixture is evidence only if the code that writes the real data could have written it -- check the producer's sampling, nullability, and format guarantees before adding one. `docs/financial-calculation-contract.md` section 8.3 has the full rule.

## Do not trust a suite that stayed green

Changing what a service computes and seeing every test pass means the change is a no-op or the suite has a hole -- `docs/financial-calculation-contract.md` sections 8.1 and 8.2. Establish which before moving on, and break each new invariant on purpose once to confirm its test actually fails.
