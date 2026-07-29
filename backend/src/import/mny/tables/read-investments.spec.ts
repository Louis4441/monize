import { fakeMnyDatabase } from "../__fixtures__/fake-mny-database";
import { readInvestmentData } from "./read-investments";

const SP_COLUMNS = ["hsp", "hsec", "dt", "dPrice", "hss"];
const SEC_SPLIT_COLUMNS = [
  "hss",
  "cshrPre",
  "cshrPost",
  "dtRecord",
  "dPriceSplit",
];

describe("readInvestmentData", () => {
  it("resolves each stock split's security through its price rows", () => {
    // SEC_SPLIT has no hsec column, so the link runs SEC_SPLIT.hss <- SP.hss
    // and then SP.hsec.
    const db = fakeMnyDatabase({
      SEC_SPLIT: {
        columns: SEC_SPLIT_COLUMNS,
        rows: [
          {
            hss: 5,
            cshrPre: 1,
            cshrPost: 2,
            dtRecord: new Date(Date.UTC(2011, 2, 9)),
            dPriceSplit: 60,
          },
        ],
      },
      SP: {
        columns: SP_COLUMNS,
        rows: [
          {
            hsp: 1,
            hsec: 77,
            dt: new Date(Date.UTC(2011, 2, 9)),
            dPrice: 30,
            hss: 5,
          },
          {
            hsp: 2,
            hsec: 77,
            dt: new Date(Date.UTC(2011, 2, 10)),
            dPrice: 31,
            hss: 5,
          },
        ],
      },
    });

    const { splitSecurities, securitySplits } = readInvestmentData(db);

    expect(securitySplits[0]).toMatchObject({
      handle: 5,
      sharesBefore: 1,
      sharesAfter: 2,
      recordDate: "2011-03-09",
    });
    expect([...splitSecurities]).toEqual([[5, 77]]);
  });

  it("ignores price rows that name no split or no security", () => {
    const db = fakeMnyDatabase({
      SP: {
        columns: SP_COLUMNS,
        rows: [
          { hsp: 1, hsec: 77, dPrice: 30, hss: null },
          { hsp: 2, hsec: null, dPrice: 31, hss: 5 },
        ],
      },
    });

    expect(readInvestmentData(db).splitSecurities.size).toBe(0);
  });

  it("reads investment details and lots", () => {
    const db = fakeMnyDatabase({
      TRN_INV: {
        columns: ["htrn", "dPrice", "qty", "amtCmn", "amtInt"],
        rows: [
          {
            htrn: 9,
            dPrice: 12.5,
            qty: 100,
            amtCmn: "9.9900",
            amtInt: "0.0000",
          },
        ],
      },
      LOT: {
        columns: [
          "hlot",
          "hacct",
          "hsec",
          "qty",
          "htrnBuy",
          "htrnSell",
          "dtBuy",
          "dtSell",
        ],
        rows: [
          {
            hlot: 3,
            hacct: 2,
            hsec: 77,
            qty: 100,
            htrnBuy: 9,
            htrnSell: null,
            dtBuy: new Date(Date.UTC(2011, 0, 4)),
            dtSell: null,
          },
        ],
      },
    });

    const { investmentDetails, lots } = readInvestmentData(db);

    expect(investmentDetails).toEqual([
      {
        transaction: 9,
        price: 12.5,
        quantity: 100,
        commission: 9.99,
        interest: 0,
      },
    ]);
    // An open lot has no sell transaction; that is what makes it a holding.
    expect(lots).toEqual([
      {
        handle: 3,
        account: 2,
        security: 77,
        quantity: 100,
        buyTransaction: 9,
        sellTransaction: null,
        boughtOn: "2011-01-04",
        soldOn: null,
      },
    ]);
  });

  it("degrades to empty collections when no investment table exists", () => {
    const result = readInvestmentData(fakeMnyDatabase({}));

    expect(result.securities).toEqual([]);
    expect(result.securitySplits).toEqual([]);
    expect(result.prices).toEqual([]);
    expect(result.investmentDetails).toEqual([]);
    expect(result.lots).toEqual([]);
    expect(result.splitSecurities.size).toBe(0);
    expect(result.availability.every((entry) => !entry.present)).toBe(true);
  });
});
