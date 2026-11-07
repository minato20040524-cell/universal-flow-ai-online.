// Bundles the web app into dist/: hashed JS and CSS under dist/assets and an index.html that loads them.
import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const watch = process.argv.includes('--watch');
const production = !watch;
const outdir = 'dist';

const writeIndex = async (metafile) => {
  const outputs = Object.keys(metafile.outputs);
  const script = outputs.find((file) => file.endsWith('.js'));
  const style = outputs.find((file) => file.endsWith('.css'));
  if (!script || !style) throw new Error('Build produced no JS or CSS');
  const template = await readFile('index.html', 'utf8');
  const html = template
    .replace('<!-- styles -->', `<link rel="stylesheet" href="/assets/${basename(style)}">`)
    .replace('<!-- scripts -->', `<script type="module" src="/assets/${basename(script)}"></script>`);
  await writeFile(`${outdir}/index.html`, html);
  // Icons, manifest and the offline page go to the root of dist as they are.
  await cp('public', outdir, { recursive: true });
  await writeServiceWorker([`/assets/${basename(script)}`, `/assets/${basename(style)}`]);
};

/** The service worker carries this build's file names, so an update replaces the cached app. */
const writeServiceWorker = async (assets) => {
  const precache = ['/offline.html', '/offline.css', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', ...assets];
  const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
  const source = await readFile('src/sw-source.js', 'utf8');
  await writeFile(`${outdir}/sw.js`, source.replaceAll('__VERSION__', version).replaceAll('__PRECACHE__', JSON.stringify(precache)));
};

const options = {
  entryPoints: { app: 'src/main.tsx' },
  bundle: true,
  outdir: `${outdir}/assets`,
  entryNames: '[name]-[hash]',
  format: 'esm',
  target: ['es2022', 'chrome110', 'firefox115', 'safari16'],
  jsx: 'automatic',
  minify: production,
  sourcemap: true,
  metafile: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
  logLevel: 'info',
  plugins: [{ name: 'index-html', setup: (builder) => builder.onEnd(async (result) => result.metafile && (await writeIndex(result.metafile))) }],
};

await rm(outdir, { recursive: true, force: true });
await mkdir(`${outdir}/assets`, { recursive: true });
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
