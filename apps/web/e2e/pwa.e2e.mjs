// The installed app on an Android phone (Pixel 7 emulation) against the demo server:
// manifest and icons, service worker, installability as Chrome judges it, the
// Install button, the offline page, and approving a waiting run from the phone.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, devices } from 'playwright';

const BASE = process.env.DEMO_URL ?? 'http://127.0.0.1:4173';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
const consoleErrors = [];

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['Pixel 7'] });
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() !== 'error' || /Failed to load resource: .* status of 4\d\d/.test(message.text())) return;
  // Going offline on purpose makes the browser log the failed requests.
  if (/ERR_INTERNET_DISCONNECTED|net::ERR_FAILED/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(error.message));
const step = (label) => console.log(`- ${label}`);
const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}${name}.png` });
};
process.on('uncaughtException', async (error) => {
  console.error(error);
  await page.screenshot({ path: `${SHOTS}failure.png` }).catch(() => undefined);
  process.exit(1);
});

step('sign up on the phone');
await page.goto(`${BASE}/signup`);
await page.getByLabel('Your name').fill('Hinata');
await page.getByLabel('Email').fill(`phone+${Date.now()}@example.com`);
await page.getByLabel('Password').fill('correct horse battery');
await page.getByLabel('Workspace name').fill('Studio Hinata');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'No applications yet' }).waitFor();

step('the manifest and icons describe an installable app');
const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
const manifest = await page.evaluate(async (href) => (await fetch(href)).json(), manifestHref);
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/workflows');
assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable' && icon.sizes === '512x512'));
for (const icon of manifest.icons) {
  const status = await page.evaluate(async (src) => (await fetch(src)).status, icon.src);
  assert.equal(status, 200, icon.src);
}

step('the service worker takes control');
const active = await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active));
assert.ok(active);

step('Chrome finds nothing that stops installation');
const cdp = await context.newCDPSession(page);
const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
assert.deepEqual(installabilityErrors, [], JSON.stringify(installabilityErrors));
const { errors: manifestErrors } = await cdp.send('Page.getAppManifest');
assert.deepEqual(manifestErrors, []);

step('the Install button opens the browser install dialog');
await page.evaluate(() => {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(event, { prompt: async () => void (window.__installPrompted = true) });
  window.dispatchEvent(event);
});
await page.getByRole('button', { name: 'Install app' }).waitFor();
await shot('39-phone-install-button');
await page.getByRole('button', { name: 'Install app' }).click();
assert.equal(await page.evaluate(() => window.__installPrompted), true);
assert.equal(await page.getByRole('button', { name: 'Install app' }).count(), 0, 'the button goes once used');

step('a workflow waits for approval');
const executionId = await page.evaluate(async () => {
  const { csrfToken } = await (await fetch('/v1/auth/session')).json();
  const post = async (path, body) => (await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) })).json();
  const workflow = await post('/v1/workflows', {
    name: 'Post the weekly video',
    graph: {
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'manual', name: 'Start', position: { x: 0, y: 0, z: 0 } },
        { id: 'approval', kind: 'approval', name: 'Check the video', message: 'Publish "{{trigger.title}}" to every channel?', position: { x: 3.5, y: 0, z: 0 } },
        { id: 'done', kind: 'transform', name: 'Mark as published', output: { status: 'published' }, position: { x: 7, y: 0, z: 0 } },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'approval' },
        { id: 'e2', from: 'approval', port: 'approved', to: 'done' },
      ],
    },
  });
  const run = await post(`/v1/workflows/${workflow.id}/run`, { version: 1, payload: { title: 'Kopi susu gula aren' } });
  return run.executionId;
});
await page.waitForFunction(async (id) => (await (await fetch(`/v1/executions/${id}`)).json()).execution.status === 'waiting', executionId, { timeout: 15_000 });

step('approve it from the phone');
await page.getByRole('link', { name: 'Workflows' }).click();
await page.getByRole('link', { name: 'Post the weekly video' }).waitFor();
await shot('40-phone-workflows');
await page.getByRole('link', { name: 'Post the weekly video' }).click();
await page.locator('.board').first().waitFor();
await page.getByRole('button', { name: 'Details' }).click();
await page.getByRole('tab', { name: /Runs/ }).click();
await page.locator('.run-list button').first().click();
await page.locator('.approval-callout').getByRole('button', { name: 'Review' }).click();
await page.locator('.approval-message', { hasText: 'Publish "Kopi susu gula aren" to every channel?' }).waitFor();
await shot('41-phone-approval');
await page.getByRole('button', { name: 'Approve', exact: true }).click();
await page.locator('.approval-box').waitFor({ state: 'detached', timeout: 15_000 });
await page.getByRole('button', { name: 'Close details' }).click();
await page.locator('.board[data-node-id="done"] .board-status', { hasText: 'Done' }).waitFor({ timeout: 15_000 });
await shot('42-phone-approved');

step('without a connection the app shows its offline page');
await context.setOffline(true);
await page.goto(`${BASE}/workflows`).catch(() => undefined);
await page.getByRole('heading', { name: 'No connection' }).waitFor();
const offlineBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
assert.equal(offlineBackground, 'rgb(28, 33, 39)', 'the offline page keeps its styles without a network');
await shot('43-phone-offline');
await context.setOffline(false);
await page.getByRole('link', { name: 'Try again' }).click();
await page.getByRole('heading', { name: 'Workflows' }).waitFor();

assert.deepEqual(consoleErrors, [], 'no console errors');
await browser.close();
console.log('pwa e2e passed');
