import { RuleEffects } from "./rule-effects";
import { CandidateUnit } from "./rule-run-candidates";

/** A unit the rule changes, with what to write. */
export interface PlannedUnit {
  readonly unit: CandidateUnit;
  readonly effects: RuleEffects;
}

/** The fields of one row a run changes, in the shape the undo reads. */
export type RowSnapshot = Record<string, unknown> & { id: string };

/**
 * What each written row held before and holds after, for the fields the plan
 * changes only: category, payee (with its name) and the tag set. The undo
 * restores exactly these; redo replays the after side. A same-owner transfer
 * contributes one entry per leg, because both legs are written.
 */
export function buildRunSnapshots(
  writable: readonly PlannedUnit[],
  tagsByRow: ReadonlyMap<string, readonly string[]>,
  payeeNames: Readonly<Record<string, string>>,
): { before: RowSnapshot[]; after: RowSnapshot[] } {
  const before: RowSnapshot[] = [];
  const after: RowSnapshot[] = [];
  for (const { unit, effects } of writable) {
    const { changes } = effects;
    for (const leg of unit.legs) {
      const was: RowSnapshot = { id: leg.id };
      const will: RowSnapshot = { id: leg.id };
      if (changes.categoryId !== undefined) {
        was.categoryId = leg.categoryId;
        will.categoryId = changes.categoryId;
      }
      if (changes.payeeId !== undefined) {
        was.payeeId = leg.payeeId;
        was.payeeName = leg.payeeName;
        will.payeeId = changes.payeeId;
        will.payeeName =
          changes.payeeId === null
            ? null
            : (payeeNames[changes.payeeId] ?? null);
      }
      if (changes.addTagIds.length + changes.removeTagIds.length > 0) {
        const current = tagsByRow.get(leg.id) ?? [];
        was.tagIds = [...current];
        will.tagIds = [
          ...current.filter((id) => !changes.removeTagIds.includes(id)),
          ...changes.addTagIds.filter((id) => !current.includes(id)),
        ];
      }
      before.push(was);
      after.push(will);
    }
  }
  return { before, after };
}
