import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultGraph } from '../orchestration/graph.js';
import type {
  ActivityEntry,
  AgentId,
  Approval,
  Artifact,
  ConnectorInfo,
  ConnectorMode,
  Graph,
  Message,
  Project,
  Run,
  Skill,
  Transfer,
} from '../types.js';

export const uid = (prefix = ''): string => prefix + randomUUID().replace(/-/g, '').slice(0, 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, graph TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL, started_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, producer TEXT NOT NULL, lane TEXT NOT NULL, demo INTEGER NOT NULL, created_at INTEGER NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, run_id TEXT, ts INTEGER NOT NULL, agent TEXT NOT NULL, activity TEXT NOT NULL, file TEXT, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL, started_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, ts INTEGER NOT NULL, sender TEXT NOT NULL, phase TEXT NOT NULL, text TEXT NOT NULL, artifact_id TEXT, demo INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, agent TEXT NOT NULL, enabled INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connectors (agent TEXT PRIMARY KEY, mode TEXT NOT NULL, takeover INTEGER NOT NULL DEFAULT 0);
`;

type Row = Record<string, any>;

export class Store {
  readonly db: DatabaseSync;
  readonly filesDir: string;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filesDir = join(dataDir, 'projects');
    this.db = new DatabaseSync(join(dataDir, 'flownode.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.seed();
  }

  private seed(): void {
    if (this.listProjects().length === 0) {
      const p = this.createProject('Proyek Pertama');
      this.setSetting('activeProject', p.id);
    }
    if (!this.getSetting('maxRounds')) this.setSetting('maxRounds', '3');
    const hasSkills = this.db.prepare('SELECT COUNT(*) AS n FROM skills').get() as Row;
    if (!hasSkills.n) {
      this.addSkill({ name: 'Riset & Perencanaan', description: 'Meneliti topik, menyusun rencana dan membagi tugas.', agent: 'claude-01', enabled: true });
      this.addSkill({ name: 'Produksi Visual', description: 'Gambar, karakter, model 3D, audio, dan aset video.', agent: 'claude-02', enabled: true });
      this.addSkill({ name: 'Rekayasa Perangkat Lunak', description: 'Kode, debugging, pengujian, dan build.', agent: 'claude-03', enabled: true });
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- settings
  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- projects
  private rowToProject(r: Row): Project {
    return { id: r.id, name: r.name, graph: JSON.parse(r.graph), createdAt: r.created_at, updatedAt: r.updated_at };
  }
  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Row[]).map((r) => this.rowToProject(r));
  }
  getProject(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToProject(r) : null;
  }
  createProject(name: string, graph?: Graph): Project {
    const id = uid('p_');
    const t = Date.now();
    this.db.prepare('INSERT INTO projects(id,name,graph,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, name, JSON.stringify(graph ?? defaultGraph()), t, t);
    return this.getProject(id)!;
  }
  renameProject(id: string, name: string): void {
    this.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
  }
  saveGraph(id: string, graph: Graph): void {
    this.db.prepare('UPDATE projects SET graph = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(graph), Date.now(), id);
  }
  deleteProject(id: string): void {
    for (const t of ['runs', 'artifacts', 'activity', 'transfers', 'messages', 'approvals']) {
      this.db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
    }
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    rmSync(join(this.filesDir, id), { recursive: true, force: true });
  }
  activeProjectId(): string {
    const id = this.getSetting('activeProject');
    if (id && this.getProject(id)) return id;
    const first = this.listProjects()[0] ?? this.createProject('Proyek Pertama');
    this.setSetting('activeProject', first.id);
    return first.id;
  }

  // ---- runs
  saveRun(run: Run): void {
    this.db
      .prepare('INSERT INTO runs(id,project_id,data,started_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(run.id, run.projectId, JSON.stringify(run), run.startedAt);
  }
  getRun(id: string): Run | null {
    const r = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  latestRun(projectId: string): Run | null {
    const r = this.db.prepare('SELECT data FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 1').get(projectId) as Row | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  /** Run yang masih "berjalan" saat server mati tidak bisa dilanjutkan: tandai berhenti. */
  recoverInterruptedRuns(): void {
    const rows = this.db.prepare('SELECT data FROM runs').all() as Row[];
    for (const r of rows) {
      const run = JSON.parse(r.data) as Run;
      if (['running', 'paused', 'waiting_approval'].includes(run.status)) {
        run.status = 'stopped';
        run.error = 'Server dimulai ulang saat workflow berjalan.';
        run.endedAt = Date.now();
        for (const s of run.steps) if (s.status === 'running') s.status = 'pending';
        this.saveRun(run);
      }
    }
  }

  // ---- artifacts
  writeArtifactFile(projectId: string, id: string, name: string, data: Buffer): string {
    const safe = name.replace(/[^\w.\-]+/g, '_');
    const path = join(this.filesDir, projectId, 'files', `${id}-${safe}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    return path;
  }
  addArtifact(a: Artifact, path: string): void {
    this.db
      .prepare('INSERT INTO artifacts(id,project_id,run_id,name,kind,mime,size,path,producer,lane,demo,created_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.projectId, a.runId, a.name, a.kind, a.mime, a.size, path, a.producer, a.lane, a.demo ? 1 : 0, a.createdAt, a.version);
  }
  private rowToArtifact(r: Row): Artifact {
    return {
      id: r.id, projectId: r.project_id, runId: r.run_id, name: r.name, kind: r.kind, mime: r.mime, size: r.size,
      producer: r.producer, lane: r.lane, demo: !!r.demo, createdAt: r.created_at, version: r.version,
    };
  }
  listArtifacts(projectId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as Row[]).map((r) => this.rowToArtifact(r));
  }
  getArtifact(id: string): { artifact: Artifact; path: string } | null {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    return r ? { artifact: this.rowToArtifact(r), path: r.path } : null;
  }
  readArtifact(id: string): Buffer | null {
    const a = this.getArtifact(id);
    return a && existsSync(a.path) ? readFileSync(a.path) : null;
  }

  // ---- activity
  addActivity(e: Omit<ActivityEntry, 'id' | 'ts'> & { ts?: number }): void {
    this.db
      .prepare('INSERT INTO activity(project_id,run_id,ts,agent,activity,file,status) VALUES(?,?,?,?,?,?,?)')
      .run(e.projectId, e.runId, e.ts ?? Date.now(), e.agent, e.activity, e.file, e.status);
  }
  listActivity(projectId: string, limit = 120): ActivityEntry[] {
    const rows = this.db.prepare('SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as Row[];
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, runId: r.run_id, ts: r.ts, agent: r.agent, activity: r.activity, file: r.file, status: r.status }));
  }

  // ---- transfers
  saveTransfer(t: Transfer): void {
    this.db
      .prepare('INSERT INTO transfers(id,project_id,run_id,data,started_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(t.id, t.projectId, t.runId, JSON.stringify(t), t.startedAt);
  }
  listTransfers(projectId: string, limit = 80): Transfer[] {
    const rows = this.db.prepare('SELECT data FROM transfers WHERE project_id = ? ORDER BY started_at DESC LIMIT ?').all(projectId, limit) as Row[];
    return rows.map((r) => JSON.parse(r.data));
  }

  // ---- messages
  addMessage(m: Message): void {
    this.db
      .prepare('INSERT INTO messages(id,project_id,run_id,ts,sender,phase,text,artifact_id,demo) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(m.id, m.projectId, m.runId, m.ts, m.sender, m.phase, m.text, m.artifactId, m.demo ? 1 : 0);
  }
  listMessages(projectId: string, limit = 150): Message[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(projectId, limit) as Row[];
    return rows
      .map((r) => ({ id: r.id, projectId: r.project_id, runId: r.run_id, ts: r.ts, sender: r.sender, phase: r.phase, text: r.text, artifactId: r.artifact_id, demo: !!r.demo }) as Message)
      .reverse();
  }

  // ---- approvals
  saveApproval(a: Approval): void {
    this.db
      .prepare('INSERT INTO approvals(id,project_id,run_id,data,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(a.id, a.projectId, a.runId, JSON.stringify(a), a.createdAt);
  }
  getApproval(id: string): Approval | null {
    const r = this.db.prepare('SELECT data FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  listApprovals(projectId: string): Approval[] {
    const rows = this.db.prepare('SELECT data FROM approvals WHERE project_id = ? ORDER BY created_at DESC LIMIT 50').all(projectId) as Row[];
    return rows.map((r) => JSON.parse(r.data));
  }

  // ---- skills
  listSkills(): Skill[] {
    return (this.db.prepare('SELECT * FROM skills ORDER BY rowid').all() as Row[]).map((r) => ({ id: r.id, name: r.name, description: r.description, agent: r.agent, enabled: !!r.enabled }));
  }
  addSkill(s: Omit<Skill, 'id'>): Skill {
    const id = uid('s_');
    this.db.prepare('INSERT INTO skills(id,name,description,agent,enabled) VALUES(?,?,?,?,?)').run(id, s.name, s.description, s.agent, s.enabled ? 1 : 0);
    return { id, ...s };
  }
  updateSkill(id: string, patch: Partial<Omit<Skill, 'id'>>): void {
    const cur = this.listSkills().find((s) => s.id === id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE skills SET name=?, description=?, agent=?, enabled=? WHERE id=?').run(n.name, n.description, n.agent, n.enabled ? 1 : 0, id);
  }
  deleteSkill(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }

  // ---- connectors
  getConnectorRow(agent: AgentId): { mode: ConnectorMode; takeover: boolean } {
    const r = this.db.prepare('SELECT mode, takeover FROM connectors WHERE agent = ?').get(agent) as Row | undefined;
    return r ? { mode: r.mode, takeover: !!r.takeover } : { mode: 'demo', takeover: false };
  }
  setConnectorRow(agent: AgentId, patch: { mode?: ConnectorMode; takeover?: boolean }): void {
    const cur = this.getConnectorRow(agent);
    const n = { ...cur, ...patch };
    this.db
      .prepare('INSERT INTO connectors(agent,mode,takeover) VALUES(?,?,?) ON CONFLICT(agent) DO UPDATE SET mode = excluded.mode, takeover = excluded.takeover')
      .run(agent, n.mode, n.takeover ? 1 : 0);
  }
  connectorInfoStub(agent: AgentId): Pick<ConnectorInfo, 'agent' | 'mode' | 'takeover' | 'profileDir'> {
    const r = this.getConnectorRow(agent);
    return { agent, mode: r.mode, takeover: r.takeover, profileDir: `sessions/${agent}` };
  }
}
