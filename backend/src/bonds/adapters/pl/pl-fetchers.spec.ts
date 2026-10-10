import { readFileSync } from "fs";
import { join } from "path";
import { BenchmarkFetchError, BondFetch } from "../../bond-adapter";
import { POLISH_BOND_ADAPTER } from ".";
import {
  findCsvLink,
  fetchGusCpi,
  GUS_CPI_CSV_URL,
  GUS_CPI_LANDING_URL,
  parseGusCpiCsv,
} from "./pl-gus-cpi";
import {
  fetchNbpReference,
  mergeObservations,
  NBP_ARCHIVE_URL,
  NBP_CURRENT_URL,
  parseNbpArchive,
  parseNbpCurrent,
} from "./pl-nbp-reference";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name));
const text = (name: string) => fixture(name).toString("utf8");
const bytes = (value: string) => new TextEncoder().encode(value);

function routes(
  table: Record<string, { status: number; body: Uint8Array }>,
): jest.MockedFunction<BondFetch> {
  return jest.fn(async (url: string) => {
    const hit = table[url];
    if (!hit) throw new Error(`unexpected url ${url}`);
    return hit;
  });
}

describe("NBP reference rate parsers", () => {
  it("reads the reference rows of the archive, BOM and comma decimals included", () => {
    expect(text("nbp-archive.xml").charCodeAt(0)).toBe(0xfeff);
    const rows = parseNbpArchive(text("nbp-archive.xml"));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      observationDate: "1998-02-26",
      value: "0.2400",
      publishedOn: null,
    });
    expect(rows[rows.length - 1]).toEqual({
      observationDate: "2026-03-05",
      value: "0.0375",
      publishedOn: null,
    });
  });

  it("reads the reference rate of the current table with its own date", () => {
    expect(parseNbpCurrent(text("nbp-current.xml"))).toEqual([
      {
        observationDate: "2026-03-05",
        value: "0.0375",
        publishedOn: "2026-03-05",
      },
    ]);
  });

  it("keeps only the reference rate, not the other rates of a decision", () => {
    const xml = `<stopy_procentowe_archiwum><pozycje obowiazuje_od="2020-05-29">
      <pozycja id="lom" oprocentowanie="1,00"/><pozycja id="ref" oprocentowanie="0,10"/></pozycje>
      <pozycje obowiazuje_od="2020-06-01"><pozycja id="lom" oprocentowanie="9,00"/></pozycje>
      </stopy_procentowe_archiwum>`;
    expect(parseNbpArchive(xml)).toEqual([
      { observationDate: "2020-05-29", value: "0.0010", publishedOn: null },
    ]);
  });

  it.each([
    [
      "no reference rows",
      "<stopy_procentowe_archiwum></stopy_procentowe_archiwum>",
    ],
    ["a different document", "<html></html>"],
    [
      "a malformed date",
      '<stopy_procentowe_archiwum><pozycje obowiazuje_od="2020-13-40"><pozycja id="ref" oprocentowanie="1,00"/></pozycje></stopy_procentowe_archiwum>',
    ],
    [
      "a missing date",
      '<stopy_procentowe_archiwum><pozycje><pozycja id="ref" oprocentowanie="1,00"/></pozycje></stopy_procentowe_archiwum>',
    ],
    [
      "a malformed number",
      '<stopy_procentowe_archiwum><pozycje obowiazuje_od="2020-05-29"><pozycja id="ref" oprocentowanie="n/a"/></pozycje></stopy_procentowe_archiwum>',
    ],
  ])("refuses an archive with %s", (_name, xml) => {
    expect(() => parseNbpArchive(xml)).toThrow(BenchmarkFetchError);
  });

  it("refuses a current table without a usable reference row", () => {
    expect(() => parseNbpCurrent("<x/>")).toThrow(BenchmarkFetchError);
    expect(() =>
      parseNbpCurrent("<stopy_procentowe></stopy_procentowe>"),
    ).toThrow(/no reference/);
    expect(() =>
      parseNbpCurrent(
        '<stopy_procentowe><pozycja id="ref" oprocentowanie="3,75" obowiazuje_od="x"/></stopy_procentowe>',
      ),
    ).toThrow(/malformed date/);
  });

  it("merges by date, the later set winning, in date order", () => {
    const merged = mergeObservations(
      [
        { observationDate: "2026-03-05", value: "0.0400", publishedOn: null },
        { observationDate: "2026-01-01", value: "0.0450", publishedOn: null },
      ],
      [{ observationDate: "2026-03-05", value: "0.0375", publishedOn: null }],
    );
    expect(merged.map((o) => [o.observationDate, o.value])).toEqual([
      ["2026-01-01", "0.0450"],
      ["2026-03-05", "0.0375"],
    ]);
  });

  it("fetches both documents and covers through the fetch date", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: { status: 200, body: fixture("nbp-current.xml") },
    });
    const result = await fetchNbpReference(fetch, "2026-10-10");
    expect(result.coveredThrough).toBe("2026-10-10");
    expect(result.observations).toHaveLength(5);
    expect(result.sourceUrl).toBe(NBP_ARCHIVE_URL);
  });

  it("refuses a non-200 answer", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 503, body: new Uint8Array() },
    });
    await expect(fetchNbpReference(fetch, "2026-10-10")).rejects.toThrow(
      /HTTP 503/,
    );
  });

  const currentTable = (date: string, rate: string) =>
    bytes(
      `<stopy_procentowe data_publikacji="${date}"><tabela id="stoproc"><pozycja id="ref" oprocentowanie="${rate}" obowiazuje_od="${date}" /></tabela></stopy_procentowe>`,
    );

  it("adds a decision only the current table holds as the newest observation, citing the current table", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: {
        status: 200,
        body: currentTable("2026-10-08", "4,00"),
      },
    });
    const result = await fetchNbpReference(fetch, "2026-10-10");
    expect(result.observations).toHaveLength(6);
    expect(result.observations[result.observations.length - 1]).toEqual({
      observationDate: "2026-10-08",
      value: "0.0400",
      publishedOn: "2026-10-08",
      sourceUrl: NBP_CURRENT_URL,
    });
    // Every row that came from the archive says so.
    expect(result.observations[0].sourceUrl).toBe(NBP_ARCHIVE_URL);
  });

  it("lets the current table's value win on a date both documents carry", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: {
        status: 200,
        body: currentTable("2026-03-05", "3,50"),
      },
    });
    const result = await fetchNbpReference(fetch, "2026-10-10");
    expect(result.observations).toHaveLength(5);
    const row = result.observations.find(
      (o) => o.observationDate === "2026-03-05",
    );
    expect(row?.value).toBe("0.0350");
    expect(row?.sourceUrl).toBe(NBP_CURRENT_URL);
  });

  it("refuses a non-200 answer", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 503, body: new Uint8Array() },
    });
    await expect(fetchNbpReference(fetch, "2026-10-10")).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("refuses when only the current table answers non-200", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: { status: 503, body: new Uint8Array() },
    });
    await expect(fetchNbpReference(fetch, "2026-10-10")).rejects.toThrow(
      /HTTP 503/,
    );
  });
});

describe("GUS CPI parser", () => {
  it("decodes windows-1250 and turns the index into a fraction", () => {
    const decoded = new TextDecoder("windows-1250").decode(
      fixture("gus-cpi.csv"),
    );
    const rows = parseGusCpiCsv(decoded);
    expect(rows.map((r) => [r.observationDate, r.value])).toEqual([
      ["2025-10-01", "0.0280"],
      ["2025-11-01", "0.0250"],
      ["2025-12-01", "0.0240"],
      ["2026-07-01", "0.0300"],
      ["2026-08-01", "0.0340"],
    ]);
  });

  it("skips empty values (unpublished months) and other presentations", () => {
    const rows = parseGusCpiCsv(
      new TextDecoder("windows-1250").decode(fixture("gus-cpi.csv")),
    );
    expect(rows.some((r) => r.observationDate === "2026-09-01")).toBe(false);
    expect(rows).toHaveLength(5);
  });

  it("skips a territory other than Polska and handles a negative change", () => {
    const csv = [
      "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga;;",
      "W;Mazowieckie;Analogiczny miesiąc poprzedniego roku = 100;2026;1;110,0;;;",
      "W;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;1;99,8;;;",
    ].join("\r\n");
    expect(parseGusCpiCsv(csv)).toEqual([
      { observationDate: "2026-01-01", value: "-0.0020", publishedOn: null },
    ]);
  });

  it.each([
    ["a changed header", "a;b;c\r\n"],
    [
      "no usable rows",
      "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga;;\r\nW;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;9;;;;\r\n",
    ],
    [
      "a malformed value",
      "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga;;\r\nW;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;9;x;;;\r\n",
    ],
    [
      "a malformed month",
      "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga;;\r\nW;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;13;103,0;;;\r\n",
    ],
    [
      "a duplicate month",
      "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga;;\r\nW;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;1;103,0;;;\r\nW;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;1;103,1;;;\r\n",
    ],
  ])("refuses %s", (_name, csv) => {
    expect(() => parseGusCpiCsv(csv)).toThrow(BenchmarkFetchError);
  });

  it("finds the CSV link on the landing page, absolute or relative", () => {
    const html = `<a href="/x/other.csv">o</a><a href="/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv">c</a>`;
    expect(findCsvLink(html)).toBe(
      "https://stat.gov.pl/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv",
    );
    // A relative href without a leading slash resolves against the landing page.
    expect(
      findCsvLink(
        '<a href="miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv">',
      ),
    ).toMatch(/^https:\/\/stat\.gov\.pl\/obszary-tematyczne\/.*_9\.csv$/);
    expect(
      findCsvLink(
        '<a href="https://dane.stat.gov.pl/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv">',
      ),
    ).toBe(
      "https://dane.stat.gov.pl/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv",
    );
    expect(findCsvLink("<a href='/x'>")).toBeNull();
  });

  it("never follows a link off stat.gov.pl, over plain http, or with a look-alike host", () => {
    const file =
      "miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv";
    for (const href of [
      `https://cdn.example/${file}`,
      `http://stat.gov.pl/download/${file}`,
      `//cdn.example/${file}`,
      `https://stat.gov.pl.evil.example/${file}`,
      `https://evilstat.gov.pl/${file}`,
      `https://stat.gov.pl:8443/${file}`,
      `https://user@stat.gov.pl/${file}`,
    ]) {
      expect(findCsvLink(`<a href="${href}">`)).toBeNull();
    }
    // A foreign link is skipped; a later link on the publisher's host is used.
    expect(
      findCsvLink(
        `<a href="https://cdn.example/${file}"><a href="/d/${file}">`,
      ),
    ).toBe(`https://stat.gov.pl/d/${file}`);
  });

  it("does not fetch a foreign link found on the landing page", async () => {
    const file =
      "miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv";
    const fetch = routes({
      [GUS_CPI_CSV_URL]: { status: 404, body: new Uint8Array() },
      [GUS_CPI_LANDING_URL]: {
        status: 200,
        body: bytes(`<a href="http://stat.gov.pl/d/${file}">`),
      },
    });
    await expect(fetchGusCpi(fetch)).rejects.toThrow(/no CSV link/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fetches the file and covers through the newest month", async () => {
    const fetch = routes({
      [GUS_CPI_CSV_URL]: { status: 200, body: fixture("gus-cpi.csv") },
    });
    const result = await fetchGusCpi(fetch);
    expect(result.coveredThrough).toBe("2026-08-01");
    expect(result.sourceUrl).toBe(GUS_CPI_CSV_URL);
  });

  it("falls back to the landing page when the numbered file is gone", async () => {
    const next =
      "https://stat.gov.pl/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv";
    const fetch = routes({
      [GUS_CPI_CSV_URL]: { status: 404, body: new Uint8Array() },
      [GUS_CPI_LANDING_URL]: {
        status: 200,
        body: bytes(
          `<a href="/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv">`,
        ),
      },
      [next]: { status: 200, body: fixture("gus-cpi.csv") },
    });
    const result = await fetchGusCpi(fetch);
    expect(result.sourceUrl).toBe(next);
  });

  it("fails clearly when the fallback cannot help", async () => {
    const gone = { status: 404, body: new Uint8Array() };
    await expect(
      fetchGusCpi(
        routes({ [GUS_CPI_CSV_URL]: gone, [GUS_CPI_LANDING_URL]: gone }),
      ),
    ).rejects.toThrow(/landing page HTTP 404/);
    await expect(
      fetchGusCpi(
        routes({
          [GUS_CPI_CSV_URL]: gone,
          [GUS_CPI_LANDING_URL]: { status: 200, body: bytes("<html></html>") },
        }),
      ),
    ).rejects.toThrow(/no CSV link/);
    await expect(
      fetchGusCpi(
        routes({ [GUS_CPI_CSV_URL]: { status: 500, body: new Uint8Array() } }),
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("Polish adapter contract", () => {
  it("declares two series, each under its own tracked provider", () => {
    expect(POLISH_BOND_ADAPTER.countryCode).toBe("PL");
    expect(
      POLISH_BOND_ADAPTER.benchmarks.map((b) => [b.code, b.kind, b.providerId]),
    ).toEqual([
      ["PL_NBP_REFERENCE", "STEP", "nbp"],
      ["PL_CPI_GUS_YOY", "MONTHLY", "gus"],
    ]);
  });

  it("catalogs the eight series at terms version 1", () => {
    expect(POLISH_BOND_ADAPTER.catalog).toHaveLength(8);
    expect(
      POLISH_BOND_ADAPTER.catalog.every(
        (e) => e.termsVersion === 1 && e.publishedAt === "2026-09-21",
      ),
    ).toBe(true);
  });

  it("routes each series to its fetcher and refuses an unknown one", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: { status: 200, body: fixture("nbp-current.xml") },
      [GUS_CPI_CSV_URL]: { status: 200, body: fixture("gus-cpi.csv") },
    });
    expect(
      (await POLISH_BOND_ADAPTER.fetchBenchmark("PL_NBP_REFERENCE", fetch))
        .observations,
    ).toHaveLength(5);
    expect(
      (await POLISH_BOND_ADAPTER.fetchBenchmark("PL_CPI_GUS_YOY", fetch))
        .observations,
    ).toHaveLength(5);
    await expect(
      POLISH_BOND_ADAPTER.fetchBenchmark("X", fetch),
    ).rejects.toThrow(/no benchmark X/);
  });
});
