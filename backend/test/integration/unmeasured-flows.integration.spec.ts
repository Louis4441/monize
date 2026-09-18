import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountType } from "@/accounts/entities/account.entity";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { addDaysYMD, todayYMD } from "@/common/date-utils";
import { loadUnmeasuredFlowRows } from "@/net-worth/unmeasured-flows.util";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The two unmeasured-flow statements against a real PostgreSQL parser.
 *
 * The regression: the mixed-split statement was handed the settled-trade
 * statement's five parameters but referenced only $1, $2, $3 and $5, so the
 * server could not infer $4's type and refused the whole statement at PARSE
 * ("could not determine data type of parameter $4", SQLSTATE 42P18). Every
 * period result -- the single route and the batch behind the Investments
 * page -- failed with a database error. A mocked `query` accepts any
 * parameter list, so only a real parse can hold this: each statement binds
 * every placeholder it names and no other, per day and as a whole-window
 * total.
 */
describe("unmeasured flow statements (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let brokerageId: string;
  let cashId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_splits",
      "transactions",
      "accounts",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    const brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      accountType: AccountType.INVESTMENT,
    });
    brokerageId = brokerage.id;
    const cash = await createTestAccount(dataSource, userId, {
      name: "Brokerage cash",
      accountType: AccountType.INVESTMENT,
    });
    cashId = cash.id;
  });

  const load = (perDay: boolean) =>
    withUserContext(userId, () =>
      loadUnmeasuredFlowRows(
        (sql, params) => withScopedDb(dataSource, (m) => m.query(sql, params)),
        {
          userId,
          afterDate: addDaysYMD(todayYMD(), -365),
          throughDate: todayYMD(),
          scope: [brokerageId, cashId],
          cashScope: [cashId],
          perDay,
        },
      ),
    );

  it("parses and answers both statements per day", async () => {
    await expect(load(true)).resolves.toEqual({
      externallySettledTrades: [],
      mixedSplitParents: [],
    });
  });

  it("parses and answers both statements as one total", async () => {
    // Without GROUP BY, COUNT(*) over no rows is one row saying zero: a
    // whole-window total, dated to no day, which every slice then reads.
    await expect(load(false)).resolves.toEqual({
      externallySettledTrades: [{ date: null, count: 0 }],
      mixedSplitParents: [{ date: null, count: 0 }],
    });
  });
});
