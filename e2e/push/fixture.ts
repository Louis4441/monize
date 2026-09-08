import { test as base, expect, type Worker } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../../frontend/public/sw.js'), 'utf8');
export type RequestRecord = { path: string; method: string; cookie: string; csrf: string };
type PushHarness = {
  origin: string;
  requests: RequestRecord[];
  stopStatuses: number[];
  refreshStatus: number;
  worker: Worker;
  push: (payload: unknown) => Promise<void>;
  click: (action?: string) => Promise<void>;
};

export const test = base.extend<{ pushHarness: PushHarness }>({
  pushHarness: async ({ page, context }, use) => {
    const requests: RequestRecord[] = [];
    const state = { stopStatuses: [201], refreshStatus: 200, csrfToken: 'browser-csrf' };
    const server = createServer((req, res) => {
      const path = req.url ?? '/';
      if (path.startsWith('/api/')) {
        requests.push({
          path,
          method: req.method ?? '',
          cookie: req.headers.cookie ?? '',
          csrf: String(req.headers['x-csrf-token'] ?? ''),
        });
        res.setHeader('Content-Type', 'application/json');
        if (path === '/api/v1/auth/csrf-refresh') {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Set-Cookie', `csrf_token=${state.csrfToken}; Path=/; SameSite=Lax`);
          res.end(JSON.stringify({ csrfToken: state.csrfToken }));
        } else {
          res.statusCode =
            path === '/api/v1/auth/refresh'
              ? state.refreshStatus
              : req.headers['x-csrf-token'] === state.csrfToken
                ? (state.stopStatuses.shift() ?? 201)
                : 403;
          if (path === '/api/v1/auth/refresh' && res.statusCode === 200) {
            state.csrfToken = 'browser-csrf-refreshed';
            res.setHeader('Set-Cookie', `csrf_token=${state.csrfToken}; Path=/; SameSite=Lax`);
          }
          res.end(JSON.stringify({ stopped: true }));
        }
      } else if (path === '/sw.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end(source);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><title>Push browser fixture</title><main><button id="activate">Activate test window</button></main>',
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server port');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await context.grantPermissions(['notifications'], { origin });
      await context.addCookies([
        { name: 'csrf_token', value: 'browser-csrf', url: origin },
        { name: 'session', value: 'browser-session', url: origin, httpOnly: true },
      ]);
      await page.goto(origin + '/initial');
      const cdp = await context.newCDPSession(page);
      let registrationId = '';
      cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
        for (const registration of registrations) {
          if (registration.scopeURL === origin + '/' && !registration.isDeleted)
            registrationId = registration.registrationId;
        }
      });
      await cdp.send('ServiceWorker.enable');
      const readyWorker = context.waitForEvent('serviceworker');
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
      });
      const worker = await readyWorker;
      await expect.poll(() => registrationId).not.toBe('');
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await use({
        origin,
        requests,
        worker,
        get stopStatuses() {
          return state.stopStatuses;
        },
        set stopStatuses(value) {
          state.stopStatuses = value;
        },
        get refreshStatus() {
          return state.refreshStatus;
        },
        set refreshStatus(value) {
          state.refreshStatus = value;
        },
        push: async (payload) => {
          await cdp.send('ServiceWorker.deliverPushMessage', {
            origin,
            registrationId,
            data: JSON.stringify(payload),
          });
        },
        // Chromium does not expose OS notification buttons through Playwright.
        // Dispatch the click inside the real worker using a real stored Notification.
        click: async (action = '') => {
          await page.locator('#activate').click();
          await worker.evaluate(async (action) => {
            const scope = self as unknown as ServiceWorkerGlobalScope;
            const notifications = await scope.registration.getNotifications();
            if (notifications.length !== 1)
              throw new Error(`Expected one notification, got ${notifications.length}`);
            const event = new NotificationEvent('notificationclick', {
              notification: notifications[0],
              action,
            });
            // Synthetic events cannot extend browser lifetime (isTrusted=false).
            // Collect this event's work explicitly; do not replace fetch, cookies,
            // notification storage or window-client APIs.
            const pending: Promise<unknown>[] = [];
            Object.defineProperty(event, 'waitUntil', {
              value: (promise: Promise<unknown>) => pending.push(promise),
            });
            scope.dispatchEvent(event);
            await Promise.all(pending);
          }, action);
        },
      });
      await cdp.detach();
    } finally {
      await context.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
});
export { expect };

export async function shown(worker: Worker) {
  return worker.evaluate(async () => {
    const scope = self as unknown as ServiceWorkerGlobalScope;
    return (await scope.registration.getNotifications()).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      data: n.data,
    }));
  });
}
