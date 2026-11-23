const { chromium } = require('playwright');
// Uji end-to-end di browser nyata. Jalankan server lebih dulu (disarankan data sementara):
//   FLOWNODE_DATA=/tmp/fn FLOWNODE_HOP_MS=1500 FLOWNODE_TASK_MS=500 npm start
//   node tests/e2e.cjs ./tests/out        (butuh paket `playwright` + Chromium; tidak tersedia di Termux)
const fs = require('node:fs');
const SP = process.argv[2] || './tests/out';
fs.mkdirSync(SP, { recursive: true });
const BASE = process.env.FLOWNODE_URL || 'http://localhost:8787/';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE);
  await page.waitForSelector('text=Ready for Command');
  await page.waitForTimeout(800);
  ok(await page.locator('animateMotion').count() === 0, 'IDLE: tidak ada objek bergerak / animasi di kabel');
  ok(await page.locator('.cable-flow').count() === 0, 'IDLE: tidak ada arus kabel');
  await page.screenshot({ path: `${SP}/1-idle.png` });

  // ---- alur 1: normal + tolak + revisi + setujui
  await page.getByRole('button', { name: /Start Project/ }).first().click();
  await page.locator('textarea').fill('Buat animasi 3D pertarungan stickman di arena');
  await page.getByRole('button', { name: /Mulai/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('animateMotion').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(700);
  ok(await page.locator('.cable-flow').count() > 0, 'RUNNING: kabel menyala saat ada transfer nyata');
  await page.screenshot({ path: `${SP}/2-running.png` });
  await page.getByRole('button', { name: 'Pause All', exact: true }).click();
  await page.waitForSelector('text=Paused');
  ok(true, 'Pause berfungsi');
  await page.getByRole('button', { name: 'Resume', exact: true }).first().click();
  await page.waitForSelector('text=Waiting Approval', { timeout: 120000 });
  await page.getByRole('button', { name: /^Decision/ }).first().click();
  await page.getByPlaceholder('Catatan (opsional)').first().fill('perbaiki kontras warna');
  await page.getByRole('button', { name: 'Tolak / Revisi', exact: true }).first().click();
  await page.waitForFunction(() => document.body.innerText.includes('Persetujuan akhir (revisi 1)') || document.body.innerText.includes('revisi 1'), null, { timeout: 60000 }).catch(() => {});
  await page.waitForSelector('text=Waiting Approval', { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /^Decision/ }).first().click();
  await page.getByRole('button', { name: 'Setujui', exact: true }).first().click();
  await page.waitForSelector('text=Workflow selesai', { timeout: 90000 }).catch(() => {});
  await page.waitForFunction(() => document.body.innerText.includes('Project Complete'), null, { timeout: 90000 });
  ok(true, 'Selesai: donut Project Complete 100%');
  await page.waitForTimeout(800);
  const hdr = await page.locator('header').innerText();
  ok(/Ready for Command/.test(hdr), 'Setelah selesai header kembali Ready for Command');
  const idleAgents = await page.locator('aside:has(nav)').innerText();
  ok((idleAgents.match(/Idle/g) || []).length >= 3, 'Semua agen kembali Idle');
  await page.screenshot({ path: `${SP}/3-final.png` });

  // ---- alur 2: kabel putus -> gagal -> reset kabel -> retry
  const pid = await page.evaluate(async () => (await (await fetch('/api/state')).json()).project.id);
  await page.evaluate(async (pid) => {
    const st = await (await fetch('/api/state')).json();
    const g = st.project.graph; g.edges = g.edges.filter((e) => e.id !== 'e-hub-builder-image');
    await fetch(`/api/projects/${pid}/graph`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g) });
  }, pid);
  await page.getByRole('button', { name: /Start Project/ }).first().click();
  await page.locator('textarea').fill('Uji kabel putus');
  await page.getByRole('button', { name: /Mulai/ }).click();
  await page.waitForSelector('text=Workflow gagal', { timeout: 60000 });
  ok(true, 'Kabel putus: workflow gagal dengan pesan jelas');
  await page.screenshot({ path: `${SP}/4-failed.png` });
  await page.evaluate(async (pid) => { await fetch(`/api/projects/${pid}/graph/reset`, { method: 'POST' }); }, pid);
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Retry Failed', exact: true }).first().click();
  await page.waitForSelector('text=Waiting Approval', { timeout: 90000 });
  ok(true, 'Retry Failed setelah kabel disambung: lanjut sampai persetujuan');
  await page.getByRole('button', { name: 'Stop All', exact: true }).click();
  await page.waitForSelector('text=Ready for Command');
  ok(true, 'Stop All: kembali IDLE');

  // ---- halaman lain
  for (const v of ['Node Editor', 'Collaboration', 'Agent Manager', 'Skill Manager', 'Builders', 'Project Files', 'Approval Center', 'Analytics', 'Settings']) {
    await page.locator('aside:has(nav)').getByRole('button', { name: new RegExp('^' + v) }).click();
    await page.waitForTimeout(350);
    const t = await page.locator('h1').first().innerText().catch(() => '(canvas)');
    console.log('  halaman', v, '->', t.replace(/\n/g, ' '));
  }
  await page.locator('aside:has(nav)').getByRole('button', { name: /^Node Editor/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SP}/6-nodeeditor.png` });
  await page.locator('aside:has(nav)').getByRole('button', { name: /^Agent Manager/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SP}/7-agents.png` });

  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  await m.goto(BASE);
  await m.waitForSelector('text=Ready for Command');
  await m.waitForTimeout(1500);
  await m.screenshot({ path: `${SP}/5-mobile.png` });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!overflow, 'Mobile 390px: tidak ada scroll horizontal halaman');
  ok(errors.length === 0, 'Tidak ada error konsol/halaman ' + JSON.stringify(errors.slice(0, 3)));
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
