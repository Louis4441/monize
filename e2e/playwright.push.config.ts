import { defineConfig, devices } from '@playwright/test';

// Browser/worker integration only: no database, application build or external push service.
export default defineConfig({
  testDir: './push',
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-push-report', open: 'never' }]],
  outputDir: 'test-results-push',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
