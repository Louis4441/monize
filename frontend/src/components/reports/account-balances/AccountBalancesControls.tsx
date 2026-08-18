'use client';

import { useTranslations } from 'next-intl';
import { DateInput } from '@/components/ui/DateInput';
import { Select } from '@/components/ui/Select';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/MultiSelect';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import {
  GROUP_BY_OPTIONS,
  SORT_BY_OPTIONS,
  type AccountBalanceFilters,
  type BalanceScope,
  type FavouriteFilter,
  type GroupBy,
  type SortBy,
  type SortDirection,
  type StatusFilter,
} from './grouping';

export type ViewMode = 'table' | 'chart';

interface Props {
  asOfDate: string;
  onAsOfDateChange: (date: string) => void;
  filters: AccountBalanceFilters;
  onFiltersChange: (filters: AccountBalanceFilters) => void;
  institutionOptions: MultiSelectOption[];
  accountTypeOptions: MultiSelectOption[];
  groupBy: GroupBy;
  onGroupByChange: (groupBy: GroupBy) => void;
  sortBy: SortBy;
  onSortByChange: (sortBy: SortBy) => void;
  sortDirection: SortDirection;
  onSortDirectionToggle: () => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onExportPdf: () => void;
  onExportCsv: () => void;
}

const SCOPES: BalanceScope[] = ['all', 'assets', 'liabilities'];

/**
 * The report's toolbar: the date the balances are measured at, what is
 * included, how it is grouped and how it is ordered (issue #1198).
 *
 * Split out of the report so the component that renders the figures is not also
 * the component that owns nine pieces of control state.
 */
export function AccountBalancesControls({
  asOfDate,
  onAsOfDateChange,
  filters,
  onFiltersChange,
  institutionOptions,
  accountTypeOptions,
  groupBy,
  onGroupByChange,
  sortBy,
  onSortByChange,
  sortDirection,
  onSortDirectionToggle,
  viewMode,
  onViewModeChange,
  onExportPdf,
  onExportCsv,
}: Props) {
  const t = useTranslations('reports');

  const groupByOptions = GROUP_BY_OPTIONS.map((value) => ({
    value,
    label: t(`accountBalances.groupBy${value.charAt(0).toUpperCase()}${value.slice(1)}` as Parameters<typeof t>[0]),
  }));
  const sortByOptions = SORT_BY_OPTIONS.map((value) => ({
    value,
    label: t(`accountBalances.sortBy${value.charAt(0).toUpperCase()}${value.slice(1)}` as Parameters<typeof t>[0]),
  }));

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 space-y-4">
      <div className="flex flex-wrap gap-4 items-end justify-between">
        <div className="w-full sm:w-56">
          <DateInput
            label={t('accountBalances.asOfDate')}
            value={asOfDate}
            onDateChange={onAsOfDateChange}
            data-testid="as-of-date"
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Select
              label={t('accountBalances.groupByLabel')}
              value={groupBy}
              onChange={(e) => onGroupByChange(e.target.value as GroupBy)}
              options={groupByOptions}
            />
          </div>
          <div className="w-40">
            <Select
              label={t('accountBalances.sortByLabel')}
              value={sortBy}
              onChange={(e) => onSortByChange(e.target.value as SortBy)}
              options={sortByOptions}
            />
          </div>
          <button
            type="button"
            onClick={onSortDirectionToggle}
            aria-label={
              sortDirection === 'asc'
                ? t('accountBalances.sortAscending')
                : t('accountBalances.sortDescending')
            }
            title={
              sortDirection === 'asc'
                ? t('accountBalances.sortAscending')
                : t('accountBalances.sortDescending')
            }
            className="self-stretch px-3 rounded-md border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            {sortDirection === 'asc' ? '↑' : '↓'}
          </button>
          <div className="flex gap-1 self-stretch items-center">
            <button
              type="button"
              onClick={() => onViewModeChange('table')}
              className={`p-2 rounded-md transition-colors ${
                viewMode === 'table'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
              title={t('accountBalances.tableView')}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('chart')}
              className={`p-2 rounded-md transition-colors ${
                viewMode === 'chart'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
              title={t('accountBalances.chartView')}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11 2v20c-5.07-.5-9-4.79-9-10s3.93-9.5 9-10zm2.03 0v8.99H22c-.47-4.74-4.24-8.52-8.97-8.99zm0 11.01V22c4.74-.47 8.5-4.25 8.97-8.99h-8.97z" />
              </svg>
            </button>
            <ExportDropdown onExportPdf={onExportPdf} onExportCsv={onExportCsv} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 items-end">
        <div className="flex flex-wrap gap-2 self-end pb-1">
          {SCOPES.map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => onFiltersChange({ ...filters, scope })}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors capitalize ${
                filters.scope === scope
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              {t(`accountBalances.filter${scope.charAt(0).toUpperCase()}${scope.slice(1)}` as Parameters<typeof t>[0])}
            </button>
          ))}
        </div>
        <div className="w-full sm:w-56">
          <MultiSelect
            label={t('accountBalances.institutionsLabel')}
            options={institutionOptions}
            value={filters.institutionKeys}
            onChange={(institutionKeys) => onFiltersChange({ ...filters, institutionKeys })}
            placeholder={t('accountBalances.institutionsPlaceholder')}
          />
        </div>
        <div className="w-full sm:w-56">
          <MultiSelect
            label={t('accountBalances.accountTypesLabel')}
            options={accountTypeOptions}
            value={filters.accountTypes}
            onChange={(accountTypes) => onFiltersChange({ ...filters, accountTypes })}
            placeholder={t('accountBalances.accountTypesPlaceholder')}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            label={t('accountBalances.statusLabel')}
            value={filters.status}
            onChange={(e) =>
              onFiltersChange({ ...filters, status: e.target.value as StatusFilter })
            }
            options={[
              { value: 'open', label: t('accountBalances.statusOpen') },
              { value: 'closed', label: t('accountBalances.statusClosed') },
              { value: 'all', label: t('accountBalances.statusAll') },
            ]}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            label={t('accountBalances.favouritesLabel')}
            value={filters.favourite}
            onChange={(e) =>
              onFiltersChange({ ...filters, favourite: e.target.value as FavouriteFilter })
            }
            options={[
              { value: 'all', label: t('accountBalances.favouritesAll') },
              { value: 'favourites', label: t('accountBalances.favouritesOnly') },
              { value: 'others', label: t('accountBalances.favouritesOthers') },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
