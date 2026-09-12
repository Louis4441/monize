/**
 * The chrome for a segmented control: a pill holding two or more buttons where
 * exactly one is pressed.
 *
 * Written once because the controls sit beside each other. The Investments
 * toolbar carries the brokerage/cash switch and the Table/Calendar switch in
 * one row, and a second styling of the same idea reads as two different kinds
 * of switch. `ViewModeToggle` was a copy of `InvestmentViewToggle`'s classes
 * and had already drifted: only the copy carried
 * `motion-reduce:transition-none`, so a reader who asked for reduced motion got
 * one switch that animated and one that did not.
 *
 * Constants rather than a `<SegmentedControl>` component, for the reason
 * `interactive-row.ts` and `lib/scheduled-kind.ts` are: each control names its
 * own options, labels them from its own namespace and reports a different
 * union, so the shared part is the appearance and nothing else. Tailwind v4's
 * automatic source detection covers `.ts`, which is what makes a class
 * constant outside a component safe.
 */

/** The pill the buttons sit in. */
export const SEGMENTED_GROUP_CLASS = 'inline-flex rounded-md bg-gray-100 dark:bg-gray-700 p-0.5';

/** Every segment, pressed or not. */
export const SEGMENT_BASE_CLASS =
  'px-3 py-1 text-sm font-medium rounded transition-colors motion-reduce:transition-none';

/** The one segment that is pressed. */
export const SEGMENT_ACTIVE_CLASS =
  'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm';

/** Every segment that is not. */
export const SEGMENT_INACTIVE_CLASS =
  'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200';

/** The classes for one segment, given whether it is the pressed one. */
export function segmentClass(isActive: boolean): string {
  return `${SEGMENT_BASE_CLASS} ${isActive ? SEGMENT_ACTIVE_CLASS : SEGMENT_INACTIVE_CLASS}`;
}
