import { test, expect } from '../fixtures';
import { createAccount, createTransaction } from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Transactions run through a complex tabbed form (normal/split/transfer) with a
// custom-value payee combobox, so create/edit via that form are a deliberate
// follow-up. These cover the high-confidence paths: API-seeded list + read,
// per-row delete (row Delete -> ConfirmDialog), and create-form validation.
test.describe('Transactions', () => {
  test('lists transactions seeded via the API', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const coffee = await createTransaction(api, {
      accountId: account.id,
      payeeName: `Coffee ${uniqueId()}`,
    });
    const rent = await createTransaction(api, {
      accountId: account.id,
      payeeName: `Rent ${uniqueId()}`,
    });

    await page.goto('/transactions');

    await expect(page.locator('tr', { hasText: coffee.payeeName! })).toBeVisible();
    await expect(page.locator('tr', { hasText: rent.payeeName! })).toBeVisible();
  });

  test('deletes a transaction through the UI', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const txn = await createTransaction(api, {
      accountId: account.id,
      payeeName: `Delete Me ${uniqueId()}`,
    });

    await page.goto('/transactions');
    await page
      .locator('tr', { hasText: txn.payeeName! })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();

    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();

    await expect(page.locator('tr', { hasText: txn.payeeName! })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('tr', { hasText: txn.payeeName! })).toHaveCount(0);
  });

  test('rejects a transaction with no amount', async ({ authedPage: page, api }) => {
    // Seed an account so the form opens normally; amount is still required.
    await createAccount(api);

    await page.goto('/transactions');
    await page.getByRole('button', { name: /new transaction/i }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /create transaction/i }).click();

    await expect(dialog.getByText(/amount is required/i)).toBeVisible();
  });
});
