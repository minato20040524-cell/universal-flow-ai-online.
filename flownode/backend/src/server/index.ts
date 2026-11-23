import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Bus } from '../events/bus.js';
import { Engine } from '../orchestration/engine.js';
import { Store } from '../storage/store.js';
import { createApp } from './app.js';
import { buildSnapshot } from './state.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..', '..', '..');
const dataDir = process.env.FLOWNODE_DATA ?? join(backendRoot, 'data');
const staticDir = process.env.FLOWNODE_STATIC ?? resolve(backendRoot, '..', 'frontend', 'dist');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const store = new Store(dataDir);
const bus = new Bus();
const engine = new Engine(store, bus);
const app = createApp(store, engine, staticDir);
const server = createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });
const send = (ws: WebSocket) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'state', state: buildSnapshot(store, engine) }));
};
wss.on('connection', (ws) => send(ws));
bus.on('change', () => wss.clients.forEach((c) => send(c)));

server.listen(port, host, () => {
  console.log(`FLOWNODE V1 berjalan di http://${host}:${port}`);
  console.log(existsSync(staticDir) ? `Frontend: ${staticDir}` : 'Frontend belum dibangun (jalankan: npm run build).');
});

const shutdown = () => {
  wss.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
