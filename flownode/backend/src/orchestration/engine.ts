import { runCollaboration } from '../collaboration/collab.js';
import { BrowserConnector } from '../agents/browser-connector.js';
import { DemoConnector } from '../agents/demo-connector.js';
import { sleep, type AgentConnector, type AgentTaskKind } from '../agents/connector.js';
import type { Bus } from '../events/bus.js';
import { uid, type Store } from '../storage/store.js';
import {
  AGENTS,
  builderFor,
  type AgentId,
  type AgentRuntime,
  type AgentStatus,
  type Approval,
  type Artifact,
  type ArtifactKind,
  type Lane,
  type Run,
  type RunOptions,
  type RunStep,
  type Transfer,
} from '../types.js';
import { findRoute } from './graph.js';

export type EngineOptions = { hopMs: number };

type Ctl = {
  run: Run;
  abort: AbortController;
  paused: boolean;
  waiters: (() => void)[];
  executing: boolean;
  done: Promise<void>;
};

const isAbort = (e: unknown): boolean => (e as { name?: string })?.name === 'AbortError';
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const NODE_LABEL: Record<string, string> = {
  'claude-01': 'Claude 01', 'claude-02': 'Claude 02', 'claude-03': 'Claude 03',
  hub: 'Collaboration Hub', output: 'Final Output',
};
const label = (id: string): string => NODE_LABEL[id] ?? id.replace('builder-', 'Builder ');

export const laneFor = (kind: ArtifactKind): Lane =>
  kind === 'document' || kind === 'folder' ? 'research'
    : kind === 'code' || kind === 'dataset' ? 'technical' : 'visual';

export class Engine {
  agents: Record<AgentId, AgentRuntime>;
  private ctl: Ctl | null = null;
  private approvalWaiters = new Map<string, { resolve: (d: 'approved' | 'rejected') => void; reject: (e: unknown) => void }>();
  private demo = new DemoConnector();

  constructor(
    readonly store: Store,
    readonly bus: Bus,
    readonly opts: EngineOptions = { hopMs: Number(process.env.FLOWNODE_HOP_MS ?? 1500) },
  ) {
    this.agents = Object.fromEntries(
      AGENTS.map((a) => [a.id, { ...a, status: 'idle' as AgentStatus, task: null, since: null }]),
    ) as Record<AgentId, AgentRuntime>;
    this.store.recoverInterruptedRuns();
  }

  // ------------------------------------------------------------------ public API
  get activeRun(): Run | null {
    const r = this.ctl?.run;
    return r && ['running', 'paused', 'waiting_approval'].includes(r.status) ? r : null;
  }

  isBusy(): boolean {
    return this.activeRun !== null;
  }

  whenIdle(): Promise<void> {
    return this.ctl?.done ?? Promise.resolve();
  }

  connectorFor(agent: AgentId): AgentConnector {
    const row = this.store.getConnectorRow(agent);
    return row.mode === 'browser' ? new BrowserConnector(`sessions/${agent}`) : this.demo;
  }

  start(projectId: string, instruction: string, options: RunOptions = {}): Run {
    if (this.isBusy()) throw new Error('Workflow lain sedang berjalan. Hentikan atau tunggu hingga selesai.');
    const text = instruction.trim();
    if (!text) throw new Error('Instruksi tidak boleh kosong.');
    if (!this.store.getProject(projectId)) throw new Error('Proyek tidak ditemukan.');
    const run: Run = {
      id: uid('r_'),
      projectId,
      instruction: text,
      status: 'running',
      stage: 'input',
      options,
      steps: this.buildSteps(),
      state: { produced: {}, delivered: {}, revisions: 0 },
      startedAt: Date.now(),
    };
    this.store.saveRun(run);
    this.ctl = this.newCtl(run);
    this.launch(this.ctl);
    return run;
  }

  pause(): void {
    const c = this.ctl;
    if (!c || c.run.status !== 'running') throw new Error('Tidak ada workflow yang sedang berjalan.');
    c.paused = true;
    c.run.status = 'paused';
    this.persist(c.run);
    this.log('system', 'Workflow dijeda (berlaku setelah langkah/transfer saat ini selesai)', null, 'warn', c.run);
  }

  resume(): void {
    const c = this.ctl;
    if (!c || c.run.status !== 'paused') throw new Error('Workflow tidak sedang dijeda.');
    c.paused = false;
    c.run.status = 'running';
    this.persist(c.run);
    this.log('system', 'Workflow dilanjutkan', null, 'info', c.run);
    c.waiters.splice(0).forEach((w) => w());
  }

  stop(): void {
    const c = this.ctl;
    if (!c) throw new Error('Tidak ada workflow.');
    if (c.executing) {
      c.abort.abort();
      c.paused = false;
      c.waiters.splice(0).forEach((w) => w());
      for (const w of this.approvalWaiters.values()) w.reject(new DOMException('Dibatalkan', 'AbortError'));
    } else if (c.run.status === 'failed') {
      c.run.status = 'stopped';
      c.run.endedAt = Date.now();
      this.persist(c.run);
      this.log('system', 'Workflow dihentikan', null, 'warn', c.run);
    }
  }

  retryFailed(): void {
    const c = this.ctl;
    if (!c || c.run.status !== 'failed' || c.executing) throw new Error('Tidak ada langkah gagal untuk diulang.');
    for (const s of c.run.steps) {
      if (s.status === 'failed') { s.status = 'pending'; delete s.error; }
    }
    c.run.status = 'running';
    delete c.run.error;
    delete c.run.endedAt;
    c.abort = new AbortController();
    this.log('system', 'Mengulang langkah yang gagal', null, 'info', c.run);
    this.persist(c.run);
    this.launch(c);
  }

  decide(approvalId: string, decision: 'approved' | 'rejected', note?: string): Approval {
    const ap = this.store.getApproval(approvalId);
    if (!ap) throw new Error('Persetujuan tidak ditemukan.');
    const w = this.approvalWaiters.get(approvalId);
    if (ap.status !== 'pending' || !w) throw new Error('Persetujuan ini sudah tidak aktif.');
    ap.status = decision;
    ap.decidedAt = Date.now();
    if (note) ap.note = note;
    this.store.saveApproval(ap);
    this.approvalWaiters.delete(approvalId);
    w.resolve(decision);
    this.bus.changed();
    return ap;
  }

  // ------------------------------------------------------------------ planning
  private buildSteps(): RunStep[] {
    const s = (id: string, stage: RunStep['stage'], agent: RunStep['agent'], title: string): RunStep => ({ id, stage, agent, title, status: 'pending' });
    return [
      s('s-input', 'input', 'system', 'Membaca instruksi'),
      s('s-plan', 'processing', 'claude-01', 'Riset dan rencana proyek'),
      s('s-brief', 'processing', 'claude-01', 'Distribusi tugas ke Claude 02 dan 03'),
      s('s-collab', 'collaboration', 'all', 'Diskusi dan konsensus'),
      s('s-visual', 'building', 'claude-02', 'Produksi aset visual'),
      s('s-engineer', 'building', 'claude-03', 'Rekayasa kode dan pengujian'),
      s('s-review', 'review', 'claude-01', 'Review hasil'),
      s('s-approval', 'review', 'user', 'Persetujuan akhir pengguna'),
      s('s-finalize', 'complete', 'system', 'Menyusun Final Output'),
    ];
  }

  // ------------------------------------------------------------------ execution
  private newCtl(run: Run): Ctl {
    return { run, abort: new AbortController(), paused: false, waiters: [], executing: false, done: Promise.resolve() };
  }

  private launch(c: Ctl): void {
    c.executing = true;
    c.done = this.execute(c).finally(() => {
      c.executing = false;
      this.bus.flush();
    });
  }

  private async gate(c: Ctl): Promise<void> {
    while (c.paused) {
      await new Promise<void>((r) => c.waiters.push(r));
    }
    c.abort.signal.throwIfAborted();
  }

  private async execute(c: Ctl): Promise<void> {
    const run = c.run;
    this.log('system', `Workflow dimulai: "${run.instruction}"`, null, 'info', run);
    try {
      for (let i = 0; i < run.steps.length; i++) {
        const step = run.steps[i]!;
        if (step.status === 'done' || step.status === 'skipped') continue;
        await this.gate(c);
        step.status = 'running';
        step.startedAt = Date.now();
        run.stage = step.stage;
        this.markWorking(step);
        this.persist(run);
        try {
          await this.runStep(c, step);
          step.status = 'done';
          step.endedAt = Date.now();
          this.markIdle();
          this.persist(run);
        } catch (err) {
          if (isAbort(err)) {
            step.status = 'pending';
            throw err;
          }
          step.status = 'failed';
          step.error = msg(err);
          step.endedAt = Date.now();
          run.status = 'failed';
          run.error = `${step.title}: ${step.error}`;
          run.endedAt = Date.now();
          this.markIdle();
          if (step.agent in this.agents) this.setAgent(step.agent as AgentId, 'error', step.error);
          this.log(step.agent, `Gagal: ${step.title} — ${step.error}`, null, 'error', run);
          this.persist(run);
          return;
        }
      }
      run.status = 'completed';
      run.stage = 'complete';
      run.endedAt = Date.now();
      this.markIdle();
      this.log('system', 'Workflow selesai. Semua agen kembali IDLE.', null, 'ok', run);
      this.persist(run);
    } catch (err) {
      if (!isAbort(err)) throw err;
      run.status = 'stopped';
      run.endedAt = Date.now();
      this.markIdle();
      this.log('system', 'Workflow dihentikan oleh pengguna', null, 'warn', run);
      this.persist(run);
    }
  }

  private async runStep(c: Ctl, step: RunStep): Promise<void> {
    const run = c.run;
    const id = step.id;
    if (id === 's-input') {
      await this.say(run, 'user', 'system', run.instruction);
      this.log('user', 'Instruksi diterima', null, 'ok', run);
    } else if (id === 's-plan') {
      const [plan] = await this.produce(c, id, 'claude-01', 'plan');
      await this.deliver(c, plan!, 'claude-01', 'hub');
    } else if (id === 's-brief') {
      const plan = this.producedOf(run, 's-plan')[0]!;
      for (const to of ['claude-02', 'claude-03']) await this.deliver(c, plan, 'hub', to);
    } else if (id === 's-collab') {
      await this.collaborate(c);
    } else if (id === 's-visual') {
      for (const a of await this.produce(c, id, 'claude-02', 'visuals')) await this.deliver(c, a, 'claude-02', 'hub').then(() => this.deliver(c, a, 'hub', builderFor(a.kind)));
    } else if (id === 's-engineer') {
      for (const a of await this.produce(c, id, 'claude-03', 'engineering')) await this.deliver(c, a, 'claude-03', 'hub').then(() => this.deliver(c, a, 'hub', builderFor(a.kind)));
    } else if (id === 's-review') {
      const [rep] = await this.produce(c, id, 'claude-01', 'review');
      await this.deliver(c, rep!, 'claude-01', 'hub');
      await this.deliver(c, rep!, 'hub', builderFor(rep!.kind));
    } else if (id.startsWith('s-approval')) {
      await this.finalApproval(c, step);
    } else if (id.startsWith('s-revise')) {
      const n = run.state.revisions;
      const [notes] = await this.produce(c, id, 'claude-01', 'revision', String(n), 'revision');
      await this.deliver(c, notes!, 'claude-01', 'hub');
      await this.deliver(c, notes!, 'hub', builderFor(notes!.kind));
    } else if (id === 's-finalize') {
      const arts = this.store.listArtifacts(run.projectId).filter((a) => a.runId === run.id);
      for (const a of arts) await this.deliver(c, a, builderFor(a.kind), 'output', 'final');
      this.log('system', `Final Output berisi ${arts.length} berkas`, null, 'ok', run);
    }
  }

  private async finalApproval(c: Ctl, step: RunStep): Promise<void> {
    const run = c.run;
    const decision = await this.requestApproval(c, 'final_review', 'Persetujuan akhir', 'Periksa hasil di panel Project Output, lalu setujui atau minta revisi.');
    if (decision === 'approved') return;
    run.state.revisions += 1;
    const n = run.state.revisions;
    if (n > 2) throw new Error('Hasil ditolak dan batas revisi (2) tercapai.');
    const rejected = this.store.listApprovals(run.projectId).find((a) => a.runId === run.id && a.status === 'rejected');
    await this.say(run, 'user', 'decision', `Pengguna meminta revisi${rejected?.note ? `: ${rejected.note}` : '.'}`);
    const at = run.steps.indexOf(step);
    run.steps.splice(at + 1, 0,
      { id: `s-revise-${n}`, stage: 'review', agent: 'claude-01', title: `Revisi hasil (${n})`, status: 'pending' },
      { id: `s-approval-${n}`, stage: 'review', agent: 'user', title: `Persetujuan akhir (revisi ${n})`, status: 'pending' },
    );
  }

  private collaborate(c: Ctl): Promise<unknown> {
    const run = c.run;
    const plan = this.producedOf(run, 's-plan')[0]!;
    const maxRounds = Number(this.store.getSetting('maxRounds') ?? 3);
    const disagree = !!run.options.simulateDisagreement;
    const connectorOf = (a: AgentId) => this.connectorFor(a);
    return runCollaboration(
      {
        say: (sender, phase, text, artifactId) => this.say(run, sender, phase, text, artifactId ?? null),
        discuss: async (agent, phase, round) => {
          this.assertUsable(agent);
          return connectorOf(agent).discuss({ agent, phase, instruction: run.instruction, round, disagree }, c.abort.signal);
        },
        produceRevisionPlan: async (round) =>
          (await this.produce(c, `collab-rev-${round}`, 'claude-01', 'plan', `rev:${round}`, 'revision'))[0]!,
        deliverToHub: (a) => this.deliver(c, a, 'claude-01', 'hub', 'revision'),
        setTask: (text) => AGENTS.forEach((a) => this.setAgent(a.id, 'working', text)),
        requestDecision: (title, detail) => this.requestApproval(c, 'consensus_stalled', title, detail),
        gate: () => this.gate(c),
      },
      { maxRounds, plan },
    );
  }

  // ------------------------------------------------------------------ primitives
  private assertUsable(agent: AgentId): void {
    if (this.store.getConnectorRow(agent).takeover) {
      throw new Error(`${NODE_LABEL[agent]} sedang dalam manual takeover oleh pengguna.`);
    }
  }

  private producedOf(run: Run, key: string): Artifact[] {
    const ids = run.state.produced[key] ?? [];
    const all = this.store.listArtifacts(run.projectId);
    return ids.map((id) => all.find((a) => a.id === id)!).filter(Boolean);
  }

  private async produce(c: Ctl, key: string, agent: AgentId, kind: AgentTaskKind, context?: string, lane?: Lane): Promise<Artifact[]> {
    const run = c.run;
    if (run.state.produced[key]) return this.producedOf(run, key);
    this.assertUsable(agent);
    const connector = this.connectorFor(agent);
    const drafts = await connector.run({ agent, kind, instruction: run.instruction, ...(context ? { context } : {}) }, c.abort.signal);
    const existing = this.store.listArtifacts(run.projectId);
    const out: Artifact[] = [];
    for (const d of drafts) {
      const id = uid('a_');
      const artifact: Artifact = {
        id, projectId: run.projectId, runId: run.id, name: d.name, kind: d.kind, mime: d.mime, size: d.data.length,
        producer: agent, lane: lane ?? laneFor(d.kind), demo: connector.mode === 'demo', createdAt: Date.now(),
        version: existing.filter((e) => e.name === d.name).length + 1,
      };
      const path = this.store.writeArtifactFile(run.projectId, id, d.name, d.data);
      this.store.addArtifact(artifact, path);
      out.push(artifact);
      this.log(agent, 'Membuat file', d.name, 'ok', run);
    }
    run.state.produced[key] = out.map((a) => a.id);
    this.persist(run);
    return out;
  }

  /** Kirim artefak melalui kabel. Setiap hop = satu event transfer nyata. */
  private async deliver(c: Ctl, art: Artifact, from: string, to: string, lane?: Lane): Promise<void> {
    const run = c.run;
    const project = this.store.getProject(run.projectId)!;
    const route = findRoute(project.graph, from, to);
    if (!route) {
      const t: Transfer = {
        id: uid('t_'), projectId: run.projectId, runId: run.id, artifactId: art.id, artifactName: art.name, kind: art.kind,
        lane: lane ?? art.lane, edgeId: '', from, to, size: art.size, status: 'failed', startedAt: Date.now(),
        endedAt: Date.now(), durationMs: 0, error: `Tidak ada kabel dari ${label(from)} ke ${label(to)}`,
      };
      this.store.saveTransfer(t);
      this.log(from, `Transfer gagal: ${t.error}`, art.name, 'error', run);
      throw new Error(t.error);
    }
    for (const edge of route) {
      const key = `${art.id}:${edge.id}`;
      if (run.state.delivered[key]) continue;
      await this.gate(c);
      const t: Transfer = {
        id: uid('t_'), projectId: run.projectId, runId: run.id, artifactId: art.id, artifactName: art.name, kind: art.kind,
        lane: lane ?? art.lane, edgeId: edge.id, from: edge.source, to: edge.target, size: art.size, status: 'moving',
        startedAt: Date.now(), durationMs: this.opts.hopMs,
      };
      this.store.saveTransfer(t);
      this.log(edge.source, `Mengirim ke ${label(edge.target)}`, art.name, 'info', run);
      this.bus.changed();
      try {
        await sleep(this.opts.hopMs, c.abort.signal);
      } catch (e) {
        t.status = 'failed'; t.error = 'Dibatalkan'; t.endedAt = Date.now();
        this.store.saveTransfer(t);
        throw e;
      }
      t.status = 'done';
      t.endedAt = Date.now();
      this.store.saveTransfer(t);
      run.state.delivered[key] = true;
      this.log(edge.target, `Menerima dari ${label(edge.source)}`, art.name, 'ok', run);
      this.persist(run);
    }
  }

  private async requestApproval(c: Ctl, kind: Approval['kind'], title: string, detail: string): Promise<'approved' | 'rejected'> {
    const run = c.run;
    const ap: Approval = { id: uid('ap_'), projectId: run.projectId, runId: run.id, kind, title, detail, status: 'pending', createdAt: Date.now() };
    this.store.saveApproval(ap);
    const prev = run.status;
    run.status = 'waiting_approval';
    AGENTS.forEach((a) => this.setAgent(a.id, 'waiting', 'Menunggu persetujuan pengguna'));
    this.persist(run);
    this.log('system', `Menunggu persetujuan: ${title}`, null, 'warn', run);
    const decision = await new Promise<'approved' | 'rejected'>((resolve, reject) => {
      this.approvalWaiters.set(ap.id, { resolve, reject });
    });
    if (run.status === 'waiting_approval') run.status = c.paused ? 'paused' : prev === 'paused' ? 'running' : 'running';
    this.log('user', `${title}: ${decision === 'approved' ? 'disetujui' : 'ditolak'}`, null, decision === 'approved' ? 'ok' : 'warn', run);
    this.persist(run);
    return decision;
  }

  private async say(run: Run, sender: string, phase: import('../types.js').CollabPhase, text: string, artifactId: string | null = null): Promise<void> {
    const demo = sender in this.agents ? this.connectorFor(sender as AgentId).mode === 'demo' : false;
    this.store.addMessage({ id: uid('m_'), projectId: run.projectId, runId: run.id, ts: Date.now(), sender, phase, text, artifactId, demo });
    this.log(sender, `${phase.toUpperCase()}: ${text.slice(0, 80)}`, null, 'info', run, false);
    this.bus.changed();
  }

  // ------------------------------------------------------------------ state helpers
  private setAgent(id: AgentId, status: AgentStatus, task: string | null): void {
    const a = this.agents[id];
    if (a.status !== status) a.since = Date.now();
    a.status = status;
    a.task = task;
    this.bus.changed();
  }

  private markWorking(step: RunStep): void {
    const ids: AgentId[] = step.agent === 'all' ? AGENTS.map((a) => a.id) : step.agent in this.agents ? [step.agent as AgentId] : [];
    for (const id of ids) this.setAgent(id, 'working', step.title);
  }

  private markIdle(): void {
    for (const a of AGENTS) {
      if (this.agents[a.id].status !== 'error') this.setAgent(a.id, 'idle', null);
    }
    // agen error dibersihkan ketika workflow berikutnya dimulai atau diulang
    for (const a of AGENTS) if (this.agents[a.id].status === 'error' && this.ctl?.run.status !== 'failed') this.setAgent(a.id, 'idle', null);
  }

  private persist(run: Run): void {
    this.store.saveRun(run);
    this.bus.changed();
  }

  private log(agent: string, activity: string, file: string | null, status: 'info' | 'ok' | 'warn' | 'error', run: Run, notify = true): void {
    this.store.addActivity({ projectId: run.projectId, runId: run.id, agent, activity, file, status });
    if (notify) this.bus.changed();
  }
}
