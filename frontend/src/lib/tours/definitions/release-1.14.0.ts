import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/** Minor line these tours belong to; matched against the running major.minor. */
export const RELEASE_1_14_MINOR = '1.14';

/**
 * The new security detail page (discussion #964).
 *
 * Short on purpose: the page is a reading surface, not a workflow, so there is
 * nothing to fill in and no form to open. Five content steps name what each
 * region answers, in the order they appear down the page, and the user drives
 * the one navigation themselves.
 *
 * `requiresData` hides the whole tour for a user with no securities. Every step
 * after the first lives on `/securities/<id>`, and no such page exists for them
 * -- the tour would open on a prompt they cannot satisfy. Gating one step would
 * not help: the rest would go with it.
 *
 * The id of a security is the user's to pick, so the second step waits on a
 * route change rather than pointing at a row: the securities list repeats its
 * Details action per row, and no single row is the right one to spotlight.
 */
export const RELEASE_1_14_SECURITY_DETAIL_TOUR: TourDefinition = {
  id: 'release-1.14.0/security-detail',
  area: 'investments',
  version: RELEASE_1_14_MINOR,
  i18nPrefix: 'release.v1_14_0.securityDetail',
  requiresData: 'securitiesExist',
  steps: [
    {
      // Route-agnostic welcome: shows wherever the tour was launched from, so it
      // never fights a closing What's New modal's history.back().
      id: 'welcome',
      anchorId: null,
    },
    {
      // The user picks which security to open, so this waits for any
      // /securities/<id>. Unobtrusive: they have to read the list and choose,
      // and dimming it would hide the very thing they are choosing from.
      id: 'openDetail',
      route: '/securities',
      anchorId: null,
      unobtrusive: true,
      advance: { type: 'route', route: '/securities/' },
    },
    {
      // What you hold and what it is worth, in one row above the chart.
      id: 'summary',
      route: '/securities',
      routeMatch: '/securities/',
      anchorId: TOUR_ANCHORS.securityDetailSummary,
      placement: 'bottom',
      // A security sold down to nothing shows the closed-position panel here
      // instead of the cards, and that is worth a sentence rather than a gap in
      // the step counter.
      fallbackWhenMissing: true,
      // The user drove the navigation, so the page is already rendered: the
      // cards either mounted with it or were replaced. A long wait would sit
      // behind a blank overlay before explaining itself.
      anchorTimeoutMs: 2500,
    },
    {
      // The chart plus its two rows of controls. `allowInteraction` so the user
      // can switch series and ranges while reading about them -- the whole point
      // of the step is that these are worth trying.
      id: 'chart',
      route: '/securities',
      routeMatch: '/securities/',
      anchorId: TOUR_ANCHORS.securityDetailChart,
      placement: 'auto',
      allowInteraction: true,
    },
    {
      // The column beside the chart: what the instrument is, and what it is
      // made of.
      id: 'keyInfo',
      route: '/securities',
      routeMatch: '/securities/',
      anchorId: TOUR_ANCHORS.securityDetailKeyInfo,
      placement: 'left',
      // Narrow screens stack it under the chart, where "beside the chart" makes
      // no sense and the step would need a different sentence.
      skipOnMobile: true,
    },
    {
      // Where the rest of the detail lives: the description, the period returns,
      // the sector and country breakdowns, and the tables the list's modals used
      // to be the only route to.
      id: 'tabs',
      route: '/securities',
      routeMatch: '/securities/',
      anchorId: TOUR_ANCHORS.securityDetailTabs,
      placement: 'bottom',
    },
    {
      id: 'finish',
      anchorId: null,
    },
  ],
};

export const RELEASE_1_14_TOURS: readonly TourDefinition[] = [
  RELEASE_1_14_SECURITY_DETAIL_TOUR,
];
