import { describe, it, expect } from 'vitest';
import {
  RELEASE_1_14_SECURITY_DETAIL_TOUR,
  RELEASE_1_14_TOURS,
} from './release-1.14.0';
import { TOUR_ANCHORS } from '../anchors';
import { getReleaseTours } from '../registry';
import type { TourAnchorId } from '../anchors';

const tour = RELEASE_1_14_SECURITY_DETAIL_TOUR;
const ANCHOR_VALUES = new Set<TourAnchorId>(Object.values(TOUR_ANCHORS));

describe('security-detail release tour', () => {
  it('is a 1.14 release tour registered under a stable id', () => {
    expect(tour.id).toBe('release-1.14.0/security-detail');
    expect(tour.version).toBe('1.14');
    expect(tour.area).toBe('investments');
    expect(tour.i18nPrefix).toBe('release.v1_14_0.securityDetail');
    expect(RELEASE_1_14_TOURS).toContain(tour);
    expect(getReleaseTours('1.14.2').map((t) => t.id)).toContain(tour.id);
  });

  it('is offered only to users who own a security', () => {
    // Every step past the first lives on /securities/<id>, which does not exist
    // for a user with nothing in the list.
    expect(tour.requiresData).toBe('securitiesExist');
  });

  it('walks the page from top to bottom', () => {
    // The steps must follow the layout, not the order they were written in: a
    // tour that jumps down the page and back up reads as losing its place.
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'openDetail',
      'summary',
      'chart',
      'keyInfo',
      'tabs',
      'finish',
    ]);
  });

  it('stays short', () => {
    // The page is a reading surface, not a workflow: five content steps between
    // the welcome and the sign-off. A creeping step count here is the signal to
    // split the tour, not to lengthen it.
    expect(tour.steps).toHaveLength(7);
  });

  it('references only declared anchors', () => {
    for (const step of tour.steps) {
      if (step.anchorId !== null) {
        expect(ANCHOR_VALUES.has(step.anchorId)).toBe(true);
      }
      if (step.advance?.type === 'appear' || step.advance?.type === 'disappear') {
        expect(ANCHOR_VALUES.has(step.advance.anchorId)).toBe(true);
      }
    }
  });

  it('opens with a route-agnostic welcome', () => {
    // Launched from the What's New modal, a first step that navigated would
    // collide with that modal's own history.back() as it closes.
    const [welcome] = tour.steps;
    expect(welcome.id).toBe('welcome');
    expect(welcome.route).toBeUndefined();
    expect(welcome.routeMatch).toBeUndefined();
    expect(welcome.anchorId).toBeNull();
  });

  it('lets the user pick which security to open', () => {
    const step = tour.steps.find((s) => s.id === 'openDetail');
    // The list repeats its Details action per row and no row is the right one to
    // spotlight, so the step waits for any detail route instead of pointing.
    expect(step?.anchorId).toBeNull();
    expect(step?.unobtrusive).toBe(true);
    expect(step?.advance).toEqual({ type: 'route', route: '/securities/' });
  });

  it('matches the dynamic detail route for every on-page step', () => {
    const onPage = tour.steps.filter((s) => s.anchorId !== null);
    expect(onPage.length).toBeGreaterThan(0);
    for (const step of onPage) {
      // A pathname carries the security id, so these steps cannot match on an
      // exact route.
      expect(step.routeMatch).toBe('/securities/');
    }
  });

  it('explains itself when there is no position to summarise', () => {
    const step = tour.steps.find((s) => s.id === 'summary');
    // A sold-out security shows the closed-position panel instead of the cards.
    expect(step?.fallbackWhenMissing).toBe(true);
    // The user drove the navigation, so a long wait would sit behind a blank
    // overlay before the stand-in appears.
    expect(step?.anchorTimeoutMs).toBeLessThanOrEqual(3000);
  });

  it('keeps the chart usable while describing it', () => {
    const step = tour.steps.find((s) => s.id === 'chart');
    expect(step?.anchorId).toBe(TOUR_ANCHORS.securityDetailChart);
    // The step's whole point is that the series and range buttons are worth
    // trying, so the spotlight must not blanket them with a click blocker.
    expect(step?.allowInteraction).toBe(true);
  });

  it('skips the beside-the-chart step where nothing is beside the chart', () => {
    const step = tour.steps.find((s) => s.id === 'keyInfo');
    // Narrow screens stack that card underneath, where the step's wording would
    // be wrong.
    expect(step?.skipOnMobile).toBe(true);
  });

  it('ends on a route-agnostic card', () => {
    const finish = tour.steps[tour.steps.length - 1];
    expect(finish.id).toBe('finish');
    expect(finish.anchorId).toBeNull();
  });
});
