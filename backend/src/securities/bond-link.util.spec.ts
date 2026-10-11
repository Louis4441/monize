import { EntityManager } from "typeorm";
import {
  BOND_UNIT_PRICE_BAND,
  findBondLinkProblem,
  hasQuantitiesThatAreNotBonds,
} from "./bond-link.util";

const manager = (rows: unknown[]) => {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: { query } as unknown as EntityManager, query };
};

describe("findBondLinkProblem (the one definition of a valid program link)", () => {
  const link = {
    bondProgramId: "p1",
    currencyCode: "PLN",
    securityType: "BOND",
  };

  it("is valid for a BOND in the program's currency", async () => {
    const { manager: m, query } = manager([{ currency_code: "PLN" }]);
    await expect(findBondLinkProblem(m, link)).resolves.toBeNull();
    expect(query.mock.calls[0][0]).toMatch(/FROM bond_programs WHERE id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(["p1"]);
  });

  it("refuses a program that does not exist", async () => {
    await expect(
      findBondLinkProblem(manager([]).manager, link),
    ).resolves.toEqual({ code: "PROGRAM_NOT_FOUND" });
  });

  it("refuses a security that is not of type BOND", async () => {
    const { manager: m } = manager([{ currency_code: "PLN" }]);
    await expect(
      findBondLinkProblem(m, { ...link, securityType: "STOCK" }),
    ).resolves.toEqual({ code: "NOT_BOND_TYPE" });
    await expect(
      findBondLinkProblem(m, { ...link, securityType: null }),
    ).resolves.toEqual({ code: "NOT_BOND_TYPE" });
  });

  it("refuses a security recorded in another currency than the program's (INV-PRICE-001)", async () => {
    const { manager: m } = manager([{ currency_code: "PLN" }]);
    await expect(
      findBondLinkProblem(m, { ...link, currencyCode: "EUR" }),
    ).resolves.toEqual({
      code: "CURRENCY_MISMATCH",
      instrumentCurrency: "PLN",
    });
  });
});

describe("hasQuantitiesThatAreNotBonds (the price band across the series of a program)", () => {
  it("reads each row against the face value of the series it will be read as, never skipping one", async () => {
    const { manager: m, query } = manager([{ "?column?": 1 }]);
    await expect(
      hasQuantitiesThatAreNotBonds(m, "u1", "s1", "p1"),
    ).resolves.toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(["s1", "u1", "p1"]);
    // The series the row is read as: its stored series when that is in the NEW
    // program ...
    expect(sql).toMatch(/i\.bond_program_id = \$3::uuid/);
    expect(sql).toMatch(/i\.id = t\.bond_instrument_id/);
    // ... else (none stored, or one of another program) the series on sale on
    // its date under the new program ...
    expect(sql).toMatch(
      /NOT EXISTS \(SELECT 1 FROM bond_instruments o\s+WHERE o\.id = t\.bond_instrument_id\s+AND o\.bond_program_id = \$3::uuid\)/,
    );
    expect(sql).toMatch(/i\.id IN \(/);
    expect(sql).toMatch(/saleWindow/);
    // ... and when none is on sale, the program's newest series.
    expect(sql).toMatch(/NOT EXISTS \(SELECT s\.id/);
    expect(sql).toMatch(
      /ORDER BY \(nv\.terms -> 'saleWindow' ->> 'from'\) DESC NULLS LAST,\s+n\.series_code DESC\s+LIMIT 1/,
    );
    // The face value is the newest terms version's, per series.
    expect(sql).toMatch(/ORDER BY version DESC\s+LIMIT 1/);
    expect(sql).toContain(`face * ${BOND_UNIT_PRICE_BAND.min}::numeric`);
    expect(sql).toContain(`face * ${BOND_UNIT_PRICE_BAND.max}::numeric`);
    expect(sql).toMatch(/t\.status != 'VOID'/);
  });

  it("is false when no row is outside the band", async () => {
    await expect(
      hasQuantitiesThatAreNotBonds(manager([]).manager, "u1", "s1", "p1"),
    ).resolves.toBe(false);
  });

  it("pins the band the spec names: [0.5, 2] x face", () => {
    expect(BOND_UNIT_PRICE_BAND).toEqual({ min: "0.5", max: "2" });
  });
});
