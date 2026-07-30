import { MnyTransaction, MnyTransfer } from "../model/mny-rows";

/**
 * `TRN_XFER` is Money's authoritative record of which two transactions are the
 * two sides of one transfer. Having it is the reason this importer never falls
 * back to the QIF processor's name-and-amount matching (design ADR-8) -- that
 * heuristic is implicated in PR #192's loan-split bug.
 *
 * This module only builds the index. Deciding what to do with each side belongs
 * to the transaction mapper, which knows which accounts the user selected.
 */

export interface TransferIndex {
  /** `htrn` -> its counterpart `htrn`, recorded in both directions. */
  readonly partnerByHandle: ReadonlyMap<number, number>;
  /**
   * Sides whose counterpart is not in the file at all -- a dangling reference
   * left behind when Money deleted the other half. These are the genuine
   * phantom rows the design excludes.
   *
   * Deliberately narrow: a counterpart that exists but sits in an account the
   * user chose not to import is **not** orphaned. Dropping that row would
   * silently remove real money from an account the user *did* import, which is
   * exactly the kind of discrepancy the verification report exists to catch.
   */
  readonly orphanedHandles: ReadonlySet<number>;
}

/**
 * Indexes `TRN_XFER` against the transactions that actually exist.
 *
 * A handle already claimed by an earlier pair keeps that pairing: Money should
 * never list one side twice, and picking the first is stable and observable
 * rather than order-dependent overwriting.
 */
export function indexTransfers(
  transfers: readonly MnyTransfer[],
  transactions: readonly MnyTransaction[],
): TransferIndex {
  const existing = new Set(
    transactions
      .map((transaction) => transaction.handle)
      .filter((handle): handle is number => handle !== null),
  );

  const partnerByHandle = new Map<number, number>();
  const orphanedHandles = new Set<number>();

  for (const transfer of transfers) {
    const { from, to } = transfer;
    if (from === null && to === null) {
      continue;
    }

    // One side missing entirely: the surviving side is orphaned.
    if (from === null || to === null) {
      const survivor = from ?? to;
      if (survivor !== null && existing.has(survivor)) {
        orphanedHandles.add(survivor);
      }
      continue;
    }

    const fromExists = existing.has(from);
    const toExists = existing.has(to);

    if (fromExists && toExists) {
      if (!partnerByHandle.has(from) && !partnerByHandle.has(to)) {
        partnerByHandle.set(from, to);
        partnerByHandle.set(to, from);
      }
      continue;
    }

    if (fromExists) {
      orphanedHandles.add(from);
    }
    if (toExists) {
      orphanedHandles.add(to);
    }
  }

  return { partnerByHandle, orphanedHandles };
}
