import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from '../orchestration/engine.js';
import { makeZip } from '../storage/zip.js';
import type { Store } from '../storage/store.js';
import { AGENTS, type AgentId, type Graph } from '../types.js';
import { buildSnapshot } from './state.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const str = (v: unknown, name: string, max = 4000): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} wajib diisi.`);
  return v.trim().slice(0, max);
};
const agentId = (v: string): AgentId => {
  if (!AGENTS.some((a) => a.id === v)) throw new HttpError(404, 'Agen tidak dikenal.');
  return v as AgentId;
};

function validGraph(g: any): Graph {
  if (!g || typeof g !== 'object' || typeof g.positions !== 'object' || !Array.isArray(g.edges)) {
    throw new HttpError(400, 'Format graph tidak valid.');
  }
  const edges = g.edges.map((e: any) => ({
    id: String(e.id), source: String(e.source), sourceHandle: String(e.sourceHandle ?? 'out'),
    target: String(e.target), targetHandle: String(e.targetHandle ?? 'in'),
  }));
  const positions: Graph['positions'] = {};
  for (const [k, v] of Object.entries<any>(g.positions)) {
    if (typeof v?.x === 'number' && typeof v?.y === 'number') positions[k] = { x: v.x, y: v.y };
  }
  return { positions, edges };
}

export function createApp(store: Store, engine: Engine, staticDir?: string) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = fn(req, res);
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(next);
    } catch (e) {
      next(e);
    }
  };
  const ok = (res: Response, extra: object = {}) => res.json({ ok: true, ...extra });
  const guardIdle = () => {
    if (engine.isBusy()) throw new HttpError(409, 'Tidak bisa dilakukan saat workflow berjalan.');
  };

  app.get('/api/health', (_q, res) => res.json({ ok: true, name: 'flownode', version: '1.0.0' }));
  app.get('/api/state', wrap((_q, res) => res.json(buildSnapshot(store, engine))));

  // ---- projects
  app.post('/api/projects', wrap((req, res) => {
    guardIdle();
    const p = store.createProject(str(req.body?.name ?? 'Proyek Baru', 'name', 80));
    store.setSetting('activeProject', p.id);
    engine.bus.changed();
    ok(res, { id: p.id });
  }));
  app.post('/api/projects/:id/open', wrap((req, res) => {
    guardIdle();
    if (!store.getProject(req.params.id!)) throw new HttpError(404, 'Proyek tidak ditemukan.');
    store.setSetting('activeProject', req.params.id!);
    engine.bus.changed();
    ok(res);
  }));
  app.patch('/api/projects/:id', wrap((req, res) => {
    if (!store.getProject(req.params.id!)) throw new HttpError(404, 'Proyek tidak ditemukan.');
    store.renameProject(req.params.id!, str(req.body?.name, 'name', 80));
    engine.bus.changed();
    ok(res);
  }));
  app.delete('/api/projects/:id', wrap((req, res) => {
    guardIdle();
    store.deleteProject(req.params.id!);
    store.activeProjectId();
    engine.bus.changed();
    ok(res);
  }));
  app.put('/api/projects/:id/graph', wrap((req, res) => {
    if (!store.getProject(req.params.id!)) throw new HttpError(404, 'Proyek tidak ditemukan.');
    store.saveGraph(req.params.id!, validGraph(req.body));
    engine.bus.changed();
    ok(res);
  }));
  app.get('/api/projects/:id/export', wrap((req, res) => {
    const p = store.getProject(req.params.id!);
    if (!p) throw new HttpError(404, 'Proyek tidak ditemukan.');
    res.setHeader('Content-Disposition', `attachment; filename="${p.name.replace(/[^\w\-]+/g, '_')}.flownode.json"`);
    res.json({ flownode: 1, name: p.name, graph: p.graph, artifacts: store.listArtifacts(p.id) });
  }));
  app.post('/api/projects/import', wrap((req, res) => {
    guardIdle();
    if (req.body?.flownode !== 1) throw new HttpError(400, 'Berkas bukan proyek FLOWNODE.');
    const p = store.createProject(str(req.body.name ?? 'Proyek Impor', 'name', 80), validGraph(req.body.graph));
    store.setSetting('activeProject', p.id);
    engine.bus.changed();
    ok(res, { id: p.id });
  }));
  app.get('/api/projects/:id/bundle.zip', wrap((req, res) => {
    const p = store.getProject(req.params.id!);
    if (!p) throw new HttpError(404, 'Proyek tidak ditemukan.');
    const files = store.listArtifacts(p.id).flatMap((a) => {
      const data = store.readArtifact(a.id);
      return data ? [{ name: `v${a.version}-${a.name}`, data }] : [];
    });
    if (!files.length) throw new HttpError(404, 'Belum ada berkas.');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${p.name.replace(/[^\w\-]+/g, '_')}.zip"`);
    res.send(makeZip(files));
  }));

  // ---- workflow control
  app.post('/api/run/start', wrap((req, res) => {
    const run = engine.start(store.activeProjectId(), str(req.body?.instruction, 'instruksi'), {
      simulateDisagreement: !!req.body?.options?.simulateDisagreement,
    });
    ok(res, { runId: run.id });
  }));
  app.post('/api/run/pause', wrap((_q, res) => { engine.pause(); ok(res); }));
  app.post('/api/run/resume', wrap((_q, res) => { engine.resume(); ok(res); }));
  app.post('/api/run/stop', wrap((_q, res) => { engine.stop(); ok(res); }));
  app.post('/api/run/retry', wrap((_q, res) => { engine.retryFailed(); ok(res); }));
  app.post('/api/approvals/:id', wrap((req, res) => {
    const d = req.body?.decision;
    if (d !== 'approved' && d !== 'rejected') throw new HttpError(400, 'decision harus approved atau rejected.');
    ok(res, { approval: engine.decide(req.params.id!, d, typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined) });
  }));

  // ---- artifacts
  const sendArtifact = (disposition: 'inline' | 'attachment') => wrap((req, res) => {
    const r = store.getArtifact(req.params.id!);
    if (!r || !existsSync(r.path)) throw new HttpError(404, 'Berkas tidak ditemukan.');
    res.setHeader('Content-Type', r.artifact.mime);
    res.setHeader('Content-Disposition', `${disposition}; filename="${r.artifact.name}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Konten artefak adalah data: jangan pernah dieksekusi sebagai halaman.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    res.sendFile(r.path);
  });
  app.get('/api/artifacts/:id/raw', sendArtifact('inline'));
  app.get('/api/artifacts/:id/download', sendArtifact('attachment'));

  // ---- skills
  app.post('/api/skills', wrap((req, res) => {
    const agent = req.body?.agent === 'all' ? 'all' : agentId(String(req.body?.agent));
    ok(res, { skill: store.addSkill({ name: str(req.body?.name, 'name', 80), description: String(req.body?.description ?? '').slice(0, 300), agent, enabled: true }) });
    engine.bus.changed();
  }));
  app.patch('/api/skills/:id', wrap((req, res) => {
    const patch: Record<string, unknown> = {};
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (typeof req.body?.name === 'string') patch.name = req.body.name.slice(0, 80);
    if (typeof req.body?.description === 'string') patch.description = req.body.description.slice(0, 300);
    store.updateSkill(req.params.id!, patch);
    engine.bus.changed();
    ok(res);
  }));
  app.delete('/api/skills/:id', wrap((req, res) => { store.deleteSkill(req.params.id!); engine.bus.changed(); ok(res); }));

  // ---- agents / connectors
  app.put('/api/agents/:id/connector', wrap((req, res) => {
    guardIdle();
    const id = agentId(req.params.id!);
    const mode = req.body?.mode;
    if (mode !== 'demo' && mode !== 'browser') throw new HttpError(400, 'mode harus demo atau browser.');
    store.setConnectorRow(id, { mode });
    engine.bus.changed();
    ok(res);
  }));
  app.put('/api/agents/:id/takeover', wrap((req, res) => {
    const id = agentId(req.params.id!);
    store.setConnectorRow(id, { takeover: !!req.body?.on });
    engine.bus.changed();
    ok(res);
  }));
  app.put('/api/settings', wrap((req, res) => {
    const n = Number(req.body?.maxRounds);
    if (!Number.isInteger(n) || n < 1 || n > 6) throw new HttpError(400, 'maxRounds harus 1–6.');
    store.setSetting('maxRounds', String(n));
    engine.bus.changed();
    ok(res);
  }));

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/^(?!\/api\/|\/ws).*/, (_q, res) => res.sendFile(join(staticDir, 'index.html')));
  }

  app.use((err: unknown, _q: Request, res: Response, _n: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 400;
    res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}
