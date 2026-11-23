import type { Engine } from '../orchestration/engine.js';
import type { Store } from '../storage/store.js';
import { AGENTS } from '../types.js';

/** Snapshot lengkap yang disiarkan ke browser. Semua nilai berasal dari state nyata. */
export function buildSnapshot(store: Store, engine: Engine) {
  const projectId = store.activeProjectId();
  const project = store.getProject(projectId)!;
  const run = store.latestRun(projectId);
  const artifacts = store.listArtifacts(projectId);
  const skills = store.listSkills();

  const connectors = AGENTS.map((a) => {
    const stub = store.connectorInfoStub(a.id);
    const st = engine.connectorFor(a.id).status();
    return { ...stub, state: st.state, note: st.note };
  });

  const agents = AGENTS.map((a) => {
    const rt = engine.agents[a.id];
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      color: a.color,
      status: rt.status,
      task: rt.task,
      since: rt.since,
      connector: connectors.find((c) => c.agent === a.id)!,
      skills: skills.filter((s) => s.agent === a.id || s.agent === 'all'),
    };
  });

  const now = Date.now();
  const durationMs = run ? (run.endedAt ?? now) - run.startedAt : 0;
  const runArtifacts = run ? artifacts.filter((a) => a.runId === run.id) : artifacts;
  const stats = {
    activeAgents: agents.filter((a) => a.status === 'working').length,
    files: runArtifacts.length,
    totalBytes: runArtifacts.reduce((n, a) => n + a.size, 0),
    durationMs: engine.activeRun || run ? durationMs : 0,
    tasksDone: run ? run.steps.filter((s) => s.status === 'done').length : 0,
    tasksTotal: run ? run.steps.length : 0,
  };

  return {
    serverTime: now,
    mode: 'on-demand' as const,
    busy: engine.isBusy(),
    project,
    projects: store.listProjects().map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt })),
    run,
    agents,
    artifacts,
    transfers: store.listTransfers(projectId),
    activity: store.listActivity(projectId),
    messages: store.listMessages(projectId),
    approvals: store.listApprovals(projectId),
    skills,
    connectors,
    stats,
    settings: { maxRounds: Number(store.getSetting('maxRounds') ?? 3), hopMs: engine.opts.hopMs },
  };
}

export type Snapshot = ReturnType<typeof buildSnapshot>;
