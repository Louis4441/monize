import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('/src/components/reports/SecurityTypeAllocationReport.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

describe('SecurityTypeAllocationReport translates type and quantity labels', () => {
  it('scans the production component', () => {
    expect(Object.keys(sources)).toEqual([
      '/src/components/reports/SecurityTypeAllocationReport.tsx',
    ]);
  });

  it('gets known security type labels from the existing dashboard catalogue', () => {
    const source = Object.values(sources)[0];

    expect(source).not.toMatch(/const\s+TYPE_LABELS\b/);
    expect(source).toContain("useTranslations('dashboard')");
    expect(source).toContain('tDashboard(`securityTypeAllocation.types.${type}`)');
  });

  it('labels a child quantity as shares, not as the parent holding count', () => {
    const source = Object.values(sources)[0];
    const quantityCell = source.match(
      /<td role="cell" className=\{`\$\{CHILD_CELL_PLACEMENT\.count\}[\s\S]*?<\/td>/,
    )?.[0];

    expect(quantityCell).toBeDefined();
    expect(quantityCell).toContain("t('securityTypeAllocation.colShares')");
    expect(quantityCell).not.toContain('columns.count.label');
  });
});
