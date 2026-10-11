import {
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { BondHoldingsService } from "./bond-holdings.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const SEC = "sec-1";
const ACC = "acc-1";
const OTHER_ACC = "acc-2";
const PROGRAM = "prog-1";
const EDO = "11111111-1111-5111-8111-111111111111";
const COI = "22222222-2222-5222-8222-222222222222";

type Row = {
  id: string;
  action: string;
  tx_date: string;
  quantity: string;
  account_id?: string;
  bond_instrument_id: string | null;
  counterpart_account_id?: string | null;
};

const row = (over: Partial<Row> & { id: string }): Row => ({
  action: "BUY",
  tx_date: "2026-01-10",
  quantity: "10",
  account_id: ACC,
  bond_instrument_id: EDO,
  counterpart_account_id: null,
  ...over,
});

function setup(
  opts: { linked?: boolean; ledger?: Row[]; onSale?: string[] } = {},
) {
  const { manager, dataSource } = createScopedDbMocks();
  dataSource.transaction.mockImplementation(
    async (fn: (m: unknown) => unknown) => fn(manager),
  );
  const codes: Record<string, string> = { [EDO]: "EDO1036", [COI]: "COI1030" };
  manager.query.mockImplementation(
    async (sql: string, params: unknown[] = []) => {
      if (sql.includes("bond_auto_fetch")) {
        const own = params[1] === USER && opts.linked !== false;
        return own
          ? [
              {
                id: SEC,
                user_id: USER,
                symbol: "EDO",
                currency_code: "PLN",
                bond_program_id: PROGRAM,
                bond_auto_fetch: false,
              },
            ]
          : [];
      }
      if (sql.includes("counterpart_account_id")) {
        return (opts.ledger ?? []).map((r) => ({
          status: "UNRECONCILED",
          ...r,
        }));
      }
      if (sql.includes("saleWindow")) {
        return (opts.onSale ?? []).map((id) => ({ id }));
      }
      if (sql.includes("SELECT series_code")) {
        return [{ series_code: codes[String(params[0])] }];
      }
      return [];
    },
  );
  const service = new BondHoldingsService(dataSource as unknown as DataSource);
  return { service, manager };
}

describe("BondHoldingsService.seriesOnSale", () => {
  it("answers the series the write would infer, with its code, from the same sale-window query", async () => {
    const { service, manager } = setup({ onSale: [EDO] });
    await expect(
      service.seriesOnSale(USER, SEC, "2026-10-15"),
    ).resolves.toEqual({ instrumentId: EDO, seriesCode: "EDO1036" });
    const call = manager.query.mock.calls.find(([sql]: [string]) =>
      sql.includes("saleWindow"),
    );
    expect(call?.[1]).toEqual([PROGRAM, "2026-10-15"]);
  });

  it("answers null when no series, or more than one, was on sale that day (the write would refuse as well)", async () => {
    await expect(
      setup({ onSale: [] }).service.seriesOnSale(USER, SEC, "2026-10-15"),
    ).resolves.toBeNull();
    await expect(
      setup({ onSale: [EDO, COI] }).service.seriesOnSale(
        USER,
        SEC,
        "2026-10-15",
      ),
    ).resolves.toBeNull();
  });

  it("is a 404 for another user's security and for one that is not linked to a program", async () => {
    await expect(
      setup().service.seriesOnSale("someone-else", SEC, "2026-10-15"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup({ linked: false }).service.seriesOnSale(USER, SEC, "2026-10-15"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("BondHoldingsService.seriesHoldings", () => {
  const ledger = [
    row({ id: "b1", quantity: "10", tx_date: "2026-01-10" }),
    row({
      id: "b2",
      quantity: "7",
      tx_date: "2026-02-10",
      bond_instrument_id: COI,
    }),
    row({
      id: "b3",
      quantity: "3",
      tx_date: "2026-03-10",
      account_id: OTHER_ACC,
    }),
    row({
      id: "s1",
      action: "SELL",
      quantity: "4",
      tx_date: "2026-04-10",
      bond_instrument_id: EDO,
    }),
  ];

  it("sums the open lots of the account per series, oldest first, quantity above zero only, as of the date", async () => {
    const { service } = setup({ ledger });
    await expect(
      service.seriesHoldings(USER, SEC, ACC, "2026-12-31"),
    ).resolves.toEqual({
      holdings: [
        { instrumentId: EDO, seriesCode: "EDO1036", quantity: 6 },
        { instrumentId: COI, seriesCode: "COI1030", quantity: 7 },
      ],
    });
    // The date bounds the rows: the sale of April is not yet made in March.
    await expect(
      service.seriesHoldings(USER, SEC, ACC, "2026-03-31"),
    ).resolves.toEqual({
      holdings: [
        { instrumentId: EDO, seriesCode: "EDO1036", quantity: 10 },
        { instrumentId: COI, seriesCode: "COI1030", quantity: 7 },
      ],
    });
    // Only the account asked for.
    await expect(
      service.seriesHoldings(USER, SEC, OTHER_ACC, "2026-12-31"),
    ).resolves.toEqual({
      holdings: [{ instrumentId: EDO, seriesCode: "EDO1036", quantity: 3 }],
    });
  });

  it("leaves out a series the account sold out of", async () => {
    const { service } = setup({
      ledger: [
        row({ id: "b1", quantity: "4" }),
        row({ id: "s1", action: "SELL", quantity: "4", tx_date: "2026-02-01" }),
      ],
    });
    await expect(
      service.seriesHoldings(USER, SEC, ACC, "2026-12-31"),
    ).resolves.toEqual({ holdings: [] });
  });

  it("excludes the transaction being edited, so its own removal does not hide what it may take", async () => {
    const { service } = setup({ ledger });
    await expect(
      service.seriesHoldings(USER, SEC, ACC, "2026-12-31", "s1"),
    ).resolves.toEqual({
      holdings: [
        { instrumentId: EDO, seriesCode: "EDO1036", quantity: 10 },
        { instrumentId: COI, seriesCode: "COI1030", quantity: 7 },
      ],
    });
  });

  it("is a 422 with the refusal code as errorCode when the lots cannot be derived", async () => {
    const { service } = setup({
      ledger: [
        row({
          id: "s1",
          action: "SELL",
          quantity: "4",
          bond_instrument_id: null,
        }),
      ],
    });
    const error = await service
      .seriesHoldings(USER, SEC, ACC, "2026-12-31")
      .catch((e) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getResponse()).toMatchObject({ errorCode: "OVER_REMOVAL" });
  });

  it("is a 404 for another user's security", async () => {
    await expect(
      setup({ ledger }).service.seriesHoldings(
        "someone-else",
        SEC,
        ACC,
        "2026-12-31",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
