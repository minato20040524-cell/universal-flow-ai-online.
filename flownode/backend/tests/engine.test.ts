process.env.FLOWNODE_TASK_MS = '5';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Bus } from '../src/events/bus.js';
import { Engine } from '../src/orchestration/engine.js';
import { defaultGraph, findRoute } from '../src/orchestration/graph.js';
import { Store } from '../src/storage/store.js';
import { makeZip } from '../src/storage/zip.js';

let dir: string;
let store: Store;
let engine: Engine;

const waitFor = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const pid = () => store.activeProjectId();
const latest = () => store.latestRun(pid())!;
const pendingApproval = () => store.listApprovals(pid()).find((a) => a.status === 'pending');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flownode-'));
  store = new Store(dir);
  engine = new Engine(store, new Bus(), { hopMs: 5 });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('graph', () => {
  it('menemukan jalur agen → hub → builder → output', () => {
    const g = defaultGraph();
    const r = findRoute(g, 'claude-02', 'output');
    assert.ok(r && r.length === 3);
    assert.deepEqual(r.map((e) => e.target), ['hub', 'builder-doc', 'output'].map((x, i) => (i === 1 ? r[1]!.target : x)));
  });
  it('mengembalikan null bila kabel terputus', () => {
    const g = defaultGraph();
    g.edges = g.edges.filter((e) => e.id !== 'e-hub-builder-image');
    assert.equal(findRoute(g, 'claude-02', 'builder-image'), null);
  });
});

describe('workflow on-demand', () => {
  it('semua agen IDLE dan tanpa run saat tidak ada perintah', () => {
    assert.equal(engine.isBusy(), false);
    assert.ok(Object.values(engine.agents).every((a) => a.status === 'idle'));
    assert.equal(store.latestRun(pid()), null);
  });

  it('menolak instruksi kosong dan run ganda', async () => {
    assert.throws(() => engine.start(pid(), '   '), /kosong/);
    engine.start(pid(), 'uji');
    assert.throws(() => engine.start(pid(), 'lagi'), /sedang berjalan/);
    engine.stop();
    await engine.whenIdle();
  });

  it('menjalankan alur penuh sampai persetujuan lalu selesai dan agen kembali IDLE', async () => {
    engine.start(pid(), 'Buat animasi stickman');
    await waitFor(() => !!pendingApproval());
    assert.equal(latest().status, 'waiting_approval');
    assert.equal(pendingApproval()!.kind, 'final_review');
    engine.decide(pendingApproval()!.id, 'approved');
    await engine.whenIdle();

    const run = latest();
    assert.equal(run.status, 'completed');
    assert.equal(run.stage, 'complete');
    assert.ok(run.steps.every((s) => s.status === 'done'));
    assert.ok(Object.values(engine.agents).every((a) => a.status === 'idle' && a.task === null));

    const arts = store.listArtifacts(pid());
    assert.ok(arts.length >= 9, `artefak: ${arts.length}`);
    assert.ok(arts.every((a) => a.demo), 'semua artefak berlabel DEMO');
    // setiap berkas yang dibuat benar-benar tiba di Final Output
    const toOutput = store.listTransfers(pid(), 500).filter((t) => t.to === 'output' && t.status === 'done');
    const baseArts = arts.filter((a) => a.runId === run.id);
    assert.equal(new Set(toOutput.map((t) => t.artifactId)).size, baseArts.length);
    assert.ok(store.listMessages(pid()).some((m) => m.phase === 'consensus'));
  });

  it('setiap transfer mengikuti kabel (hop per edge) dan tercatat selesai', async () => {
    engine.start(pid(), 'x');
    await waitFor(() => !!pendingApproval());
    const img = store.listArtifacts(pid()).find((a) => a.kind === 'image')!;
    const hops = store.listTransfers(pid(), 500).filter((t) => t.artifactId === img.id && t.status === 'done').map((t) => `${t.from}>${t.to}`);
    assert.deepEqual(new Set(hops), new Set(['claude-02>hub', 'hub>builder-image']));
    engine.stop();
    await engine.whenIdle();
  });

  it('permintaan revisi menambah langkah revisi dan persetujuan baru', async () => {
    engine.start(pid(), 'x');
    await waitFor(() => !!pendingApproval());
    engine.decide(pendingApproval()!.id, 'rejected', 'perbaiki warna');
    await waitFor(() => latest().steps.some((s) => s.id === 's-revise-1' && s.status === 'done'));
    await waitFor(() => store.listApprovals(pid()).filter((a) => a.status === 'pending').length === 1);
    assert.ok(store.listArtifacts(pid()).some((a) => a.name.startsWith('catatan-revisi-1')));
    engine.decide(pendingApproval()!.id, 'approved');
    await engine.whenIdle();
    assert.equal(latest().status, 'completed');
  });

  it('berhenti dengan gagal setelah 3 penolakan (batas revisi)', async () => {
    engine.start(pid(), 'x');
    for (let i = 0; i < 3; i++) {
      await waitFor(() => !!pendingApproval());
      engine.decide(pendingApproval()!.id, 'rejected');
      await new Promise((r) => setTimeout(r, 20));
    }
    await engine.whenIdle();
    assert.equal(latest().status, 'failed');
    assert.match(latest().error!, /batas revisi/);
  });

  it('konsensus gagal → keputusan diserahkan ke pengguna', async () => {
    engine.start(pid(), 'x', { simulateDisagreement: true });
    await waitFor(() => pendingApproval()?.kind === 'consensus_stalled');
    assert.equal(store.listMessages(pid()).filter((m) => m.phase === 'reeval').length, 6); // 3 ronde x 2 agen
    engine.decide(pendingApproval()!.id, 'approved');
    await waitFor(() => pendingApproval()?.kind === 'final_review');
    engine.stop();
    await engine.whenIdle();
    assert.equal(latest().status, 'stopped');
  });

  it('menolak keputusan konsensus menghentikan workflow sebagai gagal', async () => {
    engine.start(pid(), 'x', { simulateDisagreement: true });
    await waitFor(() => pendingApproval()?.kind === 'consensus_stalled');
    engine.decide(pendingApproval()!.id, 'rejected');
    await engine.whenIdle();
    assert.equal(latest().status, 'failed');
  });
});

describe('kabel putus, pause, stop, retry', () => {
  it('kabel terputus → transfer gagal → retry setelah kabel disambung lagi berhasil tanpa duplikasi', async () => {
    const p = store.getProject(pid())!;
    const broken = { ...p.graph, edges: p.graph.edges.filter((e) => e.id !== 'e-hub-builder-image') };
    store.saveGraph(p.id, broken);
    engine.start(pid(), 'x');
    await waitFor(() => latest().status === 'failed');
    assert.match(latest().error!, /Tidak ada kabel/);
    assert.ok(store.listTransfers(pid(), 500).some((t) => t.status === 'failed'));
    const before = store.listArtifacts(pid()).map((a) => a.name);

    store.saveGraph(p.id, p.graph); // sambungkan kembali
    engine.retryFailed();
    await waitFor(() => !!pendingApproval());
    const names = store.listArtifacts(pid()).map((a) => a.name);
    assert.equal(new Set(names).size, names.length, 'retry tidak membuat artefak ganda');
    assert.ok(before.every((n) => names.filter((x) => x === n).length === 1));
    engine.decide(pendingApproval()!.id, 'approved');
    await engine.whenIdle();
    assert.equal(latest().status, 'completed');
  });

  it('pause menahan langkah berikutnya dan resume melanjutkan', async () => {
    engine.start(pid(), 'x');
    engine.pause();
    assert.equal(latest().status, 'paused');
    await new Promise((r) => setTimeout(r, 150));
    const doneWhilePaused = latest().steps.filter((s) => s.status === 'done').length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(latest().steps.filter((s) => s.status === 'done').length, doneWhilePaused);
    engine.resume();
    await waitFor(() => !!pendingApproval());
    engine.stop();
    await engine.whenIdle();
  });

  it('stop saat menunggu persetujuan membatalkan run dan mengembalikan agen ke IDLE', async () => {
    engine.start(pid(), 'x');
    await waitFor(() => !!pendingApproval());
    engine.stop();
    await engine.whenIdle();
    assert.equal(latest().status, 'stopped');
    assert.ok(Object.values(engine.agents).every((a) => a.status === 'idle'));
  });
});

describe('connector tanpa klaim palsu', () => {
  it('mode browser menolak bekerja dan melaporkan not_connected', async () => {
    store.setConnectorRow('claude-01', { mode: 'browser' });
    assert.equal(engine.connectorFor('claude-01').status().state, 'not_connected');
    engine.start(pid(), 'x');
    await waitFor(() => latest().status === 'failed');
    assert.match(latest().error!, /belum terhubung/);
    assert.equal(engine.agents['claude-01'].status, 'error');
  });

  it('manual takeover menghentikan tugas agen tersebut', async () => {
    store.setConnectorRow('claude-01', { takeover: true });
    engine.start(pid(), 'x');
    await waitFor(() => latest().status === 'failed');
    assert.match(latest().error!, /takeover/);
  });
});

describe('penyimpanan', () => {
  it('menyimpan, mengganti nama, dan memuat proyek', () => {
    const p = store.createProject('Uji');
    store.renameProject(p.id, 'Uji 2');
    assert.equal(store.getProject(p.id)!.name, 'Uji 2');
    store.deleteProject(p.id);
    assert.equal(store.getProject(p.id), null);
  });
  it('run yang terputus karena restart ditandai berhenti', () => {
    const run = { id: 'r1', projectId: pid(), instruction: 'x', status: 'running', stage: 'building', options: {}, steps: [], state: { produced: {}, delivered: {}, revisions: 0 }, startedAt: 1 } as any;
    store.saveRun(run);
    store.recoverInterruptedRuns();
    assert.equal(store.getRun('r1')!.status, 'stopped');
  });
  it('zip valid (signature dan jumlah entri)', () => {
    const z = makeZip([{ name: 'a.txt', data: Buffer.from('halo') }, { name: 'b.txt', data: Buffer.from('dunia') }]);
    assert.equal(z.readUInt32LE(0), 0x04034b50);
    assert.equal(z.readUInt16LE(z.length - 22 + 10), 2);
  });
});
