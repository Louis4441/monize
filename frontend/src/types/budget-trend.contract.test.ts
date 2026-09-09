import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..');

const backendTypes = readFileSync(
  join(REPO_ROOT, 'backend/src/budgets/budget-reports.service.ts'),
  'utf8',
);
const frontendTypes = readFileSync(join(__dirname, 'budget.ts'), 'utf8');

function interfaceBody(source: string, name: string): string {
  const match = source.match(
    new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  expect(match, `${name} declaration not found`).toBeTruthy();
  return match![1];
}

describe('budget trend month API contract', () => {
  it('uses the same structural YYYY-MM field for overview trend points', () => {
    for (const source of [backendTypes, frontendTypes]) {
      const body = interfaceBody(source, 'BudgetTrendPoint');
      expect(body).toMatch(/monthKey:\s*string;/);
      expect(body).not.toMatch(/\bmonth:\s*string;/);
    }
  });

  it('uses the same structural field for category trend points', () => {
    const backendPoint = interfaceBody(backendTypes, 'CategoryTrendPoint');
    const frontendPoint = interfaceBody(frontendTypes, 'CategoryTrendDataPoint');

    for (const body of [backendPoint, frontendPoint]) {
      expect(body).toMatch(/monthKey:\s*string;/);
      expect(body).not.toMatch(/\bmonth:\s*string;/);
    }
    expect(interfaceBody(backendTypes, 'CategoryTrendSeries')).toMatch(
      /data:\s*Array<\{[\s\S]*?monthKey:\s*string;/,
    );
  });
});
