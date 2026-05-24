import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers/auth';

test.describe('Bills & Deposits', () => {
  test.beforeEach(async ({ page }) => {
    await registerUser(page);
  });

  test('can navigate to bills page', async ({ page }) => {
    await page.goto('/bills');

    // Should show the bills page header
    await expect(page.locator('body')).toContainText(/bills & deposits/i);
  });

  test('can create a new scheduled transaction', async ({ page }) => {
    // First create an account to use in the scheduled transaction. Account
    // Type has no default in the form, so it must be selected explicitly --
    // a name-only submit fails validation and persists nothing.
    await page.goto('/accounts');
    await page.getByRole('button', { name: /new account|add account/i }).click();
    await page.getByLabel(/account name/i).fill('E2E Bills Account');
    await page.getByLabel(/account type/i).selectOption({ label: 'Chequing' });
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page.locator('body')).toContainText('E2E Bills Account');

    // Navigate to the bills page
    await page.goto('/bills');
    await expect(page.locator('body')).toContainText(/bills & deposits/i);

    // Click the new schedule button
    const newScheduleButton = page.getByRole('button', { name: /new schedule/i });
    await expect(newScheduleButton).toBeVisible();
    await newScheduleButton.click();

    // The form modal should appear
    await expect(
      page.getByText(/new scheduled transaction/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // Fill in the scheduled transaction form
    await page.getByLabel(/^name$/i).first().fill('E2E Monthly Rent');

    // Select the account we just created (first real option after the
    // "Select account..." placeholder).
    await page.getByLabel(/^account$/i).first().selectOption({ index: 1 });

    // Fill amount (Next Due Date defaults to today, so it needs no input).
    await page.getByLabel(/amount/i).first().fill('1500');

    // Submit the form
    await page.getByRole('button', { name: /^create$/i }).first().click();

    // Verify the scheduled transaction appears in the list
    await expect(page.locator('body')).toContainText('E2E Monthly Rent');
  });

  test('shows summary cards', async ({ page }) => {
    await page.goto('/bills');

    // Should display the summary cards
    await expect(page.getByText(/active bills/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/active deposits/i).first()).toBeVisible();
    await expect(page.getByText(/monthly net/i).first()).toBeVisible();
    await expect(page.getByText(/due now/i).first()).toBeVisible();
  });

  test('can switch to calendar view', async ({ page }) => {
    await page.goto('/bills');

    // Should see the list and calendar view toggle buttons
    const calendarButton = page.getByRole('button', { name: /calendar/i });
    await expect(calendarButton).toBeVisible({ timeout: 10000 });

    // Click on the Calendar tab
    await calendarButton.click();

    // Calendar should render with day-of-week headers. Use exact matching so
    // short labels like "Mon" don't collide with "Monize" / "Monthly Net".
    await expect(page.getByText('Sun', { exact: true })).toBeVisible();
    await expect(page.getByText('Mon', { exact: true })).toBeVisible();
    await expect(page.getByText('Tue', { exact: true })).toBeVisible();
    await expect(page.getByText('Wed', { exact: true })).toBeVisible();
    await expect(page.getByText('Thu', { exact: true })).toBeVisible();
    await expect(page.getByText('Fri', { exact: true })).toBeVisible();
    await expect(page.getByText('Sat', { exact: true })).toBeVisible();

    // Calendar should show a Today button
    await expect(page.getByRole('button', { name: /today/i })).toBeVisible();
  });

  test('can switch between list and calendar views', async ({ page }) => {
    await page.goto('/bills');

    // Start in list view
    const listButton = page.getByRole('button', { name: /^list$/i });
    const calendarButton = page.getByRole('button', { name: /calendar/i });

    await expect(listButton).toBeVisible({ timeout: 10000 });
    await expect(calendarButton).toBeVisible();

    // Switch to calendar
    await calendarButton.click();
    await expect(page.getByText('Sun', { exact: true })).toBeVisible();

    // Switch back to list
    await listButton.click();

    // Filter buttons should be visible in list mode
    await expect(page.getByRole('button', { name: /all/i }).first()).toBeVisible();
  });
});
