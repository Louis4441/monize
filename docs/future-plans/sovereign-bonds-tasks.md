# Sovereign Bonds: Agent Task List

> Companion to [`sovereign-bonds.md`](./sovereign-bonds.md) (the plan) and [`docs/specs/polish-retail-bonds.md`](../specs/polish-retail-bonds.md) (the spec). Do the tasks in dependency order. Mark a task done by checking its box and noting the PR.

## Rules for every task

- **The spec is the authority on every number.** A fixture copies spec section 5, never the implementation's output. If code and spec disagree, change the spec first, in its own commit, with the reason.
- **Invariants:** INV-BOND-001 to INV-BOND-005. Name the ones the task touches in the PR.
- **Definition of done:** the "Required before you push" list in `AGENTS.md` for each layer the task touches.

## PR 1: foundation and four products

- [x] **T1 Exact decimal type.** `backend/src/bonds/domain/exact-decimal.ts` and its spec. Rational over `BigInt`; parse from a decimal string only; `add`, `sub`, `mul`, `div`, `cmp`, `roundHalfUp(places)`, `toFixed(places)`. Acceptance: spec section 11, row "Exact arithmetic".
- [x] **T2 Dates and calendars.** `backend/src/bonds/domain/period-schedule.ts`, the business-day calendar interface and registry in `backend/src/bonds/domain/`, the Polish calendar in `backend/src/bonds/adapters/pl/`, specs. Acceptance: ROR annex 3 rows, E14, E15.
- [x] **T3 Terms types and parser.** `backend/src/bonds/domain/bond-terms.ts`, spec. Primitive unions of spec section 2.1; refuses unknown fields, JSON numbers for rates or amounts, and an unknown primitive (`UNSUPPORTED_PRIMITIVE`).
- [x] **T4 Engine and Polish adapter.** `backend/src/bonds/engine/bond-engine.ts`, terms manifests and golden fixtures in `backend/src/bonds/adapters/pl/`, the country-agnostic guard spec. Acceptance: E1 to E16 through the manifests, spec section 4 truth table, window cases, guard green. Depends on T1 to T3.
- [x] **T5 Migration and entities.** One migration with the five country-agnostic tables of spec section 7, `database/schema.sql`, `RLS_EXEMPT_TABLES`, the schema marker lines, `docs/row-level-security-contract.md` section 2 rows, `INTENTIONALLY_EXCLUDED_TABLES`, entities. Acceptance: `migration:lint`, `verify-schema.sh`, immutability integration test.
- [x] **T6 Read service.** `backend/src/bonds/bond-valuation.service.ts`, `backend/src/bonds/bonds.module.ts`, unit spec, integration spec. Depends on T4 and T5.
- [x] **T7 Invariant entries.** INV-BOND-001 to INV-BOND-004 in `docs/system-invariants.md`, with honest status.

All of T1 to T7 and phases 2 to 5 of the plan landed in one PR, WMP/monize#24,
at the owner's request.

- [x] **Spec 13.1 to 13.4 and the rate schedule.** Indexation notice, per-period
  rate schedule, interest attribution (`interest`, `fixedPart`,
  `benchmarkPart`, `addendPart`, `announcedPart`), `GET
  /bonds/securities/:securityId/scenarios` with `assume=` on the valuation, and
  the chart. Implemented in this PR; acceptance: the test-matrix rows
  "Attribution (13.2)", "Scenarios (13.3)" and "Chart (13.4)" of the spec, with
  the examples E23 to E25.

## Audit fixes (WMP/monize#24)

- [x] Decisions R1 to R38 of the audit are reflected in spec sections 2.6, 6,
  7, 9, 12 and 13 and in INV-BOND-001, -002 and -005: engine series API,
  `saleWindow` refusal, reversed price precedence for a linked security, lots
  per account, link validation and undo, UNKNOWN cash flows and
  `projectionMissing`, scenario rounding rule, future `asOf` refusal, market
  surface exclusion, GUS/NBP freshness, `bond_instruments` immutability,
  inactive catalog currencies, per-entry seed transactions, support backup and
  restore handling.

## Follow-ups

- [ ] A valuation dated after the newest published observation shows `null`
  for a started period (INV-BOND-002). Offer a projected value for a future
  `asOf`, labelled as projected, instead of only naming what is missing.
- [ ] Confirm the four assumptions of spec section 10 against a published rate
  table or an early redemption statement.
- [ ] Ministry announced period rates have no machine-readable source yet; the
  table is filled by hand or by a later fetcher.
- [ ] Terms of older series still held (EDO, COI, ROS, ROD issued before
  October 2026, ROR and DOR of the last 24 months): one manifest and one
  catalog entry each, from its issue letter, with a golden case. No code
  change is needed.
- [ ] The next countries, in the order of the plan's phase 6+. The United
  States Series I savings bond is worked through in the plan's
  "Second-country example" section: four new primitives, no change to the
  Polish rules.
