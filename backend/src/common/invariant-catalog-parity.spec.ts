import { readFileSync } from "fs";
import { join } from "path";

/**
 * The invariant catalog and the verification matrix must name the same set of
 * invariants.
 *
 * `docs/system-invariants.md` defines the IDs (its Index table) and
 * `docs/verification-contract.md` says, per ID, which kind of test each one
 * needs (its matrix). The two drift silently: an invariant added to the catalog
 * with no matrix row has no stated required-test kind, and a matrix row with no
 * catalog entry describes a claim nothing defines. That is exactly what happened
 * when INV-RECONCILE-001 was catalogued and enforced while the matrix had no row
 * for it -- prose could not catch it, so this scan does.
 *
 * Both documents write their IDs as the first cell of a table row (`| INV-... |`
 * in the Index, `| INV-... <description> |` in the matrix), so the same
 * line-anchored match reads both.
 */
const DOCS = join(__dirname, "..", "..", "..", "docs");

function tableRowInvariantIds(file: string): Set<string> {
  const text = readFileSync(join(DOCS, file), "utf8");
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^\|\s*(INV-[A-Z]+-\d+)\b/.exec(line);
    if (match) ids.add(match[1]);
  }
  return ids;
}

describe("the invariant catalog and the verification matrix cover the same IDs", () => {
  const catalog = tableRowInvariantIds("system-invariants.md");
  const matrix = tableRowInvariantIds("verification-contract.md");

  it("reads a plausible number of invariants from each document", () => {
    // A parsing regression (a reformatted table) would empty one set and make
    // the parity checks below pass vacuously; anchor them against reality.
    expect(catalog.size).toBeGreaterThan(20);
    expect(matrix.size).toBeGreaterThan(20);
  });

  it("gives every catalogued invariant a verification-matrix row", () => {
    const missing = [...catalog].filter((id) => !matrix.has(id)).sort();
    expect(missing).toEqual([]);
  });

  it("backs every verification-matrix row with a catalogued invariant", () => {
    const extra = [...matrix].filter((id) => !catalog.has(id)).sort();
    expect(extra).toEqual([]);
  });
});
