// Browser end-to-end test against the demo server (apps/backend/test/support/demo-server.ts).
// Walks the whole stage-3 flow, saves screenshots and fails on any console error.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.DEMO_URL ?? 'http://127.0.0.1:4173';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
const email = `hinata+${Date.now()}@example.com`;
const consoleErrors = [];

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const watch = (target) => {
  // Expected API refusals (the weak password, for instance) show up as network 4xx lines; anything else is a real error.
  target.on('console', (message) => {
    if (message.type() !== 'error' || /Failed to load resource: .* status of 4\d\d/.test(message.text())) return;
    consoleErrors.push(`${target.url()}: ${message.text()}`);
  });
  target.on('pageerror', (error) => consoleErrors.push(`${target.url()}: ${error.message}`));
};
watch(page);

// The fake OAuth provider: its sign-in page sends the browser straight back with a code.
await context.route('https://auth.example.com/authorize**', async (route) => {
  const url = new URL(route.request().url());
  const back = new URL(url.searchParams.get('redirect_uri'));
  back.searchParams.set('state', url.searchParams.get('state'));
  back.searchParams.set('code', 'demo-code');
  await route.fulfill({ status: 302, headers: { location: back.toString() } });
});

const shot = async (name, target = page) => {
  await target.waitForTimeout(150);
  await target.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });
};
const step = (label) => console.log(`- ${label}`);

step('signed-out visitors land on sign-in');
await page.goto(`${BASE}/integrations`);
await page.getByRole('heading', { name: 'Sign in' }).waitFor();
assert.match(page.url(), /\/login\?next=%2Fintegrations/);
await shot('01-sign-in');

step('create an account');
await page.getByRole('link', { name: /Create (an|the first) account/ }).first().click();
await page.getByLabel('Your name').fill('Hinata');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill('short');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByText('Password must be at least 10 characters').waitFor();
await page.getByLabel('Password').fill('correct horse battery');
await page.getByLabel('Workspace name').fill('Studio Hinata');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'No applications yet' }).waitFor();
await shot('02-applications-empty');

step('browse the marketplace and install Claude with consent');
await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Marketplace' }).click();
await page.getByRole('heading', { name: 'Featured' }).waitFor();
await page.getByRole('heading', { name: 'Popular' }).waitFor();
await shot('03-marketplace');
const claudeTile = page.locator('#shelf-popular').locator('..').locator('..').locator('article', { hasText: 'Claude' });
await claudeTile.getByRole('button', { name: 'Install Claude' }).click();
await page.getByRole('dialog').getByText('runs entirely inside Universal Flow').waitFor();
await page.getByRole('dialog').getByRole('button', { name: 'Install' }).click();
await page.getByRole('heading', { name: 'Claude', level: 1 }).waitFor();
await page.getByText('No account needed').waitFor();
await shot('04-claude-detail');

step('search the marketplace and open a community module');
await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Marketplace' }).click();
await page.getByLabel('Search the marketplace').fill('article');
await page.getByText('1 module').waitFor();
await page.getByRole('link', { name: 'Article Summarizer' }).click();
await page.getByRole('heading', { name: 'Access it needs' }).waitFor();
await page.getByText('Send requests to summarize.example.com').waitFor();
await shot('05-plugin-page');

step('add MY CUSTOM AI with the Custom API builder');
await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Applications' }).click();
await page.getByRole('main').getByRole('link', { name: 'Add custom API' }).click();
await page.getByRole('heading', { name: 'Add a custom API' }).waitFor();
await page.getByRole('button', { name: 'Create integration' }).click();
await page.getByText(/to continue:/).waitFor();
await page.getByLabel('Name', { exact: true }).fill('MY CUSTOM AI');
assert.match(await page.getByLabel('Plugin ID').inputValue(), /^custom\.[a-z0-9]{8}\.my-custom-ai$/);
await page.getByLabel('Provider').fill('Example Inc.');
await page.getByLabel('Category').selectOption({ label: 'AI & Large Language Models' });
await page.getByLabel('What it does').fill('Generate text');
await page.getByLabel('Base URL').fill('https://api.example.com/v1');
await page.getByLabel('Endpoint').fill('/generate');
await page.getByRole('button', { name: 'Add input' }).click();
await page.getByLabel('input 1 name').fill('prompt');
await page.getByLabel('input 1 label').fill('Prompt');
await page.getByRole('checkbox', { name: 'Required' }).check();
await page.getByRole('button', { name: 'Fill the body from the inputs' }).click();
await page.getByRole('button', { name: 'Add output' }).click();
await page.getByLabel('output 1 name').fill('text');
await page.getByRole('button', { name: 'Add output' }).click();
await page.getByLabel('output 2 name').fill('tokens');
await page.getByLabel('output 2 type').selectOption('integer');
await page.getByRole('button', { name: 'Add mapping' }).click();
await page.getByLabel('Output 1', { exact: true }).fill('text');
await page.getByLabel('JSON path 1').fill('$.choices[0].text');
await page.getByRole('button', { name: 'Add mapping' }).click();
await page.getByLabel('Output 2', { exact: true }).fill('tokens');
await page.getByLabel('JSON path 2').fill('$.usage.total');
await page.getByLabel('Limitations (optional)').fill('60 requests per minute');
const preview = page.getByRole('figure', { name: 'MY CUSTOM AI module' });
await preview.getByText('Prompt').waitFor();
await preview.getByText('tokens').waitFor();
await shot('06-custom-api-builder');
await page.getByRole('button', { name: 'Create integration' }).click();

step('connect the API key, then pass Test API to activate');
await page.getByRole('heading', { name: 'MY CUSTOM AI', level: 1 }).waitFor();
await page.getByText('Run a test to activate').first().waitFor();
await page.getByLabel('Access token').fill('sk-demo-123');
await page.getByRole('button', { name: 'Connect account' }).click();
await page.getByText('Connected', { exact: true }).waitFor();
await page.getByRole('tab', { name: 'Test' }).click();
await page.getByLabel('Prompt').fill('coffee shop reels');
await page.getByRole('button', { name: 'Run test' }).click();
await page.getByRole('heading', { name: 'The test passed' }).waitFor();
await page.getByText('passed its test and is now active').waitFor();
await page.locator('.page-head .lamp', { hasText: 'Ready' }).waitFor();
assert.ok(!(await page.content()).includes('sk-demo-123'), 'the secret never comes back to the browser');
await shot('07-test-passed');

step('install Google Drive and connect it with OAuth');
await page.goto(`${BASE}/marketplace/io.universalflow.gdrive`);
await page.getByRole('button', { name: 'Install' }).click();
await page.getByRole('dialog').getByText('Send requests to drive.example.com').waitFor();
await shot('08-install-consent');
await page.getByRole('dialog').getByRole('button', { name: 'Allow and install' }).click();
await page.getByRole('heading', { name: 'Google Drive', level: 1 }).waitFor();
await page.getByLabel('Client ID').fill('demo-client');
await page.getByLabel('Client secret').fill('demo-secret');
const popupPromise = context.waitForEvent('page');
await page.getByRole('button', { name: 'Continue to sign in' }).click();
const popup = await popupPromise;
watch(popup);
await popup.getByRole('heading', { name: 'Account connected' }).waitFor();
await shot('09-oauth-callback', popup);
await popup.close();
await page.getByText('Google Drive is connected').waitFor();
await page.locator('.page-head .lamp', { hasText: 'Ready' }).waitFor();

step('the applications list shows every module with its status');
await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Applications' }).click();
await page.getByRole('list', { name: 'Installed applications' }).waitFor();
assert.equal(await page.locator('.rack-row').count(), 3);
await shot('10-applications');
await page.getByLabel('Search applications').fill('drive');
assert.equal(await page.locator('.rack-row').count(), 1);
await page.getByLabel('Search applications').fill('');

step('disable and re-enable, then uninstall with confirmation');
await page.getByRole('link', { name: 'Claude' }).click();
await page.getByRole('button', { name: 'Disable' }).click();
await page.locator('.page-head .lamp', { hasText: 'Disabled' }).waitFor();
await page.getByRole('button', { name: 'Enable' }).click();
await page.getByRole('button', { name: 'Uninstall' }).click();
await page.getByRole('dialog').getByRole('button', { name: 'Uninstall' }).click();
await page.getByRole('list', { name: 'Installed applications' }).waitFor();
assert.equal(await page.locator('.rack-row').count(), 2);

step('narrow screens and dark mode');
await page.setViewportSize({ width: 390, height: 844 });
await shot('11-applications-mobile');
await page.emulateMedia({ colorScheme: 'dark' });
await page.setViewportSize({ width: 1360, height: 900 });
await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Marketplace' }).click();
await page.getByRole('heading', { name: 'Featured' }).waitFor();
await shot('12-marketplace-dark');
await page.emulateMedia({ colorScheme: 'light' });

step('sign out ends the session');
await page.getByRole('button', { name: 'Sign out' }).click();
await page.getByRole('heading', { name: 'Sign in' }).waitFor();
await page.goto(`${BASE}/integrations`);
await page.getByRole('heading', { name: 'Sign in' }).waitFor();

await browser.close();
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join('\n')}`);
console.log(`All steps passed. Screenshots in ${SHOTS}`);
