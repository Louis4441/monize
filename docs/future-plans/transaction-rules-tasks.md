# Transaction rules: agent task list

> Companion to [`transaction-rules.md`](./transaction-rules.md) (the design). This file breaks the plan into tasks sized for one agent session each. Do the tasks in dependency order. Do not start a task whose dependencies are not merged. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **No task starts before S1.** The discussion must carry the `approved-to-build` label.
- **One task per session and per PR.** Each task names its files. A change outside them is a scope violation: stop and leave a note.
- **The governing invariants apply to every task:** a rule never moves a balance (design I1), and a rule runs inside the transaction that inserts the row (design I2). A task that adds an action which writes `amount`, `account_id`, `status` or a link is wrong: stop.
- **The evaluator is written once** (`evaluateRuleCondition`, design 5.3). The preview, the test panel, the manual run and the commit call it; a second copy in a controller, a tool or a component is off the plan.
- **Definition of done for every task**, in addition to its acceptance:
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `TZ=UTC npm run test:unit -- --coverage`; plus `npm run build && npm run test:integration` when a query, an entity, a migration or an RLS context changed.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:cov`, `npm run build`.
  - Migration tasks: `npm run migration:lint`, `scripts/verify-schema.sh`, `node scripts/check-migration-prefixes.mjs`.
  - Stage new files before running a guard (`git add -N`).
  - New strings: English catalogs, then `npm run i18n:pseudo`. The full-locale pass is Q2.
  - The PR body follows `.github/pull_request_template.md`, links the discussion, names the invariant IDs it touches and discloses AI assistance.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Real code that changes nothing until a user creates a rule. |
| **neutral** | Rewrites a live path (tag writes, transfer tag merge). Designed behaviour-preserving; the module's full unit suite plus the integration suite is the gate. |

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Discussion approved; open questions Q1 to Q4 of the design answered; this plan merged | -- | none | [ ] |
| D1 | Migration + `database/schema.sql`: `transaction_rules`, `transaction_rule_applications`, RLS policies | S1 | none | [ ] |
| B1 | Condition and action types, `evaluateRuleCondition`, validation (bounds, fields, operators) | S1 | none | [ ] |
| B2 | Entities, `TransactionRulesService` CRUD, controller, DTOs, ownership checks, `revision` CAS, reorder | D1, B1 | inert | [ ] |
| B3 | `TagsService.addTransactionTags` / `removeTransactionTags` | S1 | none | [ ] |
| B4 | `planRuleEffects` + `applyToNew`; call from `TransactionsService.create` and `previewCreate` | B2, B3 | inert | [ ] |
| B5 | Transfers: rule step in `writeTransferLegs`; `completeTransfer` merges tags | B4 | neutral | [ ] |
| B6 | Import: QIF / OFX / CSV processor and MNY `writeAll` | B4 | inert | [ ] |
| B7 | Guard: every insert site on `transactions` calls the applier or is exempt | B5, B6 | none | [ ] |
| B8 | Manual run: preview endpoint, commit endpoint, action history, reconciled skip; application trace and retention | B4 | inert | [ ] |
| A1 | AI action types and builder; AI assistant tools | B8 | inert | [ ] |
| A2 | MCP tool `manage_transaction_rules` | A1 | inert | [ ] |
| F1 | Tools menu entry, rules API client, list page | B2 | inert | [ ] |
| F2 | Rule editor (visual, Home Assistant layout) | F1 | inert | [ ] |
| F3 | Test panel and manual-run dialog | F2, B8 | inert | [ ] |
| F4 | Application history per rule (trace view) | F1, B8 | inert | [ ] |
| F5 | Expression mode (CEL subset): dependency proposal first | F2 | inert | [ ] |
| E1 | E2E: create a rule, import a QIF, see the tag | F2, B6 | none | [ ] |
| Q1 | `docs/system-invariants.md` entries, doc lines, README feature line | B7 | none | [ ] |
| Q2 | Translate every locale | F4 | none | [ ] |

## Tasks

### D1. Tables and RLS

Files: `database/migrations/20261005000000_add_transaction_rules.sql` (rename the prefix to the real date), `database/schema.sql`.

- Tables as in design section 4. `position` is unique per user, `DEFERRABLE INITIALLY DEFERRED`, so a reorder in one transaction does not collide.
- RLS policies on both tables, in the pattern `docs/row-level-security-contract.md` names; neither table is RLS-exempt.
- Acceptance: `scripts/verify-schema.sh` replays the migration as a no-op on `schema.sql`.

### B1. The condition model

Files: new `backend/src/transaction-rules/` module: `rule-condition.types.ts`, `rule-condition.evaluator.ts`, `rule-action.types.ts`, `rule-validation.ts`, with specs.

- The action type is a closed union (design 6.1). The field and operator table (design 5.2) is one constant; the validator and the evaluator read it.
- `matches` calls `matchesAliasPattern` (`backend/src/payees/alias-match.util.ts`).
- Money compares as scaled integers.
- Acceptance: the evaluator rows of the design test matrix; 100% branch coverage on the evaluator.

### B2. CRUD

Files: `transaction-rules.entity.ts`, `transaction-rule-application.entity.ts`, `transaction-rules.service.ts`, `transaction-rules.controller.ts`, `transaction-rules.module.ts`, `dto/` in the module; registration in `backend/src/app.module.ts`.

- Controller under `AuthGuard('jwt')`, `ParseUUIDPipe` on `:id`, `userId` from the JWT.
- Every check (ownership of each referenced id, bounds, `revision`) runs in the same `withScopedDb` as the save (design I5).
- Endpoints: list, get, create, update, delete, reorder, enable/disable.
- Acceptance: validation rows of the test matrix; RLS smoke spec.

### B3. Additive tags

Files: `backend/src/tags/tags.service.ts` and its spec.

- Both methods take an `EntityManager`, check ownership, and are idempotent.
- Acceptance: adding a tag twice leaves one link; a foreign tag id is refused without a write.

### B4. The applier on the core create path

Files: `transaction-rules-applier.service.ts` in the module; `backend/src/transactions/transactions.service.ts` (`create`, `previewCreate`) and their specs.

- `planRuleEffects(facts, rules)` returns the planned changes and the trace; `applyToNew` writes them with the caller's `EntityManager`.
- The step runs after the explicit tags and the payee default category (design 6.4).
- `previewCreate` returns the planned rule effects in its payload; the AI and MCP cards show them.
- Acceptance: preview equals commit (I3); rollback of `create` rolls back the rule effects (integration).

### B5. Transfers

Files: `backend/src/transactions/transaction-transfer.service.ts` (`writeTransferLegs`), `backend/src/transactions/transactions.service.ts` (`completeTransfer`, `updateTransfer` unchanged), specs.

- The rule step runs inside the leg transaction. `completeTransfer` merges explicit tags with the rule tags instead of replacing them.
- A cross-owner transfer runs the rules of each leg's owner on that leg only.
- Acceptance: with no rules, a transfer's rows and tags are byte-identical to today's (neutral).

### B6. Imports

Files: `backend/src/import/import-regular-processor.service.ts`, `backend/src/import/import.service.ts` (load rules once per file), `backend/src/import/mny/mny-import.service.ts`, specs.

- QIF / OFX / CSV: inside the row savepoint, so a failed row rolls back its rule effects too.
- MNY: one bulk pass after `writeTransactions`, inside `writeAll`'s transaction.
- `payeeText` is the raw text from the file.
- Acceptance: one integration test per importer.

### B7. The creation-path guard

Files: `backend/src/transaction-rules/rule-application-sites.guard.spec.ts`; `docs/guard-tests.md` if it lists guards.

- Scans `backend/src` for `create(Transaction` and inserts into `transactions`; every site calls the applier or is in the exempt list (restore, demo and seed, undo and redo, investment cash leg) with a reason.
- The exempt list is shrink-only.

### B8. Manual run and trace

Files: the rules service and controller; `backend/src/action-history/action-history.service.ts` (a new entity type for a rule run); specs.

- `POST /transaction-rules/:id/preview-run` (filters: accounts, date range, limit) returns planned changes; `POST /transaction-rules/:id/run` re-plans inside one `withScopedDb`, refuses if the plan changed since the preview (the preview returns a fingerprint), skips reconciled rows under the strict lock (I6), records one action-history entry.
- Retention of `transaction_rule_applications` through a cron that follows `docs/cron-jobs.md`.
- Acceptance: manual-run rows of the test matrix; undo restores every field.

### A1. AI assistant

Files: `backend/src/ai/actions/ai-action.types.ts`, `ai-action-builder.service.ts`, `ai-actions.service.ts`, `backend/src/ai/query/tool-definitions.ts`, `tool-executor.service.ts`, `tool-input-schemas.ts`, specs; the confirmation card component in `frontend/src/components/ai/` if it switches on action type.

- Names resolve to ids in the builder; the card shows the rule in words and the test result.

### A2. MCP

Files: `backend/src/mcp/tools/rules.tool.ts`, `backend/src/mcp/tool-output-schemas.ts`, `backend/src/mcp/mcp-server.service.ts`, `backend/src/mcp/mcp.module.ts`, `mcp-annotations.spec.ts` constants, `tools-list-budget.spec.ts` caps (reviewed decision, stated in the PR).

- Follows `docs/backend/mcp.md` "Adding a tool" in full, including the four confirmation outcomes and the relay card.

### F1. Menu and list page

Files: `frontend/src/lib/nav-links.ts` (`TOOLS_LINKS`, `NAV_ICONS`), `frontend/src/lib/transaction-rules-api.ts`, `frontend/src/app/rules/` (page), `frontend/src/components/rules/RulesList.tsx`, messages under `frontend/src/i18n/messages/en/`, tests; check `frontend/src/hooks/useSwipeNavigation.ts` and `MobileNavDrawer` pick the entry up.

- The list: drag handle, `ToggleSwitch` for enabled, name, a one-line summary ("When created · 3 conditions · 2 actions"), last applied, `Badge` for invalid, `ActionMenu` (edit, duplicate, run on existing, delete). Row click opens the editor (`useLongPress`). `EmptyState` with "Create rule".
- A delegate does not see the entry (it is not in `toolsCapabilityByHref`); a test pins it.

### F2. The editor

Files: `frontend/src/components/rules/RuleEditor.tsx`, `RuleConditionGroup.tsx`, `RuleConditionCard.tsx`, `RuleActionCard.tsx`, `frontend/src/lib/rule-fields.ts` (the field and operator table, mirrored from B1 with a contract test), tests.

- Layout per design section 3.1: name and enabled at the top; three `Card` sections When / If / Then; "+ Add condition", "+ Add group", "+ Add action"; per-card `ActionMenu`.
- The value control per field is the existing picker: `Combobox` for accounts, payees and categories, `MultiSelect` for tags, `CurrencyInput` for amounts, `Select` for enums, a text input for text fields. The tree never shows an id.
- The phone layout stacks the three controls of a condition card.
- Save calls B2; a `revision` conflict shows a message and reloads.

### F3. Test panel and manual run

Files: `frontend/src/components/rules/RuleTestPanel.tsx`, `RunRuleDialog.tsx`, tests.

- The test panel sends the draft (unsaved) rule to the preview endpoint and shows a table: date, payee, amount (`useNumberFormat`), matched, planned change. A failed request shows an error, never an empty table.
- The manual run uses `Modal`, shows the preview, and on confirm calls the run endpoint; it then calls `clearAllCache()` or the narrower invalidation `frontend/CLAUDE.md` names.

### F4. Trace view

Files: `frontend/src/components/rules/RuleApplications.tsx`, tests.

- A tab in the editor: the latest applications of the rule, each linked to the transaction (the existing deep link to a transaction).

### F5. Expression mode

Starts with a written dependency proposal (CEL parser, editor library, bundle size measured), agreed before code. Then: a Visual / Expression toggle; the expression view renders the tree as CEL; input outside the subset is refused with the part named; autocomplete of fields, operators and entity names inserting ids.

### E1. End to end

Files: a new spec under `e2e/` following `e2e/CLAUDE.md`.

### Q1 and Q2

- Q1: `INV-RULE-001` (I1) and `INV-RULE-002` (I2) in `docs/system-invariants.md`; a line in `docs/backend/` for the applier rule; the README feature list.
- Q2: every locale, as the final commit.
