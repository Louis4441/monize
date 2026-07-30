import { test, expect } from '../fixtures';
import {
  createSecurity,
  createInvestmentAccountPair,
  createInvestmentTransaction,
} from '../helpers/factories';
import { uniqueId, type ApiClient } from '../helpers/api';

// The security detail page (/securities/[id]): the page that replaced the three
// dialogs the securities list used to open. Preconditions are seeded via the
// API; everything asserted here goes through the UI, because the point of these
// tests is the wiring between them -- a component test mocks the endpoint and so
// cannot catch a page that renders the wrong field, or a route that never opens.
test.describe('Security detail', () => {
  /** A security held in a brokerage account, with a price and one buy. */
  async function seedHeldSecurity(
    api: ApiClient,
    options: { price?: number; quantity?: number } = {},
  ) {
    const security = await createSecurity(api, {
      name: `Detail ${uniqueId()}`,
      securityType: 'ETF',
      exchange: 'XETRA',
    });
    const { cashAccount, brokerageAccount } =
      await createInvestmentAccountPair(api);
    await createInvestmentTransaction(api, {
      accountId: brokerageAccount.id,
      securityId: security.id,
      fundingAccountId: cashAccount.id,
      quantity: options.quantity ?? 10,
      price: options.price ?? 100,
    });
    await api.post(`/securities/${security.id}/prices`, {
      priceDate: new Date().toISOString().slice(0, 10),
      closePrice: 130,
    });
    return { security, brokerageAccount };
  }

  test('opens from the securities list by clicking the row', async ({
    authedPage: page,
    api,
  }) => {
    const security = await createSecurity(api, { name: `Row Click ${uniqueId()}` });

    await page.goto('/securities');
    // The row itself is the control -- the per-row Details button was removed,
    // and a row that only responds on one cell reads as not responding at all.
    await page.locator('tr', { hasText: security.symbol }).click();

    await expect(page).toHaveURL(new RegExp(`/securities/${security.id}$`));
    await expect(
      page.getByRole('heading', { name: new RegExp(security.name) }),
    ).toBeVisible();
  });

  test('shows the position, its cost basis and its unrealized gain', async ({
    authedPage: page,
    api,
  }) => {
    const { security } = await seedHeldSecurity(api);

    await page.goto(`/securities/${security.id}`);

    // 10 units bought at 100, last close 130: 1,300 value on 1,000 of cost.
    await expect(page.getByText('$1,300.00').first()).toBeVisible();
    await expect(page.getByText('$1,000.00').first()).toBeVisible();
    await expect(page.getByText('+$300.00').first()).toBeVisible();
    await expect(page.getByText('+30.00%').first()).toBeVisible();
  });

  test('dates the price in the header, not on the market value card', async ({
    authedPage: page,
    api,
  }) => {
    const { security } = await seedHeldSecurity(api);

    await page.goto(`/securities/${security.id}`);

    // The valuation still has to be dated, or a stale one reads as today's
    // worth -- but the header is the one place that says so. The card used to
    // carry "At the close of {date}", which intraday is a claim the price
    // cannot support: the newest row is that day's latest quote, not its
    // close. Asserting the old wording is gone keeps it from coming back.
    await expect(page.getByText(/Price at/).first()).toBeVisible();
    await expect(page.getByText(/At the close of/)).toHaveCount(0);
  });

  test('separates the security s return from the position s', async ({
    authedPage: page,
    api,
  }) => {
    const { security } = await seedHeldSecurity(api);

    await page.goto(`/securities/${security.id}`);

    // Two different questions, and readers conflate them, so both are named.
    await expect(
      page.getByRole('heading', { name: 'Security performance' }),
    ).toBeVisible();
    // Exact: the performance card's own text points the reader at "Total
    // return", so a loose match finds that sentence as well as the row label.
    await expect(
      page.getByText('Total return', { exact: true }),
    ).toBeVisible();
  });

  test('keeps a sub-cent price intact end to end', async ({
    authedPage: page,
    api,
  }) => {
    // The whole point of migration 116: at six decimal places this position's
    // average cost came back as 0.00012346 and its cost basis was a percent out.
    const { security } = await seedHeldSecurity(api, {
      price: 0.0001234568,
      quantity: 15000,
    });

    await page.goto(`/securities/${security.id}`);

    // The card shows three significant figures for a sub-penny value, which is
    // what `adaptiveFractionDigits` does everywhere in the app -- so the check
    // here is that the price survived the round trip as a small non-zero number
    // rather than collapsing to $0.00, which is how it failed before the column
    // was widened. The stored precision itself is guarded in the backend by
    // `entity-decimal-precision.spec.ts`.
    await expect(page.getByText('$0.000123').first()).toBeVisible();
    // 15,000 units at that price: a cost basis of 1.85, not 1.84 or 1.86.
    await expect(page.getByText('$1.85').first()).toBeVisible();
  });

  test('offers the three chart series and the tabs beneath', async ({
    authedPage: page,
    api,
  }) => {
    const { security } = await seedHeldSecurity(api);

    await page.goto(`/securities/${security.id}`);

    for (const name of ['Price', 'Investment value', 'Return']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    for (const name of ['Overview', 'Transactions', 'Price history']) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
  });

  test('deep-links straight to the price history tab', async ({
    authedPage: page,
    api,
  }) => {
    const { security } = await seedHeldSecurity(api);

    // The dashboard's price widgets point here; the link outlived the modal it
    // used to open.
    await page.goto(`/securities/${security.id}?tab=prices`);

    await expect(page.getByRole('tab', { name: 'Price history' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('lists the account holding the security', async ({
    authedPage: page,
    api,
  }) => {
    const { security, brokerageAccount } = await seedHeldSecurity(api);

    await page.goto(`/securities/${security.id}`);

    await expect(
      page.getByText(brokerageAccount.name, { exact: false }).first(),
    ).toBeVisible();
  });

  test('says so plainly for a security that was never traded', async ({
    authedPage: page,
    api,
  }) => {
    const security = await createSecurity(api, { name: `Untraded ${uniqueId()}` });

    await page.goto(`/securities/${security.id}`);

    // Zero-filled cards would claim a position that is not there.
    await expect(page.getByText('Never held')).toBeVisible();
    await expect(page.getByText('$0.00')).toHaveCount(0);
  });

  test('switches to another security from the caret beside the name', async ({
    authedPage: page,
    api,
  }) => {
    const first = await createSecurity(api, { name: `First ${uniqueId()}` });
    const second = await createSecurity(api, { name: `Second ${uniqueId()}` });

    await page.goto(`/securities/${first.id}`);
    await page
      .getByRole('button', { name: 'Switch to another security' })
      .click();
    await page.getByRole('menuitem', { name: new RegExp(second.symbol) }).click();

    await expect(page).toHaveURL(new RegExp(`/securities/${second.id}$`));
  });
});
