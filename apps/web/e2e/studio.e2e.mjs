// Browser end-to-end test of Spatial Studio against the demo server
// (apps/backend/test/support/demo-server.ts). It builds a workflow with the
// mouse and the keyboard, saves it, runs it, approves it, goes live, opens the
// specification's content pipeline and checks the phone layout. Screenshots go
// to e2e/screenshots; any console error fails the run.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.DEMO_URL ?? 'http://127.0.0.1:4173';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
const consoleErrors = [];

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() !== 'error' || /Failed to load resource: .* status of 4\d\d/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(error.message));

const step = (label) => console.log(`- ${label}`);
process.on('uncaughtException', async (error) => {
  console.error(error);
  await page.screenshot({ path: `${SHOTS}failure.png` }).catch(() => undefined);
  process.exit(1);
});
const shot = async (name, target = page) => {
  await target.waitForTimeout(250);
  await target.screenshot({ path: `${SHOTS}${name}.png` });
};
const board = (id) => page.locator(`.board[data-node-id="${id}"]`);
const jack = (node, key) => page.locator(`[data-node="${node}"][data-jack="${key}"]`);
const socketCentre = async (locator) => {
  const box = await locator.locator('.board-socket').boundingBox();
  assert.ok(box, 'jack is on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const onStage = async (point) => {
  const box = await page.locator('.stage').boundingBox();
  return point.x > box.x + 20 && point.x < box.x + box.width - 20 && point.y > box.y + 60 && point.y < box.y + box.height - 20;
};
/** Drags a patch cable with the mouse, the way a person does. */
const patch = async (from, to) => {
  // A drag that starts outside the stage would pick up something else, so frame every step first.
  await page.getByRole('button', { name: 'Show all steps' }).click();
  await page.waitForTimeout(450);
  assert.ok((await onStage(await socketCentre(from))) && (await onStage(await socketCentre(to))), 'both jacks are on the stage');
  const start = await socketCentre(from);
  const end = await socketCentre(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2 - 30, { steps: 6 });
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
};
const toast = (text) => page.locator('.toast', { hasText: text }).first().waitFor();
const inspector = page.locator('.studio-side');

step('sign up and install the apps through the API');
await page.goto(`${BASE}/signup`);
await page.getByLabel('Your name').fill('Hinata');
await page.getByLabel('Email').fill(`studio+${Date.now()}@example.com`);
await page.getByLabel('Password').fill('correct horse battery');
await page.getByLabel('Workspace name').fill('Studio Hinata');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'No applications yet' }).waitFor();
const installed = await page.evaluate(async (ids) => {
  const { csrfToken } = await (await fetch('/v1/auth/session')).json();
  const statuses = [];
  for (const id of ids) {
    const response = await fetch(`/v1/integrations/${id}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ grantPermissions: ['network:drive.example.com', 'network:auth.example.com'] }),
    });
    statuses.push(response.status);
  }
  return statuses;
}, ['io.universalflow.claude', 'io.universalflow.openai', 'io.universalflow.telegram', 'io.universalflow.video', 'io.universalflow.sheets', 'io.universalflow.youtube', 'io.universalflow.instagram', 'io.universalflow.gdrive']);
assert.deepEqual([...new Set(installed)], [201]);

step('workflows start empty');
await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Workflows' }).click();
await page.getByRole('heading', { name: 'No workflows yet' }).waitFor();
await shot('20-workflows-empty');

step('create a blank workflow and open Studio');
await page.getByRole('button', { name: 'New workflow' }).first().click();
await page.getByRole('dialog').getByLabel('Name').fill('Brief to Telegram');
await page.getByRole('button', { name: 'Create and open Studio' }).click();
await board('start').waitFor();
assert.match(await page.title(), /Brief to Telegram/);

step('drag Claude from the palette onto the floor');
const stage = page.locator('.stage');
const stageBox = await stage.boundingBox();
await page.getByRole('button', { name: 'Add Claude: Generate text' }).dragTo(stage, { targetPosition: { x: stageBox.width * 0.72, y: stageBox.height * 0.55 } });
await board('claude').waitFor();
await page.getByRole('button', { name: 'Not connected yet. Patch a cable into its In jack.' }).first().waitFor({ state: 'attached' }).catch(() => undefined);
assert.match(await board('claude').locator('.board-status').innerText(), /Not connected yet/);

step('patch the trigger into Claude with a mouse-dragged cable');
await patch(jack('start', 'out:out'), jack('claude', 'in:in'));
await page.waitForFunction(() => document.querySelector('[data-node="claude"][data-jack="in:in"]')?.hasAttribute('data-connected'));
assert.equal(await page.locator('.cable[data-kind="flow"]').count(), 1);

step('fill the prompt with data picked from the trigger');
await page.locator('[data-board-handle="claude"]').click();
const prompt = inspector.getByRole('textbox', { name: /Prompt/ });
await prompt.fill('Summarise for the team: ');
await inspector.getByRole('button', { name: 'Insert data into Prompt' }).click();
await inspector.getByRole('dialog', { name: 'Data for Prompt' }).getByRole('textbox', { name: 'Field inside Start' }).fill('text');
await inspector.getByRole('dialog', { name: 'Data for Prompt' }).getByRole('button', { name: 'Insert' }).click();
assert.equal(await prompt.inputValue(), 'Summarise for the team: {{trigger.text}}');
await page.locator('.cable[data-kind="data"]').first().waitFor({ state: 'attached' });

step('add an approval and Telegram after Claude by clicking the palette');
await page.getByRole('button', { name: 'Add User Approval' }).click();
await board('user-approval').waitFor();
await page.waitForFunction(() => document.querySelector('[data-node="user-approval"][data-jack="in:in"]')?.hasAttribute('data-connected'));
const message = inspector.getByRole('textbox', { name: /Message for the approver/ });
await message.fill('Send this summary? ');
await inspector.getByRole('button', { name: 'Insert data into Message for the approver' }).click();
await inspector.getByRole('dialog', { name: 'Data for Message for the approver' }).getByRole('button', { name: /^Text/ }).click();
assert.equal(await message.inputValue(), 'Send this summary? {{nodes.claude.output.text}}');

await page.getByRole('button', { name: 'Add Telegram: Send message' }).click();
await board('telegram').waitFor();
await inspector.getByRole('textbox', { name: /Chat id/i }).fill('team-chat');

step('patch Claude text into Telegram with a data cable');
await patch(jack('claude', 'out:text'), jack('telegram', 'in:text'));
await toast('Send message now reads Text from Generate text');
await page.locator('[data-board-handle="telegram"]').click();
assert.equal(await inspector.getByRole('textbox', { name: /^Text/ }).inputValue(), '{{nodes.claude.output.text}}');

step('wire the Rejected branch with the keyboard only');
await page.getByRole('button', { name: 'Add Telegram: Send message' }).dragTo(stage, { targetPosition: { x: stageBox.width * 0.62, y: stageBox.height * 0.86 } });
await board('telegram-2').waitFor();
await inspector.getByRole('textbox', { name: /Chat id/i }).fill('team-chat');
await inspector.getByRole('textbox', { name: /^Text/ }).fill('The summary was held back.');
await jack('user-approval', 'out:rejected').focus();
await page.keyboard.press('Enter');
await page.getByRole('status').filter({ hasText: 'Choose where' }).waitFor();
await shot('21-studio-keyboard-patch');
await jack('telegram-2', 'in:in').focus();
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('[data-node="telegram-2"][data-jack="in:in"]')?.hasAttribute('data-connected'));
assert.equal(await page.locator('.cable[data-kind="flow"]').count(), 4);

step('undo and redo the last cable');
await page.locator('[data-board-handle="telegram-2"]').focus();
await page.keyboard.press('Control+z');
await page.waitForFunction(() => !document.querySelector('[data-node="telegram-2"][data-jack="in:in"]')?.hasAttribute('data-connected'));
await page.keyboard.press('Control+Shift+z');
await page.waitForFunction(() => document.querySelector('[data-node="telegram-2"][data-jack="in:in"]')?.hasAttribute('data-connected'));

step('move a step with the arrow keys');
const before = await board('telegram-2').boundingBox();
await page.locator('[data-board-handle="telegram-2"]').focus();
for (let index = 0; index < 5; index += 1) await page.keyboard.press('ArrowRight');
const after = await board('telegram-2').boundingBox();
assert.ok(after.x > before.x + 20, 'the board moved right');

step('a loop must not be saved empty');
await page.locator('.stage').click({ position: { x: 30, y: stageBox.height - 120 } });
await page.getByRole('button', { name: 'Add Loop' }).click();
await board('loop').waitFor();
await page.getByRole('button', { name: 'Save version' }).click();
await toast('Fix the problems marked in red before saving.');
await inspector.getByRole('button', { name: /Loop.*Open the loop and add at least one step/ }).waitFor();
await page.locator('[data-board-handle="loop"]').click();
await inspector.getByRole('button', { name: 'Open the loop' }).click();
await page.getByRole('heading', { name: 'The loop is empty' }).waitFor();
assert.equal(await page.getByRole('button', { name: 'Add User Approval' }).count(), 0, 'approvals are not offered inside a loop');
await shot('22-studio-loop-body');
await page.getByRole('navigation', { name: 'Where you are' }).getByRole('button', { name: 'Workflow' }).click();
await page.locator('[data-board-handle="loop"]').click();
await page.keyboard.press('Delete');
await toast('Step removed');
await page.waitForFunction(() => !document.querySelector('.board[data-node-id="loop"]'));

step('tidy the layout and save a version');
await page.getByRole('button', { name: 'Tidy up the layout' }).click();
await page.waitForTimeout(450);
await shot('23-studio-built');
await page.getByRole('button', { name: 'Save version' }).click();
await toast('Saved as version 2.');
await page.getByRole('button', { name: 'Saved, version 2' }).waitFor();

step('run it, review the approval on the board and approve');
await page.getByRole('button', { name: 'Run', exact: true }).click();
const runDialog = page.getByRole('dialog', { name: 'Run the workflow' });
assert.deepEqual(JSON.parse(await runDialog.getByLabel('Payload').inputValue()), { text: '' });
await runDialog.getByLabel('Payload').fill('{ "text": "Kopi susu gula aren is back on the menu from Monday." }');
await runDialog.getByRole('button', { name: 'Run', exact: true }).click();
await board('user-approval').locator('.board-status', { hasText: 'Waiting for approval' }).waitFor({ timeout: 15_000 });
assert.equal(await board('claude').getAttribute('data-run'), 'ready');
await shot('24-studio-waiting');
await board('user-approval').getByRole('button', { name: 'Review' }).click();
await inspector.locator('.approval-message', { hasText: 'Send this summary? claude: Summarise for the team: Kopi susu gula aren' }).waitFor();
await inspector.getByLabel('Note (optional)').fill('Looks good');
await inspector.getByRole('button', { name: 'Approve', exact: true }).click();
await board('telegram').locator('.board-status', { hasText: 'Done' }).waitFor({ timeout: 15_000 });
await board('telegram-2').locator('.board-status', { hasText: 'Skipped' }).waitFor();
assert.ok((await page.locator('.cable[data-state="fired"]').count()) >= 3);
await page.locator('[data-board-handle="telegram"]').click();
await inspector.getByText('"messageId": "m1"').waitFor();
await shot('25-studio-run-done');
await inspector.getByRole('tab', { name: /Runs/ }).click();
await inspector.locator('.run-list .lamp', { hasText: 'Succeeded' }).first().waitFor();

step('go live');
await page.getByRole('button', { name: 'Go live' }).click();
await page.getByRole('dialog', { name: 'Live on version 2' }).waitFor();
await page.getByRole('dialog', { name: 'Live on version 2' }).getByRole('button', { name: 'Done' }).click();
await page.locator('.studio-state').getByText('Live, version 2').waitFor();

step('unsaved changes survive a reload');
await page.getByLabel('Workflow name').fill('Brief to Telegram (draft)');
await page.locator('.studio-state').getByText('Unsaved changes').waitFor();
await page.waitForTimeout(800);
await page.reload();
await page.getByText('Your unsaved changes from').waitFor();
assert.equal(await page.getByLabel('Workflow name').inputValue(), 'Brief to Telegram (draft)');
await page.getByRole('button', { name: 'Discard them' }).click();
assert.equal(await page.getByLabel('Workflow name').inputValue(), 'Brief to Telegram');

step('open the content pipeline from the specification');
await page.getByRole('link', { name: 'All workflows' }).click();
await page.getByRole('link', { name: 'Brief to Telegram' }).waitFor();
await page.getByText('Last run succeeded').waitFor();
await shot('26-workflows-list');
await page.getByRole('button', { name: 'New workflow' }).click();
await page.getByLabel('Content pipeline').check();
await page.getByText('Not in this workspace yet, so left out: Facebook.').waitFor();
await shot('27-new-workflow-dialog');
await page.getByRole('button', { name: 'Create and open Studio' }).click();
await board('incoming').waitFor();
assert.equal(await page.locator('.board').count(), 11);
await shot('28-studio-pipeline');
await page.getByRole('button', { name: 'Show all steps' }).click();
await page.waitForTimeout(450);
await shot('29-studio-pipeline-all');
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForTimeout(450);
await shot('30-studio-pipeline-top');

step('turn the camera with a right-drag');
await page.getByRole('button', { name: '3D', exact: true }).click();
await page.waitForTimeout(350);
const zoomBefore = await page.locator('.zoom-readout').innerText();
await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + 200);
await page.mouse.down({ button: 'right' });
await page.mouse.move(stageBox.x + stageBox.width / 2 - 160, stageBox.y + 260, { steps: 8 });
await page.mouse.up({ button: 'right' });
await page.mouse.wheel(0, -240);
await page.waitForTimeout(150);
assert.notEqual(await page.locator('.zoom-readout').innerText(), zoomBefore, 'scrolling zooms');
await shot('31-studio-orbit');

step('the phone layout keeps the stage usable');
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await context.storageState() });
phone.on('pageerror', (error) => consoleErrors.push(error.message));
await phone.goto(page.url());
await phone.locator('.board').first().waitFor();
const phoneStage = await phone.locator('.stage').boundingBox();
assert.ok(phoneStage.height > 400, `the stage fills the screen (${phoneStage.height}px)`);
await shot('32-studio-phone', phone);
await phone.getByRole('button', { name: 'Modules', exact: true }).click();
await phone.getByRole('heading', { name: 'Modules' }).waitFor();
await phone.getByRole('button', { name: 'Close modules' }).waitFor();
assert.ok((await phone.locator('.studio-palette').boundingBox()).width > 300, 'the module drawer opens over the stage');
await shot('33-studio-phone-modules', phone);
await phone.close();

step('dark mode');
const dark = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', storageState: await context.storageState() });
dark.on('pageerror', (error) => consoleErrors.push(error.message));
await dark.goto(page.url());
await dark.locator('.board').first().waitFor();
await dark.locator('[data-board-handle="claude"]').click();
await shot('34-studio-dark', dark);
await dark.close();

assert.deepEqual(consoleErrors, [], 'no console errors');
await browser.close();
console.log('studio e2e passed');
