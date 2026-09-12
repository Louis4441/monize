import { test, expect, type Page } from '../fixtures';
import {
  createAccount,
  createInvestmentAccountPair,
  createInvestmentTransaction,
  createScheduledTransaction,
  createSecurity,
  createSecurityPrice,
  createTransaction,
} from '../helpers/factories';
import { uniqueId } from '../helpers/api';

/**
 * The calendar view on the Transactions and Investments pages.
 *
 * What only this suite can see: the toggle is a browser-local preference, the
 * layers fetch their own endpoints, and the figures printed in a cell come from
 * three read models the component suite mocks. A day note is the one write, and
 * it is proved by reloading rather than by watching the optimistic render.
 *
 * Dates are computed from today rather than fixed, because the calendar opens on
 * the current month and a fixed date would drift out of it. The weekday is never
 * assumed: a day is blank in the Daily change layer because nothing held closed
 * on it, which is what makes a weekend blank and is testable without waiting for
 * one.
 */

/** Today as the browser sees it, which is the month the calendar opens on. */
function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Step a calendar date by whole days, through UTC noon so no zone can shift it. */
function shiftDays(ymd: string, days: number): string {
  const at = new Date(`${ymd}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** A day cell's accessible name is the date in the user's own format. */
function dayLabel(ymd: string): string {
  return `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;
}

function dayCell(page: Page, ymd: string) {
  return page.getByRole('gridcell', { name: dayLabel(ymd) });
}

/** Open a day's panel without activating a chip inside the cell. */
async function openDay(page: Page, ymd: string) {
  await dayCell(page, ymd).click({ position: { x: 4, y: 4 } });
  const panel = page.getByRole('complementary', { name: dayLabel(ymd) });
  await expect(panel).toBeVisible();
  return panel;
}

async function switchToCalendar(page: Page) {
  // The toggle is client-rendered, so a click that lands before its handler
  // hydrates is a no-op and the page simply stays on the table. Retry until the
  // grid is up rather than clicking once into the void; the control sets the
  // view rather than flipping it, so a second click costs nothing.
  const toggle = page.getByRole('button', { name: 'Calendar', exact: true });
  await expect(async () => {
    await toggle.click();
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30000 });
}

test.describe('Transactions calendar', () => {
  test('draws the month, its balances and a projected day, and survives a reload', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api, { name: `Cal Account ${uniqueId()}` });
    const today = todayYmd();
    const payday = shiftDays(today, -5);
    const spendDay = shiftDays(today, -3);
    const billDay = shiftDays(today, 3);
    const payee = `Cal Payee ${uniqueId()}`;
    const schedule = `Cal Rent ${uniqueId()}`;

    await createTransaction(api, {
      accountId: account.id,
      amount: 500,
      payeeName: `Cal Payroll ${uniqueId()}`,
      transactionDate: payday,
    });
    await createTransaction(api, {
      accountId: account.id,
      amount: -42.5,
      payeeName: payee,
      transactionDate: spendDay,
    });
    await createScheduledTransaction(api, {
      accountId: account.id,
      name: schedule,
      amount: -100,
      nextDueDate: billDay,
    });

    await page.goto('/transactions');
    await switchToCalendar(page);

    // A row lands on the day it is dated, with its payee and its own amount.
    await expect(dayCell(page, spendDay)).toContainText(payee);
    await expect(dayCell(page, spendDay)).toContainText('-$42.50');
    // An occurrence lands on its due date and links to where it is edited.
    await expect(dayCell(page, billDay)).toContainText(schedule);
    await expect(
      dayCell(page, billDay).getByRole('link', { name: new RegExp(schedule) }),
    ).toHaveAttribute('href', /\/bills\?highlight=/);

    await page.getByRole('button', { name: 'Balances', exact: true }).click();

    // Actual through today: 500.00 in, 42.50 out.
    await expect(dayCell(page, spendDay).getByTestId('calendar-balance-actual')).toHaveText(
      '$457.50',
    );
    // ...and projected after it, from the same balance and the bill due that day.
    const projected = dayCell(page, billDay).getByTestId('calendar-balance-projected');
    await expect(projected).toContainText('$357.50');
    await expect(projected.getByLabel('Projected')).toBeVisible();

    const panel = await openDay(page, billDay);
    await expect(panel.getByRole('region', { name: 'Projected balance' })).toContainText(
      '$357.50',
    );

    // The view is a browser-local preference, so the calendar is still the
    // calendar after a reload -- and so are its figures.
    await page.reload();
    await expect(page.getByRole('grid')).toBeVisible();
    await expect(dayCell(page, spendDay).getByTestId('calendar-balance-actual')).toHaveText(
      '$457.50',
    );

    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.locator('tr', { hasText: payee })).toBeVisible();
  });

  test('opens a row from its day and keeps the edit after a reload', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api, { name: `Cal Edit ${uniqueId()}` });
    const day = shiftDays(todayYmd(), -2);
    const payee = `Cal Edit Me ${uniqueId()}`;
    await createTransaction(api, {
      accountId: account.id,
      amount: -73.19,
      payeeName: payee,
      transactionDate: day,
    });

    await page.goto('/transactions');
    await switchToCalendar(page);

    const dialog = page.getByRole('dialog');
    // The chip is the register row: clicking it opens the page's own edit
    // modal rather than a calendar-shaped copy of it. The grid is
    // client-rendered, so a click that lands before the handler hydrates is a
    // no-op; retry until the modal is up rather than clicking into the void.
    await expect(async () => {
      await dayCell(page, day).getByRole('button', { name: new RegExp(payee) }).click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30000 });

    await dialog.getByLabel(/amount/i).first().fill('88.88');
    await dialog.getByRole('button', { name: /update transaction/i }).click();

    // The form's amount box is a magnitude beside its own direction control,
    // so an edit that types 88.88 stores an inflow. What this is about is that
    // the chip is the row: the cell follows the edit, and still does after a
    // reload.
    await expect(dayCell(page, day)).toContainText('$88.88');
    await expect(dayCell(page, day)).not.toContainText('73.19');
    await page.reload();
    await expect(dayCell(page, day)).toContainText('$88.88');
  });

  test('creates a transaction dated the day it was opened from', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api, { name: `Cal Create ${uniqueId()}` });
    const day = shiftDays(todayYmd(), -4);

    await page.goto('/transactions');
    await switchToCalendar(page);

    const panel = await openDay(page, day);
    await panel.getByRole('button', { name: 'New transaction on this day' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^account$/i).selectOption({ value: account.id });
    await dialog.getByLabel(/amount/i).first().fill('12.34');
    await dialog.getByRole('button', { name: /create transaction/i }).click();

    // The day the panel was opened for is the date the form starts on, so the
    // new row lands in the cell the user was looking at.
    await expect(dayCell(page, day)).toContainText('$12.34');
    await page.reload();
    await expect(dayCell(page, day)).toContainText('$12.34');
  });
});

test.describe('Investments calendar', () => {
  test('values the portfolio, prices the day that moved and leaves the rest blank', async ({
    authedPage: page,
    api,
  }) => {
    const today = todayYmd();
    const buyDay = shiftDays(today, -4);
    const firstClose = shiftDays(today, -3);
    const moveDay = shiftDays(today, -2);
    const quietDay = shiftDays(today, -1);

    const pair = await createInvestmentAccountPair(api, {
      name: `Cal Brokerage ${uniqueId()}`,
      openingBalance: 10000,
    });
    const symbol = `CX${uniqueId().slice(-4).toUpperCase()}`;
    const security = await createSecurity(api, { symbol, name: `Cal Security ${uniqueId()}` });
    await createInvestmentTransaction(api, {
      accountId: pair.brokerageAccount.id,
      securityId: security.id,
      action: 'BUY',
      quantity: 10,
      price: 50,
      fundingAccountId: pair.cashAccount.id,
      transactionDate: buyDay,
    });
    await createSecurityPrice(api, security.id, { priceDate: firstClose, closePrice: 50 });
    await createSecurityPrice(api, security.id, { priceDate: moveDay, closePrice: 55 });

    await page.goto('/investments');
    await switchToCalendar(page);

    // The trade is one chip, on the day it was dated.
    await expect(dayCell(page, buyDay)).toContainText(symbol);

    await page.getByRole('button', { name: 'Values', exact: true }).click();
    await page.getByRole('button', { name: 'Daily change', exact: true }).click();

    // 10 shares from 50 to 55 against a 10,000 portfolio: +50 on 10,050.
    await expect(dayCell(page, moveDay).getByTestId('calendar-value-figure')).toHaveText(
      '$10,050.00',
    );
    await expect(dayCell(page, moveDay).getByTestId('calendar-change-figure')).toHaveText(
      '0.50%',
    );

    // Nothing held closed on the quiet day, so the carried value is shown and
    // the change is BLANK -- not zero, which would read as a flat session.
    await expect(dayCell(page, quietDay).getByTestId('calendar-value-figure')).toHaveText(
      '$10,050.00',
    );
    await expect(dayCell(page, quietDay).getByTestId('calendar-change-figure')).toHaveCount(0);

    await dayCell(page, moveDay).getByTestId('calendar-change-figure').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('movement-headline')).toContainText('$50.00');
    await expect(dialog).toContainText(symbol);
  });
});

test.describe('Calendar day notes', () => {
  test('writes, shows on both calendars, edits and deletes a note', async ({
    authedPage: page,
    api,
  }) => {
    await createAccount(api, { name: `Cal Notes ${uniqueId()}` });
    await createInvestmentAccountPair(api, {
      name: `Cal Notes Brokerage ${uniqueId()}`,
      openingBalance: 1000,
    });
    const day = shiftDays(todayYmd(), -2);
    const body = `Quarterly review ${uniqueId()}`;

    await page.goto('/transactions');
    await switchToCalendar(page);

    let panel = await openDay(page, day);
    await panel.getByRole('button', { name: 'Add a note' }).click();
    await panel.getByRole('textbox', { name: 'Note' }).fill(body);
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Note' })).toContainText(body);

    // Stored, not merely rendered.
    await page.reload();
    await expect(dayCell(page, day).getByTestId('calendar-day-note-marker')).toContainText(body);

    // A note belongs to the day, not to a page: the Investments calendar shows
    // the same one for the same date.
    await page.goto('/investments');
    await switchToCalendar(page);
    await expect(dayCell(page, day).getByTestId('calendar-day-note-marker')).toContainText(body);
    panel = await openDay(page, day);
    await expect(panel.getByRole('region', { name: 'Note' })).toContainText(body);

    const edited = `${body} (moved)`;
    await panel.getByRole('button', { name: 'Edit', exact: true }).click();
    await panel.getByRole('textbox', { name: 'Note' }).fill(edited);
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Note' })).toContainText(edited);

    await page.reload();
    await expect(dayCell(page, day).getByTestId('calendar-day-note-marker')).toContainText(
      edited,
    );

    panel = await openDay(page, day);
    await panel.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: /delete/i }).click();
    await expect(panel.getByRole('button', { name: 'Add a note' })).toBeVisible();

    await page.reload();
    await expect(dayCell(page, day).getByTestId('calendar-day-note-marker')).toHaveCount(0);
  });
});
