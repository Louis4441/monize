import { PolishProduct } from "./series-code";
import coi from "../manifests/coi1030.terms.json";
import dor from "../manifests/dor1028.terms.json";
import edo from "../manifests/edo1036.terms.json";
import ots from "../manifests/ots0127.terms.json";
import rod from "../manifests/rod1038.terms.json";
import ror from "../manifests/ror1027.terms.json";
import ros from "../manifests/ros1032.terms.json";
import tos from "../manifests/tos1029.terms.json";

type Json = Record<string, unknown>;

/**
 * One manifest with everything per-series removed, so a series cannot inherit
 * another series' rate by accident: the rates and the margin or spread, the
 * early redemption fee, the sale window, the series code and the source.
 */
interface Structure {
  readonly instrument: Json;
  readonly rateRule: Json;
  readonly redemption: Json & { readonly penalties: readonly Json[] };
  readonly rest: Json;
}

export interface SeriesTemplate {
  readonly product: PolishProduct;
  /**
   * The earliest sale month (`YYYY-MM`) whose issue letter was checked to have this
   * structure; an older series is refused (`TEMPLATE_NOT_VALIDATED`).
   */
  readonly validFrom: string;
  /** Which per-series rate field follows the first period's, if any. */
  readonly addend: "margin" | "spread" | null;
  readonly hasFee: boolean;
  readonly structure: Structure;
}

const PER_SERIES_KEYS = [
  "instrument",
  "saleWindow",
  "rateRule",
  "redemption",
  "source",
];

function strip(manifest: unknown): Structure {
  const m = manifest as Json;
  const rateRule = { ...(m.rateRule as Json) };
  for (const key of ["firstPeriodRate", "annualRate", "margin", "spread"]) {
    delete rateRule[key];
  }
  const redemption = m.redemption as Json & { penalties: Json[] };
  const rest: Json = {};
  for (const [key, value] of Object.entries(m)) {
    if (!PER_SERIES_KEYS.includes(key)) rest[key] = value;
  }
  const { seriesCode: _series, ...instrument } = m.instrument as Json;
  return {
    instrument,
    rateRule,
    redemption: {
      ...redemption,
      penalties: redemption.penalties.map(
        ({ amount: _amount, ...penalty }) => penalty,
      ),
    },
    rest,
  };
}

function template(
  product: PolishProduct,
  manifest: unknown,
  validFrom: string,
): SeriesTemplate {
  const m = manifest as { rateRule: Json; redemption: { penalties: Json[] } };
  const addend =
    "margin" in m.rateRule
      ? "margin"
      : "spread" in m.rateRule
        ? "spread"
        : null;
  return {
    product,
    validFrom,
    addend,
    hasFee: m.redemption.penalties.some((p) => p.type === "FIXED_FEE_PER_UNIT"),
    structure: strip(manifest),
  };
}

/**
 * `validFrom` is 2024-01 for every product: the letter of the series sold in
 * January 2024 (OTS0424, ROR0125, DOR0126, TOS0127, COI0128, ROS0130, EDO0134,
 * ROD0136) was read against the October 2026 letter of the same product, and
 * the paragraphs that carry the terms (first-period rate, the margin and its
 * observation, the early redemption window, the fee and its cap, the floor, the
 * record day, the period length) are word for word the same. Only the minister's
 * title, the payout account wording and the annex layout differ. Checked on
 * 2026-10-11; an older month was not checked.
 */
const VALID_FROM = "2024-01";

export const SERIES_TEMPLATES: Readonly<Record<PolishProduct, SeriesTemplate>> =
  {
    OTS: template("OTS", ots, VALID_FROM),
    ROR: template("ROR", ror, VALID_FROM),
    DOR: template("DOR", dor, VALID_FROM),
    TOS: template("TOS", tos, VALID_FROM),
    COI: template("COI", coi, VALID_FROM),
    ROS: template("ROS", ros, VALID_FROM),
    EDO: template("EDO", edo, VALID_FROM),
    ROD: template("ROD", rod, VALID_FROM),
  };

/** The template filled with a series' values: the terms document, before parsing. */
export function fillTemplate(
  t: SeriesTemplate,
  fill: {
    readonly seriesCode: string;
    readonly firstPeriodRate: string;
    readonly addend: string | null;
    readonly fee: string | null;
    readonly saleWindow: { readonly from: string; readonly to: string };
    readonly source: Json;
  },
): unknown {
  const s = t.structure;
  const rateRule: Json = { ...s.rateRule };
  if (rateRule.type === "FIXED") {
    rateRule.annualRate = fill.firstPeriodRate;
  } else {
    rateRule.firstPeriodRate = fill.firstPeriodRate;
    if (t.addend !== null) rateRule[t.addend] = fill.addend;
  }
  return {
    ...s.rest,
    instrument: { ...s.instrument, seriesCode: fill.seriesCode },
    saleWindow: { from: fill.saleWindow.from, to: fill.saleWindow.to },
    rateRule,
    redemption: {
      ...s.redemption,
      penalties: s.redemption.penalties.map((p) =>
        p.type === "FIXED_FEE_PER_UNIT" ? { ...p, amount: fill.fee } : p,
      ),
    },
    source: fill.source,
  };
}
