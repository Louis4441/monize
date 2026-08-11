import { join } from 'path';
import { test, expect } from '../fixtures';

/**
 * The Microsoft Money (`.mny`) import, end to end through the real wizard.
 *
 * The committed jackcess-encrypt fixtures are the only real Money files that
 * can live in the repository, so they are what this drives:
 *
 * - `money2001.mny` is the smallest and uses Money's pre-2002 "old" key
 *   derivation, which takes no password at all. It opens straight to the review
 *   step, which makes it the file for the full upload -> review -> import ->
 *   verification pass.
 * - `money2008-pwd.mny` is the only fixture the password prompt can be exercised
 *   with. `money2001-pwd.mny` sounds like the obvious choice and is not: the old
 *   scheme ignores passwords, so it opens without ever prompting.
 *
 * Both files are portfolio-only -- an investment account pair, a few investment
 * transactions, no banking rows -- so the assertions are about the wizard
 * reaching each step with the right file understood, not about transaction
 * counts. The mapping itself is covered far more thoroughly by the backend
 * integration specs, which can assert balances and holdings row by row.
 */

const FIXTURES = join(
  __dirname,
  '../../backend/src/import/mny/__fixtures__',
);

/** Opens with no password: Money 2001 files derive their key from the header. */
const MONEY_2001 = join(FIXTURES, 'money2001.mny');
/** Genuinely password protected, with the password jackcess-encrypt records. */
const MONEY_2008_PWD = join(FIXTURES, 'money2008-pwd.mny');
const MONEY_2008_PASSWORD = 'Test12345';

/** Decrypt, parse and preview of a whole Money profile is not a 5 s operation. */
const PARSE_TIMEOUT = 30000;
/** The import runs as a background job the wizard polls every 1.5 s. */
const IMPORT_TIMEOUT = 60000;

test.describe('Microsoft Money (.mny) import', () => {
  test('names .mny among the formats it accepts', async ({
    authedPage: page,
  }) => {
    await page.goto('/import');

    await expect(
      page.getByText(/upload transaction files/i).first(),
    ).toBeVisible({ timeout: 10000 });
    // The accept *attribute* is asserted in import.spec.ts; this is the half a
    // user actually reads, and the two have drifted apart before.
    await expect(
      page.getByText(/Microsoft Money \(\.mny\)/i).first(),
    ).toBeVisible();
  });

  test('imports a Money 2001 file end to end', async ({
    authedPage: page,
  }) => {
    await page.goto('/import');
    await page.locator('input[type="file"]').setInputFiles(MONEY_2001);

    // Review: the file is understood before anything is written, and the
    // balances shown are the ones the verification report reconciles against.
    await expect(
      page.getByRole('heading', { name: /review your microsoft money file/i }),
    ).toBeVisible({ timeout: PARSE_TIMEOUT });
    await expect(page.getByText(/Money 2001 format/i)).toBeVisible();
    // Money 2001 predates the BILL table; the wizard says so rather than
    // failing, which is the regression that crash-looped PR #192.
    await expect(page.getByText(/has no BILL table/i)).toBeVisible();

    // One Money investment account becomes Monize's linked cash + brokerage
    // pair, and the cash side has no Money handle to untick.
    await expect(
      page.getByText('Investments to Watch - Brokerage'),
    ).toBeVisible();
    await expect(page.getByText('Investments to Watch - Cash')).toBeVisible();

    await page.getByRole('button', { name: /start import/i }).click();

    // Import runs in the background; the wizard polls the job.
    await expect(
      page.getByRole('heading', { name: /import finished/i }),
    ).toBeVisible({ timeout: IMPORT_TIMEOUT });
    await expect(page.getByText(/accounts reconcile/i)).toBeVisible();

    await page.getByRole('button', { name: /^done$/i }).click();
    await expect(
      page.getByText(/upload transaction files/i).first(),
    ).toBeVisible();

    // The accounts really landed, not just the report. The two ledgers are
    // stored with their " - Brokerage" / " - Cash" suffixes, but the accounts
    // list folds a linked pair into the one account the user thinks they
    // imported, so what is on screen is the Money account's own name.
    await page.goto('/accounts');
    await expect(
      page.getByText('Investments to Watch', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText('Investments to Watch - Brokerage', { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText('Investments to Watch - Cash', { exact: true }),
    ).toHaveCount(0);
  });

  test('asks for a password, tells a wrong one apart, then opens the file', async ({
    authedPage: page,
  }) => {
    await page.goto('/import');
    await page.locator('input[type="file"]').setInputFiles(MONEY_2008_PWD);

    // "This file needs a password" -- not an error, so no error copy yet.
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: /needs a password/i }),
    ).toBeVisible({ timeout: PARSE_TIMEOUT });
    await expect(dialog.getByText(/did not open the file/i)).toBeHidden();

    // A wrong password is a distinct outcome from a missing one: the prompt
    // stays, with wording that says the password was rejected.
    await dialog.getByLabel(/money file password/i).fill('not-the-password');
    await dialog.getByRole('button', { name: /open file/i }).click();
    await expect(dialog.getByText(/did not open the file/i)).toBeVisible({
      timeout: PARSE_TIMEOUT,
    });

    await dialog.getByLabel(/money file password/i).fill(MONEY_2008_PASSWORD);
    await dialog.getByRole('button', { name: /open file/i }).click();

    await expect(
      page.getByRole('heading', { name: /review your microsoft money file/i }),
    ).toBeVisible({ timeout: PARSE_TIMEOUT });
    await expect(page.getByText(/Money Plus \/ Sunset format/i)).toBeVisible();
  });

  test('refuses a file that is not a Money database', async ({
    authedPage: page,
  }) => {
    await page.goto('/import');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'not-really.mny',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(8192, 0x41),
    });

    // A localized message, not a stack trace or a silent nothing.
    await expect(
      page.getByText(/not a Microsoft Money \(\.mny\) file/i).first(),
    ).toBeVisible({ timeout: PARSE_TIMEOUT });
  });
});
