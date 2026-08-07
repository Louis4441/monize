'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  EntitySwitcher,
  type EntitySwitcherItem,
} from '@/components/ui/EntitySwitcher';
import { REPORT_CATEGORIES } from '@/components/reports/report-definitions';
import { useReportCatalog } from '@/components/reports/useReportCatalog';

interface ReportSwitcherProps {
  /** The report on screen; it is not offered as a destination. */
  currentId: string;
}

/**
 * The caret beside a report's title that jumps straight to another report,
 * without going back to the list and picking again -- the same control the
 * account, payee, category and security detail pages carry.
 *
 * Fifty-odd reports are too many to read as one column, so the menu is grouped
 * by the section the Reports page files each under, in the same order its
 * filter chips use.
 *
 * Picking a report navigates, and the route is built here rather than by each
 * caller: an id in this menu *is* a path under `/reports/`, and two call sites
 * spelling that out separately is one of them getting it wrong later.
 */
export function ReportSwitcher({ currentId }: ReportSwitcherProps) {
  const t = useTranslations('reports');
  const router = useRouter();
  const { reports } = useReportCatalog();

  const items = useMemo<EntitySwitcherItem[]>(() => {
    const label = (category: string) =>
      t(`page.categories.${category}` as Parameters<typeof t>[0]);
    // Ordered section by section: `EntitySwitcher` takes the order of the
    // sections from the order their first item appears in.
    return REPORT_CATEGORIES.flatMap((category) =>
      reports
        .filter((report) => report.category === category)
        .map((report) => ({
          id: report.id,
          primary: report.name,
          // The section is the heading above the row, so repeating it beside
          // the name would say the same thing twice.
          group: label(category),
          searchText: `${report.name} ${label(category)}`,
        })),
    );
  }, [reports, t]);

  return (
    <EntitySwitcher
      currentId={currentId}
      items={items}
      onSelect={(id) => router.push(`/reports/${id}`)}
      triggerLabel={t('detailHeader.switchReport')}
      filterPlaceholder={t('detailHeader.switchPlaceholder')}
      noMatchesLabel={t('detailHeader.switchNoMatches')}
    />
  );
}
