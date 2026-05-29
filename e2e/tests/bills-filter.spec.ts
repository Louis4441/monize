import { test, expect } from '../fixtures';
import {
  createAccount,
  createCategory,
  createPayee,
  createScheduledTransaction,
  cleanupTestData,
} from '../helpers/factories';

/**
 * E2E tests for filtering the Bills & Deposits list by Name, Payee,
 * Account, and Category.
 *
 * Seeds two distinct scheduled transactions (each with its own account,
 * category, and payee) via the API factories, then drives the
 * BillsFilterPanel UI and asserts the list narrows to the expected rows.
 */
test.describe('Bills & Deposits filtering', () => {
  const suffix = Date.now();

  // Alpha and Bravo are fully disjoint so each filter dimension can be
  // verified independently.
  const alphaName = `Alpha Rent ${suffix}`;
  const bravoName = `Bravo Net ${suffix}`;
  const acctAName = `Filter Acct A ${suffix}`;
  const acctBName = `Filter Acct B ${suffix}`;
  const catAName = `Filter Cat A ${suffix}`;
  const catBName = `Filter Cat B ${suffix}`;
  const payeeAName = `Filter Payee A ${suffix}`;
  const payeeBName = `Filter Payee B ${suffix}`;

  test.beforeAll(async () => {
    const acctA = await createAccount({ name: acctAName });
    const acctB = await createAccount({ name: acctBName });
    const catA = await createCategory({ name: catAName });
    const catB = await createCategory({ name: catBName });
    const payeeA = await createPayee({ name: payeeAName });
    const payeeB = await createPayee({ name: payeeBName });

    await createScheduledTransaction({
      accountId: acctA.id,
      name: alphaName,
      amount: -100,
      categoryId: catA.id,
      payeeId: payeeA.id,
      payeeName: payeeAName,
    });
    await createScheduledTransaction({
      accountId: acctB.id,
      name: bravoName,
      amount: -200,
      categoryId: catB.id,
      payeeId: payeeB.id,
      payeeName: payeeBName,
    });
  });

  test.afterAll(async () => {
    await cleanupTestData();
  });

  // Open the (initially collapsed) filter panel.
  async function expandFilters(page: import('@playwright/test').Page) {
    await page.getByRole('button', { name: /Filters/ }).click();
  }

  // Open a MultiSelect (identified by its placeholder) and tick an option.
  async function selectOption(
    page: import('@playwright/test').Page,
    placeholder: string,
    optionName: string,
  ) {
    await page.getByRole('button', { name: placeholder }).click();
    await page.getByRole('checkbox', { name: optionName }).check();
    // The dropdown closes on outside click (not Escape); click the page
    // heading so it doesn't overlay subsequent interactions.
    await page.getByRole('heading', { name: 'Bills & Deposits', level: 1 }).click();
  }

  test('filters the list by name', async ({ authedPage: page }) => {
    await page.goto('/bills');
    await expect(page.getByText(alphaName)).toBeVisible();
    await expect(page.getByText(bravoName)).toBeVisible();

    await expandFilters(page);
    await page.getByPlaceholder('Search by name...').fill('Alpha Rent');

    await expect(page.getByText(alphaName)).toBeVisible();
    await expect(page.getByText(bravoName)).toHaveCount(0);
  });

  test('filters the list by account', async ({ authedPage: page }) => {
    await page.goto('/bills');
    await expandFilters(page);
    await selectOption(page, 'All accounts', acctBName);

    await expect(page.getByText(bravoName)).toBeVisible();
    await expect(page.getByText(alphaName)).toHaveCount(0);
  });

  test('filters the list by category', async ({ authedPage: page }) => {
    await page.goto('/bills');
    await expandFilters(page);
    await selectOption(page, 'All categories', catAName);

    await expect(page.getByText(alphaName)).toBeVisible();
    await expect(page.getByText(bravoName)).toHaveCount(0);
  });

  test('filters the list by payee', async ({ authedPage: page }) => {
    await page.goto('/bills');
    await expandFilters(page);
    await selectOption(page, 'All payees', payeeBName);

    await expect(page.getByText(bravoName)).toBeVisible();
    await expect(page.getByText(alphaName)).toHaveCount(0);
  });

  test('shows an active filter count and clears all filters', async ({ authedPage: page }) => {
    await page.goto('/bills');
    await expandFilters(page);

    await page.getByPlaceholder('Search by name...').fill('Alpha Rent');
    await selectOption(page, 'All accounts', acctAName);

    // Two active filter groups -> count badge of 2 on the Filters header,
    // and only Alpha remains.
    await expect(page.getByRole('button', { name: /Filters/ })).toContainText('2');
    await expect(page.getByText(bravoName)).toHaveCount(0);

    await page.getByText('Clear', { exact: true }).click();

    // Both rows return once filters are cleared.
    await expect(page.getByText(alphaName)).toBeVisible();
    await expect(page.getByText(bravoName)).toBeVisible();
  });
});
