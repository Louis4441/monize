/**
 * The transaction register's column contract: which columns exist, in what
 * order, and the width each becomes visible at.
 *
 * Before this file the visibility classes were hand-written per `<th>` and
 * `<td>`, and they drifted into incoherence: Status (which the user ranks
 * high) appeared last of all at 1400px, Attachments (ranked low) appeared
 * before Tags (ranked medium), and the Account column rendered on
 * single-account pages where every row repeats the page's own title. Writing
 * the order and the tiers once is what makes the register predictable; the
 * guard test beside this file fails any visibility class that does not come
 * from here.
 *
 * Two rules the tiers do not express, stated here because they are part of
 * the same contract:
 *
 * - **Density never changes which columns exist.** Normal/Compact/Dense move
 *   padding and secondary content (`useTableDensity`), not columns -- a column
 *   set that changed with density would make the same window show different
 *   registers depending on a toggle about row height.
 * - **The Account column is structural, not responsive.** It renders only when
 *   the list spans more than one account (`!isSingleAccountView`); on a single
 *   account's page it is omitted from the DOM entirely, at every width. When
 *   it does render, it takes its tier below like any other column.
 */
export const REGISTER_COLUMN_ORDER = [
  'date',
  'account',
  'payee',
  'category',
  'description',
  'refNumber',
  'tags',
  'attachments',
  'amount',
  // The three FX columns are a feature set (`showFxColumns`), present only on
  // the account-detail Foreign Currency Transaction Fees section; when the
  // feature asks for them they are always visible, like Amount.
  'paidCurrency',
  'paidAmount',
  'feePaid',
  'balance',
  'status',
  'actions',
] as const;

export type RegisterColumnId = (typeof REGISTER_COLUMN_ORDER)[number];

/**
 * The visibility tiers, from the user-facing spec:
 *
 * - `always`: part of what a register *is* -- visible at every width.
 * - `high`, `medium`, `low`: appear as the window widens, in that order.
 * - `exceptPhones`: the Actions column -- everywhere but phone widths, where
 *   the long-press action sheet carries the same actions.
 */
export type RegisterColumnPriority =
  | 'always'
  | 'high'
  | 'medium'
  | 'low'
  | 'exceptPhones';

export const REGISTER_COLUMN_PRIORITY: Record<
  RegisterColumnId,
  RegisterColumnPriority
> = {
  date: 'always',
  account: 'high',
  payee: 'always',
  category: 'high',
  description: 'low',
  refNumber: 'low',
  tags: 'medium',
  attachments: 'low',
  amount: 'always',
  paidCurrency: 'always',
  paidAmount: 'always',
  feePaid: 'always',
  balance: 'always',
  status: 'high',
  actions: 'exceptPhones',
};

/**
 * One breakpoint per tier. A tier maps to a class, never a column to a class,
 * so two columns of the same rank cannot appear at different widths.
 *
 * The `min-[480px]` on Actions predates the tiers (it is where the action
 * sheet stops being the only way to act on a row) and 900px is where the
 * category pills genuinely have room; both are deliberate off-scale values,
 * which is why they are spelled as arbitrary variants rather than the nearest
 * named breakpoint.
 */
const PRIORITY_VISIBILITY: Record<RegisterColumnPriority, string> = {
  always: '',
  high: 'hidden min-[900px]:table-cell',
  medium: 'hidden xl:table-cell',
  low: 'hidden 2xl:table-cell',
  exceptPhones: 'hidden min-[480px]:table-cell',
};

/**
 * The minimum viewport width, in px, at which each tier's columns render.
 * Exported for the guard test, which asserts the tiers appear in rank order
 * (high before medium before low) rather than trusting the class strings.
 */
export const PRIORITY_MIN_WIDTH_PX: Record<RegisterColumnPriority, number> = {
  always: 0,
  high: 900,
  medium: 1280, // Tailwind `xl`
  low: 1536, // Tailwind `2xl`
  exceptPhones: 480,
};

/**
 * The responsive-visibility classes for a register column's `<th>` and `<td>`.
 * Empty string for an always-visible column, so call sites can interpolate it
 * unconditionally.
 */
export function registerColumnClass(id: RegisterColumnId): string {
  return PRIORITY_VISIBILITY[REGISTER_COLUMN_PRIORITY[id]];
}

/**
 * The Description column's truncation cap. Viewport-relative on purpose: the
 * column only exists at `low`-tier widths and is the one column asked to grow
 * with the page, so a wider window shows more of the description instead of
 * more empty space.
 */
export const REGISTER_DESCRIPTION_MAX_WIDTH = 'max-w-[18vw]';
