import {
  MnyInvestmentDetail,
  MnyLot,
  MnySecurity,
  MnySecurityPrice,
  MnySecuritySplit,
} from "../model/mny-rows";
import {
  toAmount,
  toBoolean,
  toDate,
  toHandle,
  toInteger,
  toNumber,
  toText,
} from "../model/mny-values";
import { MnyDatabase } from "../msisam/open-mny";
import { RowSpec, TableAvailability, readTableByName } from "./table-reader";

/**
 * Readers for `SEC`, `SEC_SPLIT`, `SP`, `TRN_INV` and `LOT`.
 *
 * `SEC_SPLIT` has no security column of its own: a split is reached through
 * the `SP` price row that references it (`SP.hss`), so the split reader hands
 * back a helper that resolves the security from the price table.
 */

const SECURITY_SPEC: RowSpec<MnySecurity> = {
  handle: { from: "hsec", as: toHandle },
  symbol: { from: "szSymbol", as: toText },
  name: { from: "szFull", as: toText },
  securityType: { from: "sct", as: (value) => toInteger(value, -1) },
  currency: { from: "hcrnc", as: toHandle },
  hidden: { from: "fHidden", as: toBoolean },
};

const SECURITY_SPLIT_SPEC: RowSpec<MnySecuritySplit> = {
  handle: { from: "hss", as: toHandle },
  sharesBefore: { from: "cshrPre", as: toNumber },
  sharesAfter: { from: "cshrPost", as: toNumber },
  recordDate: { from: "dtRecord", as: toDate },
  price: { from: "dPriceSplit", as: toNumber },
};

const SECURITY_PRICE_SPEC: RowSpec<MnySecurityPrice> = {
  handle: { from: "hsp", as: toHandle },
  security: { from: "hsec", as: toHandle },
  date: { from: "dt", as: toDate },
  price: { from: "dPrice", as: toNumber },
  split: { from: "hss", as: toHandle },
};

const INVESTMENT_DETAIL_SPEC: RowSpec<MnyInvestmentDetail> = {
  transaction: { from: "htrn", as: toHandle },
  price: { from: "dPrice", as: toNumber },
  quantity: { from: "qty", as: toNumber },
  commission: { from: "amtCmn", as: toAmount },
  interest: { from: "amtInt", as: toAmount },
};

const LOT_SPEC: RowSpec<MnyLot> = {
  handle: { from: "hlot", as: toHandle },
  account: { from: "hacct", as: toHandle },
  security: { from: "hsec", as: toHandle },
  quantity: { from: "qty", as: toNumber },
  buyTransaction: { from: "htrnBuy", as: toHandle },
  sellTransaction: { from: "htrnSell", as: toHandle },
  boughtOn: { from: "dtBuy", as: toDate },
  soldOn: { from: "dtSell", as: toDate },
};

export interface MnyInvestmentData {
  readonly securities: MnySecurity[];
  readonly securitySplits: MnySecuritySplit[];
  readonly prices: MnySecurityPrice[];
  readonly investmentDetails: MnyInvestmentDetail[];
  readonly lots: MnyLot[];
  /**
   * Security handle for each `SEC_SPLIT` row, resolved through the price rows
   * that reference it. Splits with no price row are absent from the map.
   */
  readonly splitSecurities: ReadonlyMap<number, number>;
  readonly availability: readonly TableAvailability[];
}

function resolveSplitSecurities(
  prices: readonly MnySecurityPrice[],
): Map<number, number> {
  const bySplit = new Map<number, number>();
  for (const price of prices) {
    if (price.split !== null && price.security !== null) {
      // Every price row of a split names the same security, so first wins.
      if (!bySplit.has(price.split)) {
        bySplit.set(price.split, price.security);
      }
    }
  }
  return bySplit;
}

export function readInvestmentData(db: MnyDatabase): MnyInvestmentData {
  const securities = readTableByName(db, "SEC", SECURITY_SPEC);
  const securitySplits = readTableByName(db, "SEC_SPLIT", SECURITY_SPLIT_SPEC);
  const prices = readTableByName(db, "SP", SECURITY_PRICE_SPEC);
  const investmentDetails = readTableByName(
    db,
    "TRN_INV",
    INVESTMENT_DETAIL_SPEC,
  );
  const lots = readTableByName(db, "LOT", LOT_SPEC);

  return {
    securities: securities.rows,
    securitySplits: securitySplits.rows,
    prices: prices.rows,
    investmentDetails: investmentDetails.rows,
    lots: lots.rows,
    splitSecurities: resolveSplitSecurities(prices.rows),
    availability: [
      securities.availability,
      securitySplits.availability,
      prices.availability,
      investmentDetails.availability,
      lots.availability,
    ],
  };
}
