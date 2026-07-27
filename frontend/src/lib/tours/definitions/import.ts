import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/**
 * Evergreen "bringing your data in" tour: where the importer lives, what files
 * to arrive with, and the order to feed them in. Distilled from the wiki's
 * Microsoft Money guide (Importing-from-Microsoft-Money), because the mistakes
 * that guide exists to prevent are all made *before* the wizard opens -- Strict
 * instead of Loose QIF, one export per investment account instead of two,
 * brokerage files ahead of the cash files they transfer from. The wizard itself
 * is signposted rather than walked: its later steps only exist once real files
 * are parsed, and no tour can conjure those up.
 *
 * The two anchored steps are `unobtrusive`: both ask the user to look at a
 * screen (the Tools menu, the upload panel) rather than at one control, and
 * dimming would hide it. The rest are centered cards, so the tour runs the same
 * whether or not an import is already in progress.
 *
 * Full walkthrough, screenshots and troubleshooting stay in the wiki; the step
 * copy points there rather than trying to reproduce it.
 */
export const IMPORT_TOUR: TourDefinition = {
  id: 'import/bringing-data-in',
  area: 'tools',
  i18nPrefix: 'import.bringingDataIn',
  steps: [
    {
      // Route-agnostic: shows wherever the tour was launched from.
      id: 'welcome',
      anchorId: null,
    },
    {
      // The importer is a Tools entry, which is exactly where people fail to
      // find it; open the menu and point at the row.
      id: 'whereItLives',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.navImportLink,
      openToolsMenu: true,
      placement: 'right',
      unobtrusive: true,
      skipOnMobile: true,
    },
    {
      id: 'files',
      route: '/import',
      anchorId: TOUR_ANCHORS.importDropzone,
      placement: 'auto',
      unobtrusive: true,
    },
    {
      // Order matters and cannot be undone cheaply, so it gets its own step.
      id: 'order',
      route: '/import',
      anchorId: null,
    },
    {
      id: 'wizard',
      route: '/import',
      anchorId: TOUR_ANCHORS.importStepper,
      placement: 'bottom',
    },
    {
      id: 'afterwards',
      route: '/import',
      anchorId: null,
    },
  ],
};
