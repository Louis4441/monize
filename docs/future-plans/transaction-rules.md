# Transaction rules

Design for user-defined transaction rules: a rule has a trigger, a condition
tree and an ordered list of actions (WHEN / IF / THEN). A rule changes how a
new transaction is labelled (tags, category, payee). A rule never moves money.
This is the design half of a two-document plan; the task list is
[`transaction-rules-tasks.md`](./transaction-rules-tasks.md).

Status: **proposal**. It is not approved. The discussion that carries this
proposal must get the `approved-to-build` label before any task in the task
list starts (`CONTRIBUTING.md`). Sections 5 to 9 are the specification that
`docs/financial-calculation-contract.md` section 9 asks for, because a rule
writes to the ledger (it does not change amounts, but it changes what a report
counts in a category).

## 1. Goal

- **A user creates rules in the Tools menu.** A new entry "Rules" in the Tools
  menu opens a list of rules. The editor follows the Home Assistant
  automation editor: three sections (When, If, Then), each a list of cards.
- **A rule applies automatically** when a transaction is created: by hand, by a
  scheduled posting, by an import, by the AI assistant or by an MCP client.
- **A rule can run on existing transactions.** The user selects "Run on
  existing transactions", sees a preview of every change, and confirms. The
  change is recorded in action history and can be undone.
- **The user rarely types an expression.** The visual editor is the primary
  mode. It uses the pickers Monize already has (accounts, payees, categories,
  tags, amounts, dates), so the user never sees an id.
- **The same engine serves the AI assistant and MCP.** A model can list, draft,
  test and save rules through the same action path the other writes use, and a
  human confirms every save.

Out of scope for this plan: report definitions and alerts (a separate plan,
which can reuse the condition model from section 5); rules that change amount,
account, date or status; rules that run on a schedule; sharing rules between
users.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
|---|---|---|
| The core create path | `TransactionsService.create` (`backend/src/transactions/transactions.service.ts`) | One `withScopedDb` block saves the row, the splits, the tags and the balance. REST, joint register, scheduled posting, AI actions and MCP all reach it. |
| The preview of a create | `TransactionsService.previewCreate` (same file) | AI and MCP confirmation cards show it. A rule must show in the preview (section 7, I3). |
| Transfers | `TransactionTransferService.writeTransferLegs` (`backend/src/transactions/transaction-transfer.service.ts`) and `TransactionsService.completeTransfer` | Tags are set in `completeTransfer`, after the legs commit. Section 6.3 moves the rule step into the leg transaction. |
| QIF / OFX / CSV import | `ImportService.importParsedTransactions` (`backend/src/import/import.service.ts`), `ImportRegularProcessorService.processTransaction` (`backend/src/import/import-regular-processor.service.ts`) | One transaction per file, one savepoint per row. The processor writes rows directly, not through `create()`. |
| MNY import | `MnyImportService.writeAll` (`backend/src/import/mny/mny-import.service.ts`), `writeTransactions` (`backend/src/import/mny/writers/write-transactions.ts`) | Bulk insert in one transaction. |
| Tags | `TagsService.setTransactionTags` / `setTransactionTagsBulk` (`backend/src/tags/tags.service.ts`) | These replace the whole set. There is no additive operation; section 6.2 adds one. |
| The closest existing rule | `payees.default_category_id`, applied in `create()` and in the import processor | Section 6.4 fixes the order between it and a rule. |
| Safe text matching | `matchesAliasPattern` (`backend/src/payees/alias-match.util.ts`) | Glob matching without regex. The `matches` operator reuses it. |
| Signed write actions | `AiActionType` and the descriptors (`backend/src/ai/actions/ai-action.types.ts`), `AiActionBuilderService` (`backend/src/ai/actions/ai-action-builder.service.ts`), `AiActionsService.confirm` / `execute` (`backend/src/ai/actions/ai-actions.service.ts`) | The AI assistant and the MCP relay card use them. Rule CRUD becomes new action types here. |
| MCP write confirmation | `confirmWrite` (`backend/src/mcp/mcp-confirm.ts`), `emitRelayCard` (`backend/src/mcp/mcp-relay-confirm.ts`), `McpWriteLimiter` (`backend/src/mcp/mcp-write-limiter.ts`) | Required for a new write tool (`docs/backend/mcp.md`). |
| Undo | `ActionHistoryService.record` (`backend/src/action-history/action-history.service.ts`) | A manual run records one bulk entry, so undo reverts it. |
| Reconciled lock | `assertReconciledRowsMutable` (`backend/src/transactions/reconciled-lock.util.ts`) | A manual run skips a locked row and reports it (INV-RECONCILE-001). |
| Tools menu | `TOOLS_LINKS` and `NAV_ICONS` (`frontend/src/lib/nav-links.ts`), `AppHeader` (`frontend/src/components/layout/AppHeader.tsx`), `MobileNavDrawer` (`frontend/src/components/layout/MobileNavDrawer.tsx`) | A delegate sees only the tools in `toolsCapabilityByHref`, so "Rules" is hidden from a delegate by default. |
| UI parts | `Card`, `Modal`, `Select`, `Combobox`, `MultiSelect`, `ToggleSwitch`, `ActionMenu`, `EmptyState`, `Badge`, `CurrencyInput`, `DateInput` (`frontend/src/components/ui/`) | The editor is built from these (`frontend/CLAUDE.md`). |

## 3. Product decisions

1. **Visual first, Home Assistant layout.** The editor has three sections:
   - **When** (trigger): one or more of "a transaction is created",
     "a transaction is imported". A manual run is an action on the rule, not a
     trigger.
   - **If** (conditions): a tree of AND / OR groups. Each leaf is a card with
     three controls: field, operator, value. The value control is the existing
     picker for that field.
   - **Then** (actions): an ordered list of action cards.
   Each card has an `ActionMenu` with: duplicate, disable, move up, move down,
   delete. The Home Assistant layout fits better than an n8n canvas, because a
   rule has no branches and no data flow between steps. From n8n we take two
   ideas: the "test step" button (the preview in section 3.6) and field
   insertion by selection, not by typing.
2. **The stored form is a JSON condition tree, not text.** The server validates
   the tree and evaluates it. The visual editor edits the tree directly. So the
   visual mode and the text mode (section 3.7) can never mean two different
   things.
3. **A rule fills, it does not overwrite, by default.** `set_category` and
   `set_payee` have `onlyIfEmpty: true` by default. The user can clear the flag
   per action. `add_tags` adds, `remove_tags` removes; neither replaces the set.
4. **Rules run in a fixed order.** The list page orders rules by `position`. The
   user drags a rule to change it. A rule can set `stopProcessing`: rules after
   it do not run for that transaction.
5. **One run per transaction per trigger.** An action does not start the rules
   again. A later rule sees the values that earlier rules set (sequential, like
   Home Assistant), and never a second pass.
6. **Test before save.** The editor has a "Test" panel. It evaluates the draft
   rule against the latest N transactions (default 200, filterable by account
   and date range) and shows a table: transaction, matched yes/no, and the
   changes the actions would make. The test writes nothing.
7. **Expression mode is a later phase and needs a dependency decision.** The
   text mode shows the same tree as a CEL expression and accepts CEL input for
   the supported subset only (the operators in section 5.2). An expression
   outside the subset is refused with a message that names the part that is
   not supported. The CEL parser and the editor library are new dependencies
   and need their own agreement (task F5). Candidates to evaluate:
   `@bufbuild/cel` (uses an RE2 engine), `@marcbachmann/cel-js`,
   `react-querybuilder` (has `parseCEL` and a CEL formatter; pulls Redux
   Toolkit), CodeMirror 6 with `@codemirror/autocomplete`. Monaco is not a
   candidate: bundle size is checked on every PR and it needs workers under the
   CSP. Phases 1 to 3 need no new dependency.
8. **Rules are per user.** A rule belongs to the owner of the rows it changes.
   A transaction a delegate or a joint-account partner creates on the owner's
   account runs the owner's rules, because `create()` runs as the owner
   (`JointRegisterService.create` uses `withSystemContext` and passes the
   owner id). A delegate does not see the Rules page in this plan.

## 4. Data model

Two tables, both with `user_id` and an RLS policy
(`docs/row-level-security-contract.md`), one migration plus `database/schema.sql`
in the same commit (`database/CLAUDE.md`):

```
transaction_rules
  id uuid pk
  user_id uuid not null -> users
  name varchar(100) not null
  enabled boolean not null default true
  position integer not null            -- order, unique per user (deferrable)
  triggers text[] not null             -- subset of {'create','import'}
  condition jsonb not null             -- section 5, validated on write
  actions jsonb not null               -- section 6, validated on write
  stop_processing boolean not null default false
  revision integer not null default 1  -- CAS on update
  created_at, updated_at

transaction_rule_applications          -- the "trace", like Home Assistant traces
  id uuid pk
  user_id uuid not null
  rule_id uuid not null -> transaction_rules on delete cascade
  transaction_id uuid not null -> transactions on delete cascade
  source varchar(20) not null          -- 'create' | 'import' | 'manual'
  changes jsonb not null               -- before/after per field
  applied_at timestamptz not null
```

- `condition` and `actions` are bounded: at most 50 condition leaves, depth at
  most 4, at most 10 actions, at most 200 rules per user. The DTO holds these
  limits (`whitelist` + `forbidNonWhitelisted`).
- Every id in a rule (account, payee, category, tag) is checked against the
  owner on every write. A rule that refers to a deleted entity is kept, marked
  `invalid` in the list, and skipped at run time with a reason in the trace.
- `transaction_rule_applications` is trimmed by the existing retention pattern
  (a cron; task B8 names the concrete one after reading `docs/cron-jobs.md`).

## 5. The condition model

### 5.1 Shape

```json
{ "all": [
    { "field": "type", "op": "eq", "value": "TRANSFER" },
    { "field": "fromAccountId", "op": "eq", "value": "<uuid>" },
    { "any": [
        { "field": "payeeText", "op": "matches", "value": "*BIEDRONKA*" },
        { "field": "amount", "op": "between", "value": [-500, -100] } ] } ] }
```

A node is either a group (`all` or `any`, with an optional `not: true`) or a
leaf (`field`, `op`, `value`).

### 5.2 Fields and operators

| Field | Type | Operators | Notes |
|---|---|---|---|
| `accountId` | account id | `eq`, `neq`, `in`, `notIn` | The account the row is posted to. |
| `fromAccountId`, `toAccountId` | account id | `eq`, `neq`, `in`, `notIn`, `isEmpty` | Only set on a transfer; empty on other rows. |
| `type` | enum `EXPENSE`, `INCOME`, `TRANSFER` | `eq`, `neq`, `in` | Derived from what the row is (sign and link), never from the account type (INV-REPORT-001 principle). |
| `payeeId` | payee id | `eq`, `neq`, `in`, `notIn`, `isEmpty` | After alias resolution. |
| `payeeText` | text | `eq`, `contains`, `startsWith`, `matches`, `isEmpty` | The raw payee text from the source (import text or typed name). |
| `categoryId` | category id | `eq`, `neq`, `in`, `notIn`, `isEmpty`, `inSubtree` | `inSubtree` includes child categories. |
| `description`, `memo` | text | `eq`, `contains`, `startsWith`, `matches`, `isEmpty` | Case-insensitive. |
| `amount` | money, signed | `eq`, `lt`, `lte`, `gt`, `gte`, `between` | In the account currency. |
| `absAmount` | money | `lt`, `lte`, `gt`, `gte`, `between` | So "more than 100" does not depend on the sign. |
| `currencyCode` | currency | `eq`, `in` | Derived from the account. |
| `tagIds` | tag ids | `hasAny`, `hasAll`, `hasNone` | Tags present when the rule runs. |
| `hasSplits` | bool | `eq` | |

- `matches` is a glob (`*`, no regex), evaluated by `matchesAliasPattern`, so no
  pattern can cause ReDoS. There is no regex operator.
- Text comparison is case-insensitive and trims whitespace, the same as payee
  alias matching.
- Money comparison uses scaled integers (`Math.round(Number(x) * 10000)`) on
  both sides. There is no arithmetic on money in a condition.
- A leaf whose field is unknown for the row (for example `fromAccountId` on a
  row that is not a transfer) is `false` for every operator except `isEmpty`.
  It is never an error and never a default value.
- Splits: a condition reads the parent row. A split line is not evaluated in
  this plan (open question Q2).

### 5.3 Evaluator

A pure function, `evaluateRuleCondition(node, facts)`, in a new
`backend/src/transaction-rules/` module. No `eval`, no `new Function`, no
dependency. `facts` is a frozen object that the applier builds once per row.
The same function runs in the preview, the test panel and the commit (I3).

## 6. Actions

### 6.1 The closed list

| Action | Parameters | Effect | Refused when |
|---|---|---|---|
| `add_tags` | `tagIds[]` (1..20) | Adds the tags that the row does not have | never |
| `remove_tags` | `tagIds[]` (1..20) | Removes the tags if present | never |
| `set_category` | `categoryId`, `onlyIfEmpty` | Sets the category | the row has splits; the row is a transfer leg |
| `set_payee` | `payeeId`, `onlyIfEmpty` | Sets the payee | the row is a leg of a cross-owner transfer |

No action changes `amount`, `accountId`, `date`, `status`, splits or links. So
a rule cannot move a balance (I1). A refused action is skipped and the trace
records the reason; the other actions of the rule still run.

### 6.2 Additive tags

`TagsService` gets `addTransactionTags(m, userId, transactionIds, tagIds)` and
`removeTransactionTags(...)`, both inside the caller's `EntityManager`, both
checking tag ownership. `INSERT ... ON CONFLICT DO NOTHING` makes the add safe
to repeat. Transfer legs of one owner share tags, as `syncTransferTags` does
today: a rule that tags one leg tags its mirror leg.

### 6.3 Where the rules run (every creation path)

The applier is `TransactionRulesService.applyToNew(m, userId, rowIds, source)`.
It runs inside the transaction that inserts the rows, after the row, its
splits and its explicit tags are written, and before the commit. It loads the
user's enabled rules for the trigger once per call (import: once per file).

| Path | Call site | Trigger |
|---|---|---|
| REST create, joint register, scheduled posting, AI, MCP | `TransactionsService.create`, inside its `withScopedDb` | `create` |
| Transfer (REST, AI, MCP, scheduled) | `writeTransferLegs`; `completeTransfer` then merges explicit tags with the rule tags instead of replacing them | `create` |
| QIF / OFX / CSV import | `ImportRegularProcessorService.processTransaction`, inside the row savepoint | `import` |
| MNY import | `MnyImportService.writeAll`, after `writeTransactions`, over the inserted ids | `import` |
| Split transfer legs created by `createSplits` / `addSplit` | not evaluated in this plan (Q2) | none |

Not in scope, on purpose (a guard lists them, section 9): backup restore, demo
and seed data, action-history undo and redo, the cash leg of an investment
transaction.

### 6.4 Order against the payee default category

1. The explicit values in the request.
2. The payee default category (today's rule, unchanged).
3. The transaction rules, in `position` order.

With `onlyIfEmpty: true` a rule does not replace steps 1 and 2. With
`onlyIfEmpty: false` a rule replaces them. The editor says this in an
`InfoTooltip` on the flag.

## 7. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| I1 | A rule never moves a balance | The action list in section 6.1 is a closed union type; the DTO refuses any other action; a unit test asserts that no action writes `amount`, `account_id`, `status` or a link. |
| I2 | A rule applies in the same transaction as the insert, on every creation path in 6.3 | The applier takes an `EntityManager`; a source-scanning guard lists every `create(Transaction)` / `insert` site on `transactions` and fails on a site that is neither a call to the applier nor in the exempt list. |
| I3 | A preview shows what the commit will do | `previewCreate`, the test panel and the manual-run preview call the same `planRuleEffects(facts, rules)`; the commit applies its result. A test compares preview and commit for the same input. |
| I4 | A rule runs at most once per row per trigger, in `position` order | One call site per path; a test with two rules and `stopProcessing`. |
| I5 | A rejected rule write has written nothing | Ownership, bounds and `revision` checks run in the same `withScopedDb` as the save (`docs/financial-calculation-contract.md` section 7). |
| I6 | A manual run does not alter a reconciled row while the strict lock is on | `assertReconciledRowsMutable` per row; locked rows are counted and named in the result. |

The PR that lands I1 and I2 adds them to `docs/system-invariants.md` as
`INV-RULE-001` and `INV-RULE-002` with an honest status.

## 8. AI assistant and MCP

Rule management goes through the existing action path, as the MCP and AI
writes already do:

- New `AiActionType` values: `create_transaction_rule`,
  `update_transaction_rule`, `delete_transaction_rule`,
  `run_transaction_rule` (manual run on existing rows). The builder resolves
  names to ids (payees, categories, tags, accounts), validates the rule and
  attaches the test result (matched rows, planned changes) to the card.
  `AiActionsService.execute` commits through `TransactionRulesService`.
- AI assistant tools (`backend/src/ai/query/tool-definitions.ts`,
  `backend/src/ai/query/tool-executor.service.ts`): `list_transaction_rules`
  (read) and `manage_transaction_rules` (write, with `operation`).
- MCP: one tool, `manage_transaction_rules`, in a new
  `backend/src/mcp/tools/rules.tool.ts`, with the five required fields,
  `confirmWrite` with all four outcomes, relay card first,
  `McpWriteLimiter`, and `stripHtml` on the name. Reads go through the same
  tool with `operation: "list"`, to keep the `tools/list` budget small.
  `tools-list-budget.spec.ts` is a ratchet: adding the tool raises the total
  cap, which is a reviewed decision in that PR.
- A model drafts a rule; it never saves one without the human card. The
  domain logic sits on `TransactionRulesService`, so both surfaces return the
  same shape (`docs/backend/mcp.md`, checklist item 1).
- Transactions that the AI or MCP creates run the rules automatically, because
  they go through `create()`. The confirmation card of a create shows the rule
  effects (I3).

## 9. Test matrix

| Area | Cases |
|---|---|
| Evaluator | every operator per field type; unknown field on a row (false, `isEmpty` true); nested `all`/`any`/`not`; glob edge cases shared with `alias-match.util.ts`; money boundaries (`-100.0000` vs `-100.00005`) |
| Validation | foreign id refused; bounds (depth, leaves, actions, rules per user); unknown field or operator refused; `revision` conflict |
| Actions | `onlyIfEmpty` both ways; `set_category` on a split row and on a transfer leg refused; `add_tags` idempotent; mirror leg receives tags |
| Order | payee default vs rule (truth table in 6.4); two rules and `stopProcessing`; later rule sees earlier result |
| Creation paths | one integration test per row of the table in 6.3, on real PostgreSQL; rollback of the insert rolls back the rule effects |
| Preview | `previewCreate` result equals the committed row for the same input (I3) |
| Manual run | preview equals commit; reconciled rows skipped; undo restores tags, category and payee |
| Guard | a new `create(Transaction)` site outside the applier and the exempt list fails |
| RLS | a rule and an application row are invisible to another user (`rls-context-smoke` pattern) |
| AI / MCP | the four confirmation outcomes; relay card; write limiter; output schema |
| Frontend | editor round trip (tree in, tree out); every picker writes an id and shows a name; test panel renders matched and not-matched rows; nav entry hidden for a delegate |
| E2E | create a rule in the UI, import a small QIF, see the tag on the row |

## 10. Open questions

- **Q1.** Is "Rules" a direct entry in the Tools menu, or a section under
  Payees? This plan says direct entry, because a rule touches payees,
  categories and tags equally.
- **Q2.** Do split lines get their own evaluation (a rule that sets a
  category on a split line)? This plan says no; it can come later without a
  format change (a `scope: "split"` field on the rule).
- **Q3.** Should a delegate with manage rights on categories or tags see the
  Rules page? This plan says no, until delegation gets a `rules` capability.
- **Q4.** Should the private copy of the glob matcher in
  `import-regular-processor.service.ts` be replaced by `matchesAliasPattern`?
  It is an unrelated duplication; it is reported, not fixed, in this plan.
