import { describe, it, expect } from 'vitest';
import { IMPORT_TOUR } from './import';
import { TOUR_ANCHORS } from '../anchors';
import { ALL_TOURS } from '../registry';

const step = (id: string) => IMPORT_TOUR.steps.find((s) => s.id === id)!;

describe('import tour', () => {
  it('is an evergreen tour, offered whatever the running version', () => {
    // No `version`, so `getReleaseTours` never picks it up and it never expires
    // with a minor line -- Settings is its home.
    expect(IMPORT_TOUR.version).toBeUndefined();
    expect(ALL_TOURS).toContain(IMPORT_TOUR);
  });

  it('opens the Tools menu to point at the import entry', () => {
    const where = step('whereItLives');
    expect(where.openToolsMenu).toBe(true);
    expect(where.anchorId).toBe(TOUR_ANCHORS.navImportLink);
    // The dropdown is desktop-only, and dimming would hide the menu the step
    // is describing.
    expect(where.skipOnMobile).toBe(true);
    expect(where.unobtrusive).toBe(true);
  });

  it('shows the upload panel without dimming it', () => {
    const files = step('files');
    expect(files.route).toBe('/import');
    expect(files.anchorId).toBe(TOUR_ANCHORS.importDropzone);
    expect(files.unobtrusive).toBe(true);
  });

  it('points at the wizard step indicator when describing the wizard', () => {
    expect(step('wizard').anchorId).toBe(TOUR_ANCHORS.importStepper);
  });

  it('keeps the advice steps centered and passive', () => {
    // Order and post-import checks are about files on the user's disk and
    // balances in their old software: there is nothing on screen to ring, and
    // nothing for the engine to wait for.
    for (const id of ['welcome', 'order', 'afterwards']) {
      expect(step(id).anchorId).toBeNull();
      expect(step(id).advance).toBeUndefined();
    }
  });

  it('stays on the import page once it gets there', () => {
    const routes = IMPORT_TOUR.steps
      .slice(2)
      .map((s) => s.route)
      .filter(Boolean);
    expect(new Set(routes)).toEqual(new Set(['/import']));
  });
});
