import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import type { TourDefinition, TourRequirement } from './types';

export type TourRequirementMap = Record<TourRequirement, boolean>;

/**
 * What to assume when a lookup fails. Optimistic on purpose: a network blip must
 * not silently swallow a tour section, or hide a tour the user does have the
 * data for. The failure mode of guessing "met" is a step that turns out to have
 * nothing to point at, which the engine already handles gracefully.
 */
const ASSUME_MET = true;

/**
 * Run one lookup, falling back to ASSUME_MET on any failure.
 *
 * The lookup is a thunk rather than a promise so that a *synchronous* throw is
 * caught too. `api.getThing().catch(...)` only handles a rejection: if the call
 * itself throws -- the module is not what we expect, the method is missing --
 * the error escapes before `.catch` is ever attached, and an offer surface that
 * merely wanted to know whether to list a tour takes the whole page down with
 * it. Deciding which tours to show is never worth that.
 */
async function isMet(lookup: () => Promise<boolean>): Promise<boolean> {
  try {
    return await lookup();
  } catch {
    return ASSUME_MET;
  }
}

/**
 * Resolve every data requirement in one pass.
 *
 * Shared by the tour engine (which omits individual steps) and by the offer
 * surfaces (which hide whole tours), so the two can never disagree about
 * whether a user has the data a tour talks about.
 */
export async function resolveTourRequirements(): Promise<TourRequirementMap> {
  const [transactionEntry, securitiesExist] = await Promise.all([
    isMet(() => accountsApi.getAll(false).then((accounts) => accounts.length > 0)),
    // Active securities only, matching what the securities list shows by
    // default: a tour that asks the user to open one from that list should not
    // be offered on the strength of a security they would have to unhide first.
    isMet(() =>
      investmentsApi.getSecurities().then((securities) => securities.length > 0),
    ),
  ]);
  return { transactionEntry, securitiesExist };
}

/**
 * Whether a tour should be offered at all. An ungated tour always is; a gated
 * one waits until its requirement is known to be met, so it never appears and
 * then disappears from a list the user is reading.
 */
export function isTourOfferable(
  tour: TourDefinition,
  requirements: TourRequirementMap | null,
): boolean {
  if (!tour.requiresData) return true;
  return requirements?.[tour.requiresData] === true;
}
