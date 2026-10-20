import { EXTERNAL_ID_MAX_LENGTH } from "../transactions/transaction-external-id";

/**
 * An OFX row is stored with the bank's own id for it as its `externalId`, the
 * column an API create keys its retries on (`transaction-external-id.ts`). The
 * OFX specification makes a `FITID` unique per account, so a row whose key the
 * account already holds was imported before, from an earlier download or
 * earlier in the same file, and the import skips it.
 *
 * The prefix keeps the bank's id apart from a key an API client chose for a
 * row of its own. It makes a clash unlikely, not impossible: an API key is free
 * text, and a client could send one that starts with it.
 */
export const OFX_EXTERNAL_ID_PREFIX = "ofx:";

/**
 * The `externalId` for a row with this `FITID`, or null when the row has none
 * or its key would not fit the column; such a row imports as it did before the
 * key existed, with no duplicate check of its own.
 */
export function ofxExternalId(fitId: string | null | undefined): string | null {
  const trimmed = fitId?.trim() ?? "";
  if (trimmed === "") return null;
  const key = `${OFX_EXTERNAL_ID_PREFIX}${trimmed}`;
  return key.length <= EXTERNAL_ID_MAX_LENGTH ? key : null;
}
