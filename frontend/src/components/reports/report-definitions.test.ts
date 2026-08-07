import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import enReports from '@/i18n/messages/en/reports.json';
import {
  REPORT_CATEGORIES,
  builtInReports,
  categoryColors,
} from './report-definitions';

/**
 * `builtInReports` is the list the Reports page renders *and* the list the
 * report switcher offers as destinations, so an id in one and not the other is
 * either a report nobody can reach from a report page or a menu entry that
 * routes to "Report Not Found". Both are invisible until someone opens the
 * caret and clicks the wrong row, which is exactly the kind of list the machine
 * should be checking (see the currency-references rule in `CLAUDE.md`).
 */
const here = dirname(fileURLToPath(import.meta.url));
const appReportsDir = join(here, '../../app/reports');

/** Report ids the generic `[reportId]` renderer knows how to draw. */
function lazyRenderedIds(): string[] {
  const source = readFileSync(join(appReportsDir, '[reportId]/page.tsx'), 'utf8');
  const map = source.slice(
    source.indexOf('reportComponents'),
    source.indexOf('function ReportSkeleton'),
  );
  return [...map.matchAll(/^\s{2}'([\w-]+)':\s*lazy\(/gm)].map((m) => m[1]);
}

/** Report ids with a dedicated route directory, e.g. `/reports/gem-strategy`. */
function dedicatedRouteIds(): string[] {
  return readdirSync(appReportsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('['))
    .map((entry) => entry.name);
}

describe('the built-in report catalog', () => {
  const ids = builtInReports.map((report) => report.id);

  it('gives every report somewhere to land', () => {
    const routed = new Set([...lazyRenderedIds(), ...dedicatedRouteIds()]);
    // `/reports/<id>` is the route for every id in the catalog -- the Reports
    // page, the switcher and the favourites widget all build it that way.
    expect(ids.filter((id) => !routed.has(id))).toEqual([]);
  });

  it('lists every report the generic renderer can draw', () => {
    const known = new Set(ids);
    // The other direction: a lazily-rendered report missing from the catalog is
    // reachable by URL and offered by nothing.
    expect(lazyRenderedIds().filter((id) => !known.has(id))).toEqual([]);
  });

  it('still finds the routes it is checking against', () => {
    // Were the map renamed or its formatting changed, both checks above would
    // pass over an empty set. This fails first and says what to update.
    expect(lazyRenderedIds().length).toBeGreaterThan(20);
    expect(dedicatedRouteIds()).toContain('gem-strategy');
  });

  it('names and describes every report', () => {
    const names = enReports.page.names as Record<string, string>;
    const descriptions = enReports.page.descriptions as Record<string, string>;
    expect(ids.filter((id) => !names[id])).toEqual([]);
    expect(ids.filter((id) => !descriptions[id])).toEqual([]);
  });

  it('files every report under a known section', () => {
    const sections = new Set<string>(REPORT_CATEGORIES);
    expect(
      builtInReports
        .filter((report) => !sections.has(report.category))
        .map((report) => report.id),
    ).toEqual([]);
  });

  it('gives every section a label and a colour', () => {
    const labels = enReports.page.categories as Record<string, string>;
    expect(REPORT_CATEGORIES.filter((c) => !labels[c])).toEqual([]);
    expect(REPORT_CATEGORIES.filter((c) => !categoryColors[c])).toEqual([]);
    // And no section defined in only one of the three places.
    expect(Object.keys(categoryColors).sort()).toEqual(
      [...REPORT_CATEGORIES].sort(),
    );
  });
});
