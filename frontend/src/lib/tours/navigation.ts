import { findTourAnchor } from './anchors';
import type { TourStep } from './types';

/**
 * Whether a step can be shown again right now. A `skipOnBack` step depends on
 * transient UI it does not open itself (the fields of an open form), so it is
 * only replayable while that UI -- its anchor -- is still on the page. Every
 * other step is: a centered step needs nothing, and an ordinary anchored step
 * gets its screen navigated to and its anchor waited for.
 */
function isReplayable(step: TourStep): boolean {
  if (!step.skipOnBack) return true;
  return step.anchorId === null || !!findTourAnchor(step.anchorId);
}

/**
 * The step Back should land on, or null when nothing behind the current step
 * can be replayed (so Back is not offered at all).
 */
export function backTargetIndex(
  steps: readonly TourStep[],
  stepIndex: number,
): number | null {
  for (let i = stepIndex - 1; i >= 0; i -= 1) {
    if (isReplayable(steps[i])) return i;
  }
  return null;
}
