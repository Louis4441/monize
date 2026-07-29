import { mnyTransaction, mnyTransfer } from "../__fixtures__/mny-row-builders";
import { indexTransfers } from "./map-transfers";

const rows = [1, 2, 3, 4].map((handle) => mnyTransaction({ handle }));

describe("indexTransfers", () => {
  it("records a pair in both directions", () => {
    const index = indexTransfers([mnyTransfer({ from: 1, to: 2 })], rows);

    expect(index.partnerByHandle.get(1)).toBe(2);
    expect(index.partnerByHandle.get(2)).toBe(1);
    expect(index.orphanedHandles.size).toBe(0);
  });

  it("indexes several independent pairs", () => {
    const index = indexTransfers(
      [mnyTransfer({ from: 1, to: 2 }), mnyTransfer({ from: 3, to: 4 })],
      rows,
    );

    expect(index.partnerByHandle.size).toBe(4);
    expect(index.partnerByHandle.get(3)).toBe(4);
  });

  it("tolerates Money listing the same pair from both ends", () => {
    const index = indexTransfers(
      [mnyTransfer({ from: 1, to: 2 }), mnyTransfer({ from: 2, to: 1 })],
      rows,
    );

    expect(index.partnerByHandle.get(1)).toBe(2);
    expect(index.partnerByHandle.size).toBe(2);
  });

  it("keeps the first pairing when a handle is claimed twice", () => {
    const index = indexTransfers(
      [mnyTransfer({ from: 1, to: 2 }), mnyTransfer({ from: 1, to: 3 })],
      rows,
    );

    expect(index.partnerByHandle.get(1)).toBe(2);
    expect(index.partnerByHandle.has(3)).toBe(false);
  });

  describe("orphaned sides", () => {
    it("marks a side whose counterpart is not in the file", () => {
      const index = indexTransfers([mnyTransfer({ from: 1, to: 999 })], rows);

      expect([...index.orphanedHandles]).toEqual([1]);
      expect(index.partnerByHandle.size).toBe(0);
    });

    it("marks a side whose counterpart handle is null", () => {
      const index = indexTransfers([mnyTransfer({ from: 2, to: null })], rows);

      expect([...index.orphanedHandles]).toEqual([2]);
    });

    it("ignores a pair where neither side exists", () => {
      const index = indexTransfers([mnyTransfer({ from: 500, to: 999 })], rows);

      expect(index.orphanedHandles.size).toBe(0);
      expect(index.partnerByHandle.size).toBe(0);
    });

    it("ignores a row with no handles at all", () => {
      const index = indexTransfers(
        [mnyTransfer({ from: null, to: null })],
        rows,
      );

      expect(index.orphanedHandles.size).toBe(0);
    });
  });

  it("returns empty maps for a file with no transfers", () => {
    const index = indexTransfers([], rows);

    expect(index.partnerByHandle.size).toBe(0);
    expect(index.orphanedHandles.size).toBe(0);
  });

  it("ignores transactions with no handle when deciding what exists", () => {
    const index = indexTransfers(
      [mnyTransfer({ from: 1, to: 2 })],
      [mnyTransaction({ handle: 1 }), mnyTransaction({ handle: null })],
    );

    expect([...index.orphanedHandles]).toEqual([1]);
  });
});
