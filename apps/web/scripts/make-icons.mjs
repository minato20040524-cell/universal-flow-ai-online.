// Renders the app icons (public/icons/*.svg) to the PNG sizes Android and the web manifest use.
// Run after changing an icon: node scripts/make-icons.mjs (needs Playwright's Chromium).
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const ICONS = [
  { source: 'icon.svg', size: 192, out: 'icon-192.png', transparent: true },
  { source: 'icon.svg', size: 512, out: 'icon-512.png', transparent: true },
  { source: 'icon-maskable.svg', size: 512, out: 'icon-maskable-512.png', transparent: false },
  { source: 'icon-maskable.svg', size: 180, out: 'apple-touch-icon.png', transparent: false },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const icon of ICONS) {
  const svg = await readFile(new URL(`../public/icons/${icon.source}`, import.meta.url), 'utf8');
  await page.setViewportSize({ width: icon.size, height: icon.size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${icon.size}px;height:${icon.size}px}</style>${svg}`);
  await page.screenshot({ path: new URL(`../public/icons/${icon.out}`, import.meta.url).pathname, omitBackground: icon.transparent });
  console.log(`public/icons/${icon.out}`);
}
await browser.close();
