import { OFX_EXTERNAL_ID_PREFIX, ofxExternalId } from "./ofx-external-id";
import { EXTERNAL_ID_MAX_LENGTH } from "../transactions/transaction-external-id";

describe("ofxExternalId", () => {
  it("prefixes the bank's id", () => {
    expect(ofxExternalId("20260115-0001")).toBe("ofx:20260115-0001");
  });

  it("trims the id, so a download with stray spaces maps to the same key", () => {
    expect(ofxExternalId("  ABC  ")).toBe("ofx:ABC");
  });

  it.each([undefined, null, "", "   "])(
    "gives no key for a row without an id (%p)",
    (fitId) => {
      expect(ofxExternalId(fitId)).toBeNull();
    },
  );

  it("keeps the longest id that fits the column", () => {
    const fitId = "9".repeat(
      EXTERNAL_ID_MAX_LENGTH - OFX_EXTERNAL_ID_PREFIX.length,
    );
    expect(ofxExternalId(fitId)).toHaveLength(EXTERNAL_ID_MAX_LENGTH);
  });

  it("gives no key for an id too long to store, rather than a cut one that could match another row", () => {
    const fitId = "9".repeat(
      EXTERNAL_ID_MAX_LENGTH - OFX_EXTERNAL_ID_PREFIX.length + 1,
    );
    expect(ofxExternalId(fitId)).toBeNull();
  });
});
