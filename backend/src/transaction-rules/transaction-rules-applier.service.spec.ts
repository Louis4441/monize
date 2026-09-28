import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { TagsService } from "../tags/tags.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { TransactionRuleApplication } from "./transaction-rule-application.entity";
import { TransactionRule } from "./transaction-rule.entity";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = "user-1";
const ACCOUNT = uuid(1);
const PAYEE = uuid(2);
const CAT = uuid(3);
const PARENT = uuid(4);
const TAG_A = uuid(5);
const TAG_B = uuid(6);
const RULE_1 = uuid(11);
const RULE_2 = uuid(12);
const TX = uuid(21);

function rule(
  id: string,
  actions: RuleAction[],
  over: Partial<TransactionRule> = {},
  condition: RuleConditionNode = { all: [] },
): TransactionRule {
  return {
    id,
    userId: USER,
    name: `rule ${id.slice(-2)}`,
    enabled: true,
    position: 0,
    triggers: ["create", "import"],
    condition,
    actions,
    stopProcessing: false,
    revision: 1,
    ...over,
  } as TransactionRule;
}

function row(over: Partial<Transaction> = {}): Transaction {
  return {
    id: TX,
    userId: USER,
    accountId: ACCOUNT,
    currencyCode: "PLN",
    amount: "-50.0000",
    isTransfer: false,
    linkedTransactionId: null,
    payeeId: null,
    payeeName: null,
    categoryId: null,
    description: "milk",
    isSplit: false,
    ...over,
  } as Transaction;
}

interface Fixture {
  rules?: TransactionRule[];
  rows?: Transaction[];
  links?: Array<{ transactionId: string; tagId: string }>;
  categories?: Array<{ id: string; parentId: string | null }>;
  /** ids that exist for the user across the referenced tables */
  known?: string[];
  partner?: Transaction | null;
}

function harness(fx: Fixture = {}) {
  const known = new Set(
    fx.known ?? [ACCOUNT, PAYEE, CAT, PARENT, TAG_A, TAG_B],
  );
  const referenceFind = jest.fn(
    async (opts: { where: { id: { value: string[] } } }) =>
      opts.where.id.value.filter((id) => known.has(id)).map((id) => ({ id })),
  );
  const ruleRepo = { find: jest.fn().mockResolvedValue(fx.rules ?? []) };
  const categoryRepo = {
    find: jest.fn(async (opts: { select?: unknown }) =>
      opts.select
        ? (fx.categories ?? [
            { id: CAT, parentId: PARENT },
            { id: PARENT, parentId: null },
          ])
        : referenceFind(opts as never),
    ),
  };
  const repos = new Map<unknown, unknown>([
    [TransactionRule, ruleRepo],
    [Category, categoryRepo],
    [Account, { find: referenceFind }],
    [Payee, { find: referenceFind }],
    [Tag, { find: referenceFind }],
  ]);
  const m = {
    getRepository: jest.fn((entity: unknown) => repos.get(entity)),
    find: jest.fn(async (entity: unknown) => {
      if (entity === Transaction) return fx.rows ?? [];
      if (entity === TransactionTag) return fx.links ?? [];
      if (entity === Payee) return [{ id: PAYEE, name: "Biedronka" }];
      if (entity === Category) return [{ id: CAT, name: "Groceries" }];
      if (entity === Tag) return [{ id: TAG_A, name: "food" }];
      return [];
    }),
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === Payee) return { id: PAYEE, name: "Biedronka" };
      if (entity === Transaction) return fx.partner ?? null;
      return null;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const tags = {
    addTransactionTags: jest.fn().mockResolvedValue(undefined),
    removeTransactionTags: jest.fn().mockResolvedValue(undefined),
  };
  const service = new TransactionRulesApplierService(
    tags as unknown as TagsService,
  );
  const writes = (): unknown[] => [
    ...m.update.mock.calls,
    ...m.insert.mock.calls,
    ...tags.addTransactionTags.mock.calls,
    ...tags.removeTransactionTags.mock.calls,
  ];
  return { m: m as never, mock: m, tags, service, ruleRepo, writes };
}

describe("TransactionRulesApplierService.loadRulesFor", () => {
  it("asks for the user's enabled rules for the trigger in position order", async () => {
    const h = harness({ rules: [] });
    await h.service.loadRulesFor(h.m, USER, "import");
    const opts = h.ruleRepo.find.mock.calls[0][0];
    expect(opts.order).toEqual({ position: "ASC" });
    expect(opts.where).toEqual(
      expect.objectContaining({ userId: USER, enabled: true }),
    );
  });

  it("filters out a rule that no longer validates or names a deleted id, keeping the order", async () => {
    const good = rule(RULE_1, [{ type: "add_tags", tagIds: [TAG_A] }]);
    const gone = rule(RULE_2, [{ type: "add_tags", tagIds: [uuid(99)] }]);
    const broken = rule(uuid(13), [], {});
    const h = harness({ rules: [good, gone, broken] });
    const loaded = await h.service.loadRulesFor(h.m, USER, "create");
    expect(loaded.map((r) => r.id)).toEqual([RULE_1]);
  });
});

describe("TransactionRulesApplierService.applyToNew", () => {
  it("with no rules reads nothing else and writes nothing", async () => {
    const h = harness({ rules: [], rows: [row()] });
    const result = await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(result).toEqual([]);
    expect(h.writes()).toEqual([]);
    expect(h.mock.find).not.toHaveBeenCalled();
  });

  it("does nothing for no ids", async () => {
    const h = harness({ rules: [rule(RULE_1, [])] });
    expect(await h.service.applyToNew(h.m, USER, [], "create")).toEqual([]);
    expect(h.ruleRepo.find).not.toHaveBeenCalled();
  });

  it("writes category, payee and tags on the caller's manager and one trace row per changing rule", async () => {
    const r1 = rule(RULE_1, [
      { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
      { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: true },
    ]);
    const r2 = rule(RULE_2, [{ type: "add_tags", tagIds: [TAG_A] }], {
      position: 1,
    });
    const h = harness({ rules: [r1, r2], rows: [row()] });

    const result = await h.service.applyToNew(h.m, USER, [TX], "create");

    // Only category and payee (with its name) are updated; nothing else.
    expect(h.mock.update).toHaveBeenCalledTimes(1);
    expect(h.mock.update).toHaveBeenCalledWith(
      Transaction,
      { id: TX, userId: USER },
      { categoryId: CAT, payeeId: PAYEE, payeeName: "Biedronka" },
    );
    expect(h.tags.addTransactionTags).toHaveBeenCalledWith(
      h.m,
      USER,
      [TX],
      [TAG_A],
    );
    expect(h.tags.removeTransactionTags).not.toHaveBeenCalled();
    expect(h.mock.insert).toHaveBeenCalledTimes(1);
    const [entity, rows] = h.mock.insert.mock.calls[0];
    expect(entity).toBe(TransactionRuleApplication);
    expect(rows).toEqual([
      {
        userId: USER,
        ruleId: RULE_1,
        transactionId: TX,
        source: "create",
        changes: {
          categoryId: { before: null, after: CAT },
          payeeId: { before: null, after: PAYEE },
        },
      },
      {
        userId: USER,
        ruleId: RULE_2,
        transactionId: TX,
        source: "create",
        changes: { tagIds: { before: [], after: [TAG_A] } },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].transactionId).toBe(TX);
    expect(result[0].effects.changes.categoryId).toBe(CAT);
  });

  it("never updates amount, account, date, status or links", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [
          { type: "set_category", categoryId: CAT, onlyIfEmpty: false },
        ]),
      ],
      rows: [row()],
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    const patch = h.mock.update.mock.calls[0][2];
    expect(Object.keys(patch)).toEqual(["categoryId"]);
  });

  it("records no trace row for a rule that matched but changed nothing", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [
          { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
        ]),
      ],
      rows: [row({ categoryId: PARENT })],
    });
    const result = await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.writes()).toEqual([]);
    expect(result[0].effects.trace[0].skipped[0].reason).toBe("already_set");
  });

  it("removes tags the row has and reads the row's existing tag links", async () => {
    const h = harness({
      rules: [rule(RULE_1, [{ type: "remove_tags", tagIds: [TAG_A] }])],
      rows: [row()],
      links: [{ transactionId: TX, tagId: TAG_A }],
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.tags.removeTransactionTags).toHaveBeenCalledWith(
      h.m,
      USER,
      [TX],
      [TAG_A],
    );
  });

  it("hands the rules the raw payee text of the source, falling back to the stored name", async () => {
    const byText = rule(
      RULE_1,
      [{ type: "add_tags", tagIds: [TAG_A] }],
      {},
      { field: "payeeText", op: "contains", value: "raw text" },
    );
    const withHint = harness({ rules: [byText], rows: [row()] });
    await withHint.service.applyToNew(withHint.m, USER, [TX], "import", {
      payeeTextById: new Map([[TX, "the RAW TEXT from file"]]),
    });
    expect(withHint.tags.addTransactionTags).toHaveBeenCalled();

    const fallback = harness({
      rules: [byText],
      rows: [row({ payeeName: "raw text shop" })],
    });
    await fallback.service.applyToNew(fallback.m, USER, [TX], "import");
    expect(fallback.tags.addTransactionTags).toHaveBeenCalled();

    const none = harness({ rules: [byText], rows: [row()] });
    await none.service.applyToNew(none.m, USER, [TX], "import");
    expect(none.tags.addTransactionTags).not.toHaveBeenCalled();
  });

  it("gives a rule the ancestors of the row's category (inSubtree) from one category query", async () => {
    const h = harness({
      rules: [
        rule(
          RULE_1,
          [{ type: "add_tags", tagIds: [TAG_B] }],
          {},
          { field: "categoryId", op: "inSubtree", value: PARENT },
        ),
      ],
      rows: [row({ categoryId: CAT })],
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.tags.addTransactionTags).toHaveBeenCalled();
  });

  it("records request_ai_review in the trace as skipped, not applied", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [{ type: "request_ai_review", instruction: "look" }]),
      ],
      rows: [row()],
    });
    const result = await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(result[0].effects.aiReviewRequests).toEqual([
      { ruleId: RULE_1, instruction: "look" },
    ]);
    expect(result[0].effects.trace[0].skipped).toEqual([
      { type: "request_ai_review", reason: "ai_review_queue_unavailable" },
    ]);
    expect(h.writes()).toEqual([]);
  });

  it("uses the rules it is given instead of loading them (an import loads once per file)", async () => {
    const h = harness({ rows: [row()] });
    await h.service.applyToNew(h.m, USER, [TX], "import", {
      rules: [rule(RULE_1, [{ type: "add_tags", tagIds: [TAG_A] }])],
    });
    expect(h.ruleRepo.find).not.toHaveBeenCalled();
    expect(h.tags.addTransactionTags).toHaveBeenCalled();
  });

  it("treats a transfer leg whose partner the scope cannot read as cross-owner: set_payee is refused", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [
          { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: false },
        ]),
      ],
      rows: [row({ isTransfer: true, linkedTransactionId: uuid(77) })],
      partner: null,
    });
    const result = await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(result[0].effects.trace[0].skipped[0].reason).toBe(
      "cross_owner_transfer_leg",
    );
    expect(h.mock.update).not.toHaveBeenCalled();
  });

  it("reads which way a same-owner transfer went from the partner leg", async () => {
    const other = uuid(88);
    const h = harness({
      known: [ACCOUNT, other, TAG_A],
      rules: [
        rule(
          RULE_1,
          [{ type: "add_tags", tagIds: [TAG_A] }],
          {},
          {
            all: [
              { field: "type", op: "eq", value: "TRANSFER" },
              { field: "fromAccountId", op: "eq", value: ACCOUNT },
              { field: "toAccountId", op: "eq", value: other },
            ],
          },
        ),
      ],
      rows: [row({ isTransfer: true, linkedTransactionId: uuid(77) })],
      partner: row({ id: uuid(77), accountId: other, amount: 50 }),
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.tags.addTransactionTags).toHaveBeenCalled();
  });
});

describe("TransactionRulesApplierService.previewForRow", () => {
  const input = {
    accountId: ACCOUNT,
    currencyCode: "PLN",
    amount: -50,
    isTransfer: false,
    payeeId: null,
    payeeText: "Biedronka",
    categoryId: null,
    description: "milk",
    tagIds: [],
    hasSplits: false,
  };

  it("is null without rules and reads no other table", async () => {
    const h = harness({ rules: [] });
    expect(await h.service.previewForRow(h.m, USER, input)).toBeNull();
    expect(h.mock.find).not.toHaveBeenCalled();
  });

  it("is null when no rule matched", async () => {
    const h = harness({
      rules: [
        rule(
          RULE_1,
          [{ type: "add_tags", tagIds: [TAG_A] }],
          {},
          { field: "payeeText", op: "eq", value: "nobody" },
        ),
      ],
    });
    expect(await h.service.previewForRow(h.m, USER, input)).toBeNull();
  });

  it("returns exactly the plan applyToNew writes for the same facts (I3), with names, and writes nothing", async () => {
    const rules = [
      rule(RULE_1, [
        { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
        { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: true },
        { type: "add_tags", tagIds: [TAG_A] },
      ]),
    ];
    const h = harness({
      rules,
      rows: [row({ description: "milk", payeeName: "Biedronka" })],
    });
    const preview = await h.service.previewForRow(h.m, USER, input);
    expect(h.writes()).toEqual([]);
    const applied = await h.service.applyToNew(h.m, USER, [TX], "create");

    expect(preview).not.toBeNull();
    const { labels, ...plan } = preview!;
    expect(plan).toEqual(applied[0].effects);
    expect(labels.categories).toEqual({ [CAT]: "Groceries" });
    expect(labels.payees).toEqual({ [PAYEE]: "Biedronka" });
    expect(labels.tags).toEqual({ [TAG_A]: "food" });
    expect(labels.rules).toEqual({ [RULE_1]: "rule 11" });
  });
});
