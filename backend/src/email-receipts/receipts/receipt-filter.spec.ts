import {
  RECEIPT_SELECTION_PARAM_COUNT,
  receiptSelectionClause,
} from "./receipt-filter";

describe("receiptSelectionClause", () => {
  it("binds every field, nulls and empty lists when the filter is empty", () => {
    const { sql, params } = receiptSelectionClause({}, 3);
    expect(params).toEqual([null, null, null, [], [], [], null, null]);
    expect(params).toHaveLength(RECEIPT_SELECTION_PARAM_COUNT);
    expect(sql).toContain("r.status = $3::varchar");
    expect(sql).toContain("r.from_domain = $4::varchar");
    expect(sql).toContain("r.from_domain LIKE $5::varchar ESCAPE '\\'");
    expect(sql).toContain("NOT (r.status = ANY($6::varchar[]))");
    expect(sql).toContain("r.from_domain = ANY($7::varchar[])");
    expect(sql).toContain("unnest($8::varchar[])");
    expect(sql).toContain("$9::date");
    expect(sql).toContain("$10::date");
  });

  it("numbers its parameters from the index it is given", () => {
    const { sql } = receiptSelectionClause({}, 20);
    expect(sql).toContain("$20::varchar");
    expect(sql).toContain("$27::date");
    expect(sql).not.toContain("$3::");
  });

  it("reads status, domain and the dates as bind values, never in the text", () => {
    const { sql, params } = receiptSelectionClause(
      {
        status: "review",
        domain: " Shop.Example.com ",
        receivedFrom: "2026-01-01",
        receivedTo: "2026-01-31",
      },
      2,
    );
    expect(params).toEqual([
      "review",
      "shop.example.com",
      "%.shop.example.com",
      [],
      [],
      [],
      "2026-01-01",
      "2026-01-31",
    ]);
    expect(sql).not.toContain("shop.example.com");
    expect(sql).not.toContain("2026-01");
  });

  it("takes the days inclusively in UTC", () => {
    const { sql } = receiptSelectionClause({}, 1);
    expect(sql).toContain(
      "r.received_at >= ($7::date)::timestamp AT TIME ZONE 'UTC'",
    );
    expect(sql).toContain(
      "r.received_at < (($8::date) + 1)::timestamp AT TIME ZONE 'UTC'",
    );
  });

  it("excludes states and domains with their sub-domains, LIKE characters taken literally", () => {
    const { params } = receiptSelectionClause(
      {
        excludeStatuses: ["ignored", "review"],
        excludeDomains: [
          "A_b.example.com",
          " gmail.com ",
          "gmail.com",
          "100%.io",
        ],
      },
      1,
    );
    expect(params[3]).toEqual(["ignored", "review"]);
    expect(params[4]).toEqual(["a_b.example.com", "gmail.com", "100%.io"]);
    expect(params[5]).toEqual([
      "%.a\\_b.example.com",
      "%.gmail.com",
      "%.100\\%.io",
    ]);
  });
});
