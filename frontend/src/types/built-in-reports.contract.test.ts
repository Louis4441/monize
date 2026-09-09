import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECURRING_EXPENSE_FREQUENCIES } from './built-in-reports';

const REPO_ROOT = join(__dirname, '..', '..', '..');

function backendDtoSource(): string {
  return readFileSync(
    join(REPO_ROOT, 'backend/src/built-in-reports/dto/recurring-expenses.dto.ts'),
    'utf8',
  );
}

function uncategorizedBackendDtoSource(): string {
  return readFileSync(
    join(REPO_ROOT, 'backend/src/built-in-reports/dto/uncategorized-transactions.dto.ts'),
    'utf8',
  );
}

function frontendTypesSource(): string {
  return readFileSync(join(__dirname, 'built-in-reports.ts'), 'utf8');
}

function backendFrequencyCodes(source: string): string[] {
  const declaration = source.match(
    /export const RECURRING_EXPENSE_FREQUENCIES\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  expect(declaration, 'backend recurring-expense frequency list not found').toBeTruthy();
  return [...declaration![1].matchAll(/"([A-Z]+)"/g)].map((match) => match[1]);
}

describe('recurring-expenses API contract', () => {
  it('keeps the frontend frequency union equal to the backend DTO enum', () => {
    expect(backendFrequencyCodes(backendDtoSource())).toEqual([
      ...RECURRING_EXPENSE_FREQUENCIES,
    ]);
  });

  it('keeps an absent category structural instead of substituting display copy', () => {
    expect(backendDtoSource()).toMatch(/categoryName:\s*string\s*\|\s*null/);
  });
});

describe('uncategorized-transactions money contract', () => {
  it('carries a currency code beside every transaction amount in both layers', () => {
    expect(uncategorizedBackendDtoSource()).toMatch(
      /class UncategorizedTransactionItem\s*\{[^}]*amount:\s*number;[^}]*currencyCode:\s*string;/,
    );
    expect(frontendTypesSource()).toMatch(
      /interface UncategorizedTransactionItem\s*\{[^}]*amount:\s*number;[^}]*currencyCode:\s*string;/,
    );
  });

  it('couples every converted summary amount to its destination currency', () => {
    const backend = uncategorizedBackendDtoSource();
    const frontend = frontendTypesSource();

    expect(backend).toMatch(
      /class UncategorizedTransactionsSummary\s*\{[^}]*expenseTotal:\s*number;[^}]*incomeTotal:\s*number;[^}]*currencyCode:\s*string;/,
    );
    expect(frontend).toMatch(
      /interface UncategorizedTransactionsResponse\s*\{[^}]*summary:\s*\{[^}]*expenseTotal:\s*number;[^}]*incomeTotal:\s*number;[^}]*currencyCode:\s*string;/,
    );
  });
});
